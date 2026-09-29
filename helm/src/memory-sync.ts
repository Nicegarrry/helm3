import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Settings } from './settings.js';
import type { Store } from './types.js';

type McpClient = Pick<Client, 'connect' | 'callTool' | 'close'>;
type ClientHandle = { client: McpClient; transport?: unknown; connect?: () => Promise<void>; close?: () => Promise<void> };
type ClientFactory = (url: string, key: string) => ClientHandle | Promise<ClientHandle>;
type OutboxRow = { id: number; op: 'write' | 'log'; path: string; args: string };

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

export function createMemorySync(options: { store: Store; settings: Pick<Settings, 'memory'>; env?: NodeJS.ProcessEnv; clientFactory?: ClientFactory }): () => Promise<void> {
  const env = options.env ?? process.env;
  const makeClient: ClientFactory = options.clientFactory ?? ((url, key) => {
    const client = new Client({ name: 'helm-memory-sync', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
    return { client, transport };
  });
  const event = (kind: string, data: Record<string, unknown>) => options.store.appendEvent('memory:sync', kind, data);

  return async () => {
    const cg = options.settings.memory.cg;
    if (!cg?.enabled) return;
    const key = env[cg.keyEnv];
    if (!key) { event('memory.cg.missing_key', { reason: 'Common Ground key is not configured' }); return; }
    const rows = options.store.sql.prepare('SELECT id, op, path, args FROM memory_outbox WHERE syncedAt IS NULL ORDER BY createdAt ASC, id ASC').all() as OutboxRow[];
    if (!rows.length) return;
    let handle: ClientHandle | undefined;
    try {
      handle = await makeClient(cg.url, key);
      if (handle.connect) await handle.connect();
      else await handle.client.connect(handle.transport as Parameters<McpClient['connect']>[0]);
      for (const row of rows) {
        const args = JSON.parse(row.args) as Record<string, unknown>;
        let result = await handle.client.callTool({ name: row.op === 'log' ? 'cg_log' : 'cg_write', arguments: args });
        let kind = classifyToolResult(result);
        if (kind === 'conflict' && row.op === 'write' && args.type === 'scorecard') {
          const read = await handle.client.callTool({ name: 'cg_read', arguments: { path: row.path } });
          const expectedSha = readPageSha(read);
          if (!expectedSha) { options.store.sql.prepare("UPDATE memory_outbox SET error = 'conflict' WHERE id = ?").run(row.id); continue; }
          result = await handle.client.callTool({ name: 'cg_write', arguments: { ...args, expectedSha } }); kind = classifyToolResult(result);
        }
        if (kind === 'ok' || kind === 'duplicate') {
          options.store.sql.prepare('UPDATE memory_outbox SET syncedAt = ?, error = ? WHERE id = ?').run(new Date().toISOString(), kind === 'duplicate' ? 'duplicate' : null, row.id);
          if (kind === 'duplicate') event('memory.duplicate', { id: row.id, path: row.path });
          continue;
        }
        if (kind === 'conflict') { options.store.sql.prepare("UPDATE memory_outbox SET error = 'conflict' WHERE id = ?").run(row.id); event('memory.conflict', { id: row.id, path: row.path }); continue; }
        options.store.sql.prepare('UPDATE memory_outbox SET error = ? WHERE id = ?').run(toolFailureReason(result, key), row.id);
        break;
      }
    } catch (error) {
      event('memory.cg.error', { reason: redact(error, key) });
    } finally {
      try { if (handle?.close) await handle.close(); else await handle?.client.close(); } catch (error) { event('memory.cg.error', { reason: redact(error, key) }); }
    }
  };
}
