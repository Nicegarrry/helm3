/** Per-repository, merge-first pull-request queue. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { GitHub, Store, ToolOutcome, Workspace, WorkerRow } from './types.js';
import type { Settings } from './settings.js';
import { registerWakeKind } from './supervise.js';

export type QueueState = 'queued' | 'updating' | 'gating' | 'checks' | 'review' | 'ready' | 'merged' | 'failed' | 'conflict';
export type MergeQueueRow = Readonly<{ id: string; repoSlug: string; number: number; workerId: string; state: QueueState; head: string; reason: string | null; enqueuedAt: string; updatedAt: string }>;
export type QueueExec = (file: string, args: string[], options: { cwd?: string }) => Promise<{ stdout: string; stderr?: string; code: number }>;
type GateCall = (input: { workerId: string }) => Promise<ToolOutcome<{ head: string; passed: boolean }>>;
type MergeCall = (input: { number: number; expectedHead: string }) => Promise<ToolOutcome<{ merged: true }>>;
export type QueueService = Readonly<{
  enqueue(input: { number: number }): Promise<ToolOutcome<{ item: MergeQueueRow }>>;
  queue(input: { project: string }): ToolOutcome<{ items: MergeQueueRow[] }>;
  dequeue(input: { number: number }): ToolOutcome<{ dequeued: true }>;
  tick(): Promise<void>;
}>;
export type QueueOptions = Readonly<{ store: Store; workspace: Workspace; github: GitHub; settings: Settings; gate: GateCall; prMerge: MergeCall; exec?: QueueExec; now?: () => Date }>;

const realExec = promisify(execFile);
const defaultExec: QueueExec = async (file, args, options) => {
  const result = await realExec(file, args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
};
const passing = new Set(['success', 'neutral', 'skipped']);

function wake(kind: string, summary: (data: Record<string, unknown>) => string) {
  registerWakeKind(kind, (event, project, now) => ({ id: `wake-${randomUUID()}`, project, kind, workerId: event.workerId, summary: summary(event.data), command: false, createdAt: now }));
}
wake('queue.review', (data) => `PR #${String(data.number)} needs re-review: ${String(data.reason ?? 'the interdiff changed')}`);
wake('queue.failed', (data) => `PR #${String(data.number)} failed: ${String(data.reason ?? 'merge queue failure')}`);
wake('queue.merged', (data) => `PR #${String(data.number)} merged`);

function asRow(row: Record<string, unknown>): MergeQueueRow {
  return { id: String(row.id), repoSlug: String(row.repoSlug), number: Number(row.number), workerId: String(row.workerId), state: row.state as QueueState, head: String(row.head), reason: (row.reason as string | null) ?? null, enqueuedAt: String(row.enqueuedAt), updatedAt: String(row.updatedAt) };
}

export function createQueue(options: QueueOptions): QueueService {
  const { store, workspace, github, settings, gate, prMerge } = options;
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? (() => new Date());
  store.sql.exec(`CREATE TABLE IF NOT EXISTS merge_queue (id TEXT PRIMARY KEY, repoSlug TEXT NOT NULL, number INTEGER NOT NULL UNIQUE, workerId TEXT NOT NULL, state TEXT NOT NULL, head TEXT NOT NULL, reason TEXT, enqueuedAt TEXT NOT NULL, updatedAt TEXT NOT NULL); CREATE INDEX IF NOT EXISTS merge_queue_project ON merge_queue(repoSlug, state, enqueuedAt); CREATE TABLE IF NOT EXISTS merge_queue_meta (id TEXT PRIMARY KEY, baseSha TEXT NOT NULL, priorPatchId TEXT)`);
  const read = store.sql.prepare('SELECT * FROM merge_queue WHERE id = ?');
  const byNumber = store.sql.prepare('SELECT * FROM merge_queue WHERE number = ?');
  const active = store.sql.prepare("SELECT * FROM merge_queue WHERE state NOT IN ('merged', 'failed', 'conflict') ORDER BY enqueuedAt ASC, id ASC");
  const list = store.sql.prepare('SELECT * FROM merge_queue WHERE repoSlug = ? ORDER BY enqueuedAt ASC, id ASC');
  const insert = store.sql.prepare('INSERT INTO merge_queue (id, repoSlug, number, workerId, state, head, reason, enqueuedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)');
  const update = store.sql.prepare('UPDATE merge_queue SET state = ?, head = ?, reason = ?, updatedAt = ? WHERE id = ?');
  const remove = store.sql.prepare('DELETE FROM merge_queue WHERE id = ?');
  const metaRead = store.sql.prepare('SELECT * FROM merge_queue_meta WHERE id = ?');
  const metaWrite = store.sql.prepare('INSERT INTO merge_queue_meta (id, baseSha, priorPatchId) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET baseSha = excluded.baseSha, priorPatchId = excluded.priorPatchId');
  const iso = () => now().toISOString();
  const item = (id: string) => { const row = read.get(id) as Record<string, unknown> | undefined; return row ? asRow(row) : undefined; };
  const setState = (row: MergeQueueRow, state: QueueState, head = row.head, reason: string | null = null) => { update.run(state, head, reason, iso(), row.id); return item(row.id)!; };
  const event = (row: MergeQueueRow, kind: string, reason?: string) => store.appendEvent(`project:${row.repoSlug}`, kind, { project: row.repoSlug, number: row.number, head: row.head, ...(reason ? { reason } : {}) });
  const fail = (row: MergeQueueRow, reason: string) => { const saved = setState(row, 'failed', row.head, reason); event(saved, 'queue.failed', reason); };
  const review = (row: MergeQueueRow, reason: string) => { const saved = setState(row, 'review', row.head, reason); event(saved, 'queue.review', reason); };

  async function enqueue(input: { number: number }): Promise<ToolOutcome<{ item: MergeQueueRow }>> {
    const old = byNumber.get(input.number) as Record<string, unknown> | undefined;
    if (old) return { ok: true, item: asRow(old) };
    const pr = store.getPrByNumber(input.number);
    if (!pr) return { ok: false, reason: 'pr not found' };
    const worker = store.getWorker(pr.workerId);
    if (!worker) return { ok: false, reason: 'pr worker not found' };
    const at = iso(); const id = `mq-${randomUUID()}`;
    insert.run(id, worker.repoSlug, input.number, worker.workerId, 'queued', pr.head, at, at);
    metaWrite.run(id, worker.baseSha, null);
    return { ok: true, item: item(id)! };
  }

  function queue(input: { project: string }): ToolOutcome<{ items: MergeQueueRow[] }> {
    return { ok: true, items: (list.all(input.project) as Record<string, unknown>[]).map(asRow) };
  }

  function dequeue(input: { number: number }): ToolOutcome<{ dequeued: true }> {
    const found = byNumber.get(input.number) as Record<string, unknown> | undefined;
    if (!found) return { ok: false, reason: 'queue item not found' };
    const row = asRow(found);
    if (row.state !== 'queued') return { ok: false, reason: `cannot dequeue item in state ${row.state}` };
    remove.run(row.id); store.sql.prepare('DELETE FROM merge_queue_meta WHERE id = ?').run(row.id);
    return { ok: true, dequeued: true };
  }

  async function prepare(row: MergeQueueRow, worker: WorkerRow): Promise<MergeQueueRow> {
    await workspace.fetch(worker.repo);
    const base = await workspace.resolveSha(worker.repo, `origin/${worker.baseRef}`);
    const meta = metaRead.get(row.id) as { baseSha: string; priorPatchId: string | null };
    if (meta.baseSha === base) return row;
    const updating = setState(row, 'updating');
    const priorPatchId = await workspace.patchId(worker.repo, meta.baseSha, updating.head);
    let merged;
    try { merged = await exec('git', ['merge', `origin/${worker.baseRef}`], { cwd: worker.worktree }); } catch (err) { throw new Error(err instanceof Error ? err.message : String(err)); }
    if (merged.code !== 0) {
      const message = merged.stderr?.trim() || 'git merge failed';
      if (/conflict|automatic merge failed|unmerged/i.test(message)) throw Object.assign(new Error(message), { conflict: true });
      throw new Error(message);
    }
    const head = await workspace.commitAll(worker.worktree, `helm: merge origin/${worker.baseRef}`);
    store.updateWorker(worker.workerId, { head });
    metaWrite.run(row.id, base, priorPatchId);
    return setState(updating, 'gating', head);
  }

  async function checkAndMerge(row: MergeQueueRow, worker: WorkerRow): Promise<void> {
    const status = await github.prStatus(row.repoSlug, row.number);
    if (status.state !== 'open') { fail(row, `pr is ${status.state}`); return; }
    if (status.head !== row.head) { fail(row, `head changed: expected ${row.head}, got ${status.head}`); return; }
    const unfinished = status.checks.find((check) => check.status !== 'completed');
    if (unfinished) {
      if (now().getTime() - Date.parse(row.updatedAt) >= settings.queue.checksTimeoutMin * 60_000) fail(row, `check timeout: ${unfinished.name}`);
      return;
    }
    const failing = status.checks.find((check) => !passing.has(check.conclusion ?? ''));
    if (failing) { fail(row, `check "${failing.name}" did not succeed (${failing.conclusion ?? 'no conclusion'})`); return; }
    const meta = metaRead.get(row.id) as { baseSha: string; priorPatchId: string | null };
    if (meta.priorPatchId) {
      const currentPatchId = await workspace.patchId(worker.repo, meta.baseSha, row.head);
      if (currentPatchId !== meta.priorPatchId) { if (row.state !== 'review') review(row, 'the interdiff changed after the base moved'); return; }
    }
    const ready = setState(row, 'ready');
    const merged = await prMerge({ number: ready.number, expectedHead: ready.head });
    if (merged.ok) { const saved = setState(ready, 'merged'); event(saved, 'queue.merged'); return; }
    if (/no approving review/i.test(merged.reason)) { if (row.state !== 'review') review(ready, merged.reason); return; }
    fail(ready, merged.reason);
  }

  async function process(row: MergeQueueRow): Promise<void> {
    const worker = store.getWorker(row.workerId);
    if (!worker) { fail(row, 'worker not found'); return; }
    let current = row;
    try { current = await prepare(current, worker); } catch (err) {
      if ((err as { conflict?: boolean }).conflict) { const saved = setState(current, 'conflict', current.head, err instanceof Error ? err.message : String(err)); event(saved, 'queue.failed', saved.reason ?? 'merge conflict'); }
      else fail(current, err instanceof Error ? err.message : String(err));
      return;
    }
    if (current.state === 'review') { await checkAndMerge(current, worker); return; }
    if (current.state === 'queued' || current.state === 'updating' || current.state === 'gating') {
      current = setState(current, 'gating');
      const gated = await gate({ workerId: current.workerId });
      if (!gated.ok) { fail(current, gated.reason); return; }
      if (!gated.passed) { fail(current, 'gate failed'); return; }
      try { await workspace.push(worker.worktree, worker.branch); const ready = await exec('gh', ['pr', 'ready', String(current.number), '--repo', current.repoSlug], { cwd: worker.worktree }); if (ready.code !== 0) throw new Error(ready.stderr?.trim() || 'gh pr ready failed'); }
      catch (err) { fail(current, err instanceof Error ? err.message : String(err)); return; }
      current = setState(current, 'checks');
    }
    if (current.state === 'checks' || current.state === 'ready') await checkAndMerge(current, worker);
  }

  let running: Promise<void> | undefined;
  async function tick(): Promise<void> {
    if (running) return running;
    running = (async () => {
      const rows = (active.all() as Record<string, unknown>[]).map(asRow);
      const first = new Map<string, MergeQueueRow>();
      for (const row of rows) if (!first.has(row.repoSlug)) first.set(row.repoSlug, row);
      for (const row of first.values()) await process(row);
    })().finally(() => { running = undefined; });
    return running;
  }
  return { enqueue, queue, dequeue, tick };
}
