import { readFileSync } from 'node:fs';
import type { GitHub, Store, ToolOutcome, WorkerRow } from './types.js';
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

export function createRetry({ store, settings, github }: { store: Store; settings: Settings; github: GitHub }): RetryService {
  store.sql.exec('CREATE TABLE IF NOT EXISTS retries (workerId TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY(workerId, kind, n))');
  const latest = (workerId: string, kind: RetryKind): { at: string; evidence: string } | undefined => {
    if (kind === 'gate' || kind === 'acceptance') {
      const rows = store.listGates(workerId).filter((g) => !g.passed).flatMap((g) => g.checks.filter((c) => c.exitCode !== 0 && (kind === 'gate' || c.name === 'acceptance')).map((c) => ({ at: g.at, evidence: `${c.name}\n${tail(c.outputPath)}` })));
      return rows.sort((a, b) => b.at.localeCompare(a.at))[0];
    }
    if (kind === 'claims') {
      const row = store.sql.prepare('SELECT detail, at FROM claims_checks WHERE workerId = ? AND passed = 0 ORDER BY at DESC LIMIT 1').get(workerId) as { detail?: string; at?: string } | undefined;
      if (!row) return undefined;
      const detail = JSON.parse(row.detail ?? '{}') as { failedClaims?: string[]; answers?: Record<string, { choice?: string; supports?: number }> };
      const claims = (detail.failedClaims ?? []).map((claim) => `${claim} — ${detail.answers?.[claim]?.choice ?? 'unknown'} (p(supports)=${detail.answers?.[claim]?.supports ?? 0})`).join('\n');
      return { at: row.at ?? '', evidence: claims || JSON.stringify(detail) };
    }
    if (kind === 'review') {
      const row = store.sql.prepare("SELECT r.commentUrl, r.at FROM reviews r JOIN prs p ON p.number = r.number WHERE p.workerId = ? AND r.verdict IN ('changes','disputed') ORDER BY r.at DESC LIMIT 1").get(workerId) as { commentUrl?: string; at?: string } | undefined;
      if (!row?.commentUrl) return undefined;
      return { at: row.at ?? '', evidence: '' + row.commentUrl };
    }
    const events = store.listEvents(workerId, { limit: 1_000_000 }).filter((e) => {
      const text = JSON.stringify(e.data);
      return e.kind === 'conflict' && kind === 'conflict' || e.kind === 'tool.refused' && ((kind === 'tests_edited' && /baseline tests edited|test files edited/i.test(text)) || (kind === 'conflict' && /conflict|unmerged/i.test(text)));
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
    const chosen = input.kind ?? KINDS.map((kind) => ({ kind, failure: latest(input.workerId, kind) })).filter((x): x is { kind: RetryKind; failure: NonNullable<ReturnType<typeof latest>> } => Boolean(x.failure)).sort((a, b) => b.failure.at.localeCompare(a.failure.at))[0]?.kind;
    if (!chosen) return refusal('no recorded failure for worker');
    const failure = latest(input.workerId, chosen);
    if (!failure) return refusal(`no recorded failure for ${chosen}`);
    const count = Number((store.sql.prepare('SELECT COUNT(*) AS n FROM retries WHERE workerId = ? AND kind = ?').get(input.workerId, chosen) as { n: number }).n);
    if (count >= settings.factory.retryMax) return refusal(`retry limit reached for ${chosen}: respawn or ask Nick`);
    const evidence = chosen === 'review' ? await github.comment(worker.repoSlug, commentId(failure.evidence)).then((c) => c.body.slice(0, 6000)) : failure.evidence;
    const baseline = store.getMeta(input.workerId)?.baselineId ? store.sql.prepare('SELECT files FROM baselines WHERE id = ?').get(store.getMeta(input.workerId)!.baselineId) as { files?: string } | undefined : undefined;
    const noEdit = baseline?.files ? ` Do not edit ${JSON.parse(baseline.files).join(', ')}.` : '';
    const message = `Your last turn was rejected: ${chosen}. ${evidence}. Fix exactly this.${noEdit}`;
    const outcome = await steer(input.workerId, message);
    if (!outcome.ok) return outcome;
    store.sql.prepare('INSERT INTO retries (workerId, kind, n, at) VALUES (?, ?, ?, ?)').run(input.workerId, chosen, count + 1, new Date().toISOString());
    return { ok: true, turn: outcome.turn, kind: chosen, message };
  } };
}
