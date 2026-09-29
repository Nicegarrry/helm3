import { readFileSync } from 'node:fs';
import type { GitHub, Store, ToolOutcome, WorkerRow, Workspace } from './types.js';
import { retryInput } from './types.js';
import type { Settings } from './settings.js';
import type { z } from 'zod';

export type RetryInput = z.infer<typeof retryInput>;
export type RetryKind = NonNullable<RetryInput['kind']>;
export type RetryService = Readonly<{ retry(input: RetryInput, steer: (workerId: string, message: string) => Promise<ToolOutcome<{ turn: number; warning?: string }>>): Promise<ToolOutcome<{ turn: number; kind: RetryKind; message: string }>> }>;

const KINDS: RetryKind[] = ['gate', 'acceptance', 'claims', 'review', 'tests_edited', 'conflict'];
const tail = (path: string) => { try { return readFileSync(path, 'utf8').split(/\r?\n/).slice(-40).join('\n'); } catch { return `(log unavailable: ${path})`; } };
const commentId = (url: string) => Number((url.match(/(?:issuecomment-|\/comments\/)(\d+)/) ?? url.match(/(\d+)$/))?.[1]);
const refusal = (reason: string): ToolOutcome<never> => ({ ok: false, reason });

export function createRetry({ store, settings, github, workspace }: { store: Store; settings: Settings; github: GitHub; workspace?: Pick<Workspace, 'head'> }): RetryService {
  store.sql.exec('CREATE TABLE IF NOT EXISTS retries (workerId TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY(workerId, kind, n))');
  const currentHead = async (worker: WorkerRow): Promise<string> => {
    if (workspace) {
      try { return await workspace.head(worker.worktree); } catch { /* use the last durable observation */ }
    }
    return worker.head ?? '';
  };
  const latest = (workerId: string, kind: RetryKind, head: string): { at: string; evidence: string } | undefined => {
    if (kind === 'gate' || kind === 'acceptance') {
      const gates = store.listGates(workerId).filter((g) => g.head === head).sort((a, b) => b.at.localeCompare(a.at));
      const gate = gates[0];
      if (!gate || gate.passed) return undefined;
      const rows = gate.checks.filter((c) => c.exitCode !== 0 && (kind === 'gate' || c.name === 'acceptance')).map((c) => ({ at: gate.at, evidence: `${c.name}\n${tail(c.outputPath)}` }));
      return rows.length ? { at: gate.at, evidence: rows.map((row) => row.evidence).join('\n') } : undefined;
    }
    if (kind === 'claims') {
      let row: { detail?: string; at?: string; passed?: number } | undefined;
      try { row = store.sql.prepare('SELECT detail, at, passed FROM claims_checks WHERE workerId = ? AND head = ? ORDER BY at DESC LIMIT 1').get(workerId, head) as typeof row; } catch { return undefined; }
      if (!row || row.passed) return undefined;
      const detail = JSON.parse(row.detail ?? '{}') as { failedClaims?: string[]; answers?: Record<string, { choice?: string; supports?: number }> };
      const claims = (detail.failedClaims ?? []).map((claim) => `${claim} — ${detail.answers?.[claim]?.choice ?? 'unknown'} (p(supports)=${detail.answers?.[claim]?.supports ?? 0})`).join('\n');
      return { at: row.at ?? '', evidence: claims || JSON.stringify(detail) };
    }
    if (kind === 'review') {
      let row: { commentUrl?: string; at?: string; verdict?: string } | undefined;
      try { row = store.sql.prepare("SELECT r.commentUrl, r.at, r.verdict FROM reviews r JOIN prs p ON p.repoSlug = r.repoSlug AND p.number = r.number WHERE p.workerId = ? AND r.head = ? ORDER BY r.at DESC LIMIT 1").get(workerId, head) as typeof row; } catch { return undefined; }
      if (!row?.commentUrl || !['changes', 'disputed'].includes(row.verdict ?? '')) return undefined;
      return { at: row.at ?? '', evidence: '' + row.commentUrl };
    }
    const events = store.listEvents(workerId, { limit: 1_000_000 }).filter((e) => {
      const text = JSON.stringify(e.data);
      return (e.data.head === head) && (e.kind === 'conflict' && kind === 'conflict' || e.kind === 'tool.refused' && e.data.tool === 'pr.open' && ((kind === 'tests_edited' && /baseline tests edited|test files edited/i.test(text)) || (kind === 'conflict' && /conflict|unmerged/i.test(text))));
    });
    const event = events.at(-1);
    if (!event) return undefined;
    const files = event.data.files ?? event.data.reason ?? event.data.summary ?? 'unknown';
    return { at: event.at, evidence: Array.isArray(files) ? files.join(', ') : String(files) };
  };
  return { retry: async (input, steer) => {
    const worker = store.getWorker(input.workerId);
    if (!worker) return refusal('worker not found');
    if (worker.state === 'running' || worker.state === 'queued') return refusal(`worker is ${worker.state}, not retryable`);
    const head = await currentHead(worker);
    const current = KINDS.map((kind) => ({ kind, failure: latest(input.workerId, kind, head) })).filter((x): x is { kind: RetryKind; failure: NonNullable<ReturnType<typeof latest>> } => Boolean(x.failure));
    const chosen = input.kind ?? current.sort((a, b) => b.failure.at.localeCompare(a.failure.at))[0]?.kind;
    if (!chosen) return refusal(input.kind ? `no current ${input.kind} failure at ${head}` : `no current failure at ${head}`);
    const failure = current.find((item) => item.kind === chosen)?.failure;
    if (!failure) return refusal(`no current ${chosen} failure at ${head}`);
    const count = Number((store.sql.prepare('SELECT COUNT(*) AS n FROM retries WHERE workerId = ? AND kind = ?').get(input.workerId, chosen) as { n: number }).n);
    if (count >= settings.factory.retryMax) return refusal(`retry limit reached for ${chosen}: respawn or ask Nick`);
    const evidence = chosen === 'review' ? await github.comment(worker.repoSlug, commentId(failure.evidence)).then((c) => c.body.slice(0, 6000)) : failure.evidence;
    const baseline = store.getMeta(input.workerId)?.baselineId ? store.sql.prepare('SELECT files FROM baselines WHERE id = ?').get(store.getMeta(input.workerId)!.baselineId) as { files?: string } | undefined : undefined;
    const noEdit = baseline?.files ? ` Do not edit ${JSON.parse(baseline.files).join(', ')}.` : '';
    const conflictInstructions = chosen === 'conflict' ? ' A merge is IN PROGRESS in your worktree. Resolve the markers in place and commit; do NOT run `git merge --abort`, reset, or rebase.' : '';
    const message = `Your last turn was rejected: ${chosen}. ${evidence}. Fix exactly this.${conflictInstructions}${noEdit}`;
    const outcome = await steer(input.workerId, message);
    if (!outcome.ok) return outcome;
    store.sql.prepare('INSERT INTO retries (workerId, kind, n, at) VALUES (?, ?, ?, ?)').run(input.workerId, chosen, count + 1, new Date().toISOString());
    return { ok: true, turn: outcome.turn, kind: chosen, message };
  } };
}
