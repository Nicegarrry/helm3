import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Settings } from './settings.js';
import type { Store } from './types.js';

type McpClient = Pick<Client, 'connect' | 'callTool' | 'close'>;
type ClientHandle = { client: McpClient; transport?: unknown; connect?: () => Promise<void>; close?: () => Promise<void> };
type ClientFactory = (url: string, key: string) => ClientHandle | Promise<ClientHandle>;
type OutboxRow = { id: number; op: 'write' | 'log'; path: string; args: string; error: string | null };
type SyncOptions = { store: Store; settings: Pick<Settings, 'memory'>; env?: NodeJS.ProcessEnv; clientFactory?: ClientFactory; now?: () => Date };

function redact(value: unknown, key: string): string {
  const text = value instanceof Error ? value.message : String(value);
  return key ? text.split(key).join('[redacted]') : text;
}

function decodeToolResult(result: any): Record<string, unknown> {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = (result?.content ?? []).filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n');
  try { const parsed = JSON.parse(text); return parsed && typeof parsed === 'object' ? parsed : { text }; } catch { return { text }; }
}

function classifyToolResult(result: any): 'conflict' | 'duplicate' | 'failure' | 'ok' {
  const data = decodeToolResult(result); const fields = [data.status, data.error, data.code, data.reason, data.message].filter((value): value is string => typeof value === 'string');
  const refusalText = fields.join(' ').toLowerCase();
  if (data.conflict === true || (data.ok !== true && /\bconflict\b/.test(refusalText) && !/^no conflict\b/.test(refusalText))) return 'conflict';
  if (data.duplicate === true || (data.ok !== true && /^(?:near[-_ ]duplicate|duplicate|duplicate refusal|already exists)\b/.test(refusalText)) || (result?.isError === true && /near[-_ ]duplicate/.test(refusalText))) return 'duplicate';
  if (result?.isError === true || data.ok === false || data.error) return 'failure';
  return 'ok';
}

function toolFailureReason(result: any, key: string): string {
  const data = decodeToolResult(result); return redact(data.reason ?? data.error ?? data.message ?? 'Common Ground tool failed', key);
}

function readPageSha(result: any): string | undefined {
  const data = decodeToolResult(result); const value = data.sha ?? data.contentSha ?? (data.page as Record<string, unknown> | undefined)?.sha;
  return typeof value === 'string' && value ? value : undefined;
}

function renderLogEntry(date: string, entry: string): string {
  const lines = entry.split(/\r\n?|\n/); return [`- ${date}: ${lines[0]}`, ...lines.slice(1).map((line) => `  ${line}`)].join('\n');
}

function pageContainsEntry(result: any, renderedEntry: string): boolean {
  const data = decodeToolResult(result); const markdown = data.markdown;
  if (typeof markdown !== 'string') return false;
  const lines = markdown.split(/\r\n?|\n/); const frontmatterEnd = lines.indexOf('---', 1);
  if (frontmatterEnd < 0) return false;
  const timelineStart = lines.findIndex((line, index) => index > frontmatterEnd && line === '---');
  if (timelineStart < 0) return false;
  const entryLines = renderedEntry.split('\n'); const timeline = lines.slice(timelineStart + 1);
  return timeline.some((line, index) => entryLines.every((entryLine, offset) => timeline[index + offset] === entryLine));
}

export function createMemorySync(options: SyncOptions): () => Promise<void> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  let keyPresent: boolean | undefined;
  let failureCount = 0;
  let retryAt = 0;
  let failureReported = false;
  const makeClient: ClientFactory = options.clientFactory ?? ((url, key) => {
    const client = new Client({ name: 'helm-memory-sync', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
    return { client, transport };
  });
  const event = (kind: string, data: Record<string, unknown>) => options.store.appendEvent('memory:sync', kind, data);
  const resetFailure = () => { failureCount = 0; retryAt = 0; failureReported = false; };
  const transportFailure = (error: unknown, key: string) => {
    failureCount += 1; retryAt = now().getTime() + Math.min(300_000, 1_000 * (2 ** (failureCount - 1)));
    if (!failureReported) { failureReported = true; event('memory.cg.error', { reason: redact(error, key) }); }
  };
  const parked = (row: OutboxRow, error: 'blocked' | 'conflict' | 'duplicate') => {
    options.store.sql.prepare('UPDATE memory_outbox SET syncedAt = ?, error = ? WHERE id = ?').run(now().toISOString(), error, row.id);
  };

  return async () => {
    const cg = options.settings.memory.cg;
    if (!cg?.enabled) return;
    const key = env[cg.keyEnv];
    const present = Boolean(key);
    if (keyPresent !== present) {
      keyPresent = present;
      if (!present) event('memory.cg.missing_key', { reason: 'Common Ground key is not configured' });
      else resetFailure();
    }
    if (!key) return;
    if (now().getTime() < retryAt) return;
    const rows = options.store.sql.prepare('SELECT id, op, path, args, error FROM memory_outbox WHERE syncedAt IS NULL ORDER BY createdAt ASC, id ASC').all() as OutboxRow[];
    if (!rows.length) return;
    let handle: ClientHandle | undefined;
    let batchSucceeded = true;
    try {
      handle = await makeClient(cg.url, key);
      if (handle.connect) await handle.connect();
      else await handle.client.connect(handle.transport as Parameters<McpClient['connect']>[0]);
      for (const row of rows) {
        const args = JSON.parse(row.args) as Record<string, unknown>;
        if (row.op === 'log') {
          const date = typeof args.date === 'string' && args.date ? args.date : now().toISOString().slice(0, 10);
          if (args.date !== date) {
            args.date = date;
            options.store.sql.prepare('UPDATE memory_outbox SET args = ? WHERE id = ?').run(JSON.stringify(args), row.id);
          }
          const renderedEntry = typeof args.entry === 'string' ? renderLogEntry(date, args.entry) : '';
          const precedingConflict = options.store.sql.prepare('SELECT 1 AS found FROM memory_outbox WHERE op = \'write\' AND path = ? AND id < ? AND error = \'conflict\' LIMIT 1').get(row.path, row.id) as { found: number } | undefined;
          if (precedingConflict) { parked(row, 'blocked'); event('memory.blocked', { id: row.id, path: row.path }); continue; }
          if (row.error === 'inflight') {
            const read = await handle.client.callTool({ name: 'cg_read', arguments: { path: row.path } });
            if (classifyToolResult(read) !== 'ok') {
              const failure = toolFailureReason(read, key);
              transportFailure(failure, key);
              batchSucceeded = false;
              break;
            }
            if (renderedEntry && pageContainsEntry(read, renderedEntry)) {
              options.store.sql.prepare('UPDATE memory_outbox SET syncedAt = ?, error = NULL WHERE id = ?').run(now().toISOString(), row.id);
              resetFailure();
              continue;
            }
          }
          options.store.sql.prepare('UPDATE memory_outbox SET error = \'inflight\' WHERE id = ?').run(row.id);
        }
        let result = await handle.client.callTool({ name: row.op === 'log' ? 'cg_log' : 'cg_write', arguments: args });
        let kind = classifyToolResult(result);
        if (kind === 'conflict' && row.op === 'write' && args.type === 'scorecard') {
          const read = await handle.client.callTool({ name: 'cg_read', arguments: { path: row.path } });
          const expectedSha = readPageSha(read);
          if (!expectedSha) { parked(row, 'conflict'); event('memory.conflict', { id: row.id, path: row.path }); resetFailure(); continue; }
          result = await handle.client.callTool({ name: 'cg_write', arguments: { ...args, expectedSha } }); kind = classifyToolResult(result);
        }
        if (kind === 'ok' || kind === 'duplicate') {
          if (kind === 'duplicate') { parked(row, 'duplicate'); event('memory.duplicate', { id: row.id, path: row.path }); }
          else { options.store.sql.prepare('UPDATE memory_outbox SET syncedAt = ?, error = NULL WHERE id = ?').run(now().toISOString(), row.id); }
          resetFailure();
          continue;
        }
        if (kind === 'conflict') { parked(row, 'conflict'); event('memory.conflict', { id: row.id, path: row.path }); resetFailure(); continue; }
        const failure = toolFailureReason(result, key);
        options.store.sql.prepare('UPDATE memory_outbox SET error = ? WHERE id = ?').run(failure, row.id);
        transportFailure(failure, key);
        batchSucceeded = false;
        break;
      }
    } catch (error) {
      batchSucceeded = false;
      transportFailure(error, key);
    } finally {
      try { if (handle?.close) await handle.close(); else await handle?.client.close(); } catch (error) {
        if (batchSucceeded) console.debug('Common Ground client close failed after successful memory sync batch');
        else transportFailure(error, key);
      }
    }
  };
}
