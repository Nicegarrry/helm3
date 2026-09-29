/** Per-repository, merge-first pull-request queue. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { singleRepoSlug } from './store.js';
import type { GitHub, Store, ToolOutcome, Workspace, WorkerRow } from './types.js';
import type { Settings } from './settings.js';
import { registerWakeKind } from './supervise.js';

export type QueueState = 'queued' | 'updating' | 'gating' | 'checks' | 'review' | 'ready' | 'merged' | 'failed' | 'conflict';
export type MergeQueueRow = Readonly<{ id: string; repoSlug: string; number: number; workerId: string; state: QueueState; head: string; reason: string | null; enqueuedAt: string; updatedAt: string }>;
export type QueueExec = (file: string, args: string[], options: { cwd?: string }) => Promise<{ stdout: string; stderr?: string; code: number }>;
type GateCall = (input: { workerId: string }) => Promise<ToolOutcome<{ head: string; passed: boolean }>>;
type MergeCall = (input: { repoSlug: string; number: number; expectedHead: string }) => Promise<ToolOutcome<{ merged: true }>>;
type QueueError = Error & { conflict?: boolean; transient?: boolean; stdout?: string; stderr?: string; files?: string[]; baseSha?: string; currentHead?: string };
type QueueMeta = { baseSha: string; pendingBaseSha: string | null; priorPatchId: string | null; transientErrors: number; conflictRetries: number; conflictFiles: string[] };
type ConflictRetry = (input: { workerId: string; kind: 'conflict' }) => Promise<ToolOutcome<{ turn: number; message: string }>>;
export type QueueService = Readonly<{
  enqueue(input: { repoSlug?: string; number: number }): Promise<ToolOutcome<{ item: MergeQueueRow }>>;
  queue(input: { project: string }): ToolOutcome<{ items: MergeQueueRow[] }>;
  dequeue(input: { repoSlug?: string; number: number }): ToolOutcome<{ dequeued: true }>;
  tick(): Promise<void>;
}>;
export type QueueOptions = Readonly<{ store: Store; workspace: Workspace; github: GitHub; settings: Settings; gate: GateCall; prMerge: MergeCall; retry?: ConflictRetry; exec?: QueueExec; now?: () => Date }>;

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function transientError(error: unknown, message: string): QueueError {
  return Object.assign(new Error(`${message}: ${errorMessage(error)}`), { transient: true });
}

export function createQueue(options: QueueOptions): QueueService {
  const { store, workspace, github, settings, gate, prMerge, retry } = options;
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? (() => new Date());
  const queueTable = store.sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'merge_queue'").get();
  if (!queueTable) {
    store.sql.exec('CREATE TABLE merge_queue (id TEXT PRIMARY KEY, repoSlug TEXT NOT NULL, number INTEGER NOT NULL, workerId TEXT NOT NULL, state TEXT NOT NULL, head TEXT NOT NULL, reason TEXT, enqueuedAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(repoSlug, number))');
  } else {
    const columns = store.sql.prepare('PRAGMA table_info(merge_queue)').all() as Array<{ name: string }>;
    const indexes = store.sql.prepare('PRAGMA index_list(merge_queue)').all() as Array<{ name: string; unique: number }>;
    const compositeUnique = indexes.some((index) => {
      if (!index.unique) return false;
      const identifier = `"${index.name.replaceAll('"', '""')}"`;
      const indexColumns = store.sql.prepare(`PRAGMA index_info(${identifier})`).all() as Array<{ name: string }>;
      return indexColumns.map((column) => column.name).join(',') === 'repoSlug,number';
    });
    if (!columns.some((column) => column.name === 'repoSlug') || !compositeUnique) {
      store.sql.exec('BEGIN IMMEDIATE');
      try {
        store.sql.exec(`
          DROP TABLE IF EXISTS merge_queue_v2;
          CREATE TABLE merge_queue_v2 (
            id TEXT PRIMARY KEY, repoSlug TEXT NOT NULL, number INTEGER NOT NULL, workerId TEXT NOT NULL,
            state TEXT NOT NULL, head TEXT NOT NULL, reason TEXT, enqueuedAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
            UNIQUE(repoSlug, number)
          );
        `);
        const rows = store.sql.prepare('SELECT * FROM merge_queue').all() as Array<Record<string, unknown>>;
        const workers = store.sql.prepare('SELECT workerId, repoSlug FROM workers').all() as Array<{ workerId: string; repoSlug: string }>;
        const prs = store.sql.prepare('SELECT repoSlug, number, workerId FROM prs').all() as Array<{ repoSlug: string; number: number; workerId: string }>;
        const insert = store.sql.prepare('INSERT INTO merge_queue_v2 (id, repoSlug, number, workerId, state, head, reason, enqueuedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const row of rows) {
          const workerRepo = workers.find((worker) => worker.workerId === String(row.workerId))?.repoSlug;
          const prRepo = prs.find((pr) => pr.workerId === String(row.workerId) && pr.number === Number(row.number))?.repoSlug;
          const repoSlug = String(row.repoSlug ?? workerRepo ?? prRepo ?? `unknown/queue-${String(row.id)}`);
          insert.run(String(row.id), repoSlug, Number(row.number), String(row.workerId), String(row.state), String(row.head), row.reason === null ? null : String(row.reason), String(row.enqueuedAt), String(row.updatedAt));
        }
        store.sql.exec('DROP TABLE merge_queue; ALTER TABLE merge_queue_v2 RENAME TO merge_queue; COMMIT');
      } catch (error) {
        try { store.sql.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
        throw error;
      }
    }
  }
  store.sql.exec('CREATE INDEX IF NOT EXISTS merge_queue_project ON merge_queue(repoSlug, state, enqueuedAt); CREATE TABLE IF NOT EXISTS merge_queue_meta (id TEXT PRIMARY KEY, baseSha TEXT NOT NULL, pendingBaseSha TEXT, priorPatchId TEXT, transientErrors INTEGER NOT NULL DEFAULT 0, conflictRetries INTEGER NOT NULL DEFAULT 0, conflictFiles TEXT NOT NULL DEFAULT \'[]\')');
  try { store.sql.exec('ALTER TABLE merge_queue_meta ADD COLUMN transientErrors INTEGER NOT NULL DEFAULT 0'); } catch { /* existing v4 databases already have it */ }
  try { store.sql.exec('ALTER TABLE merge_queue_meta ADD COLUMN conflictRetries INTEGER NOT NULL DEFAULT 0'); } catch { /* existing v4 databases already have it */ }
  try { store.sql.exec('ALTER TABLE merge_queue_meta ADD COLUMN pendingBaseSha TEXT'); } catch { /* existing v4 databases already have it */ }
  try { store.sql.exec("ALTER TABLE merge_queue_meta ADD COLUMN conflictFiles TEXT NOT NULL DEFAULT '[]'"); } catch { /* existing v4 databases already have it */ }
  const read = store.sql.prepare('SELECT * FROM merge_queue WHERE id = ?');
  const byNumber = store.sql.prepare('SELECT * FROM merge_queue WHERE repoSlug = ? AND number = ?');
  const active = store.sql.prepare("SELECT * FROM merge_queue WHERE state NOT IN ('merged', 'failed', 'conflict') ORDER BY enqueuedAt ASC, id ASC");
  const list = store.sql.prepare('SELECT * FROM merge_queue WHERE repoSlug = ? ORDER BY enqueuedAt ASC, id ASC');
  const insert = store.sql.prepare('INSERT INTO merge_queue (id, repoSlug, number, workerId, state, head, reason, enqueuedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)');
  const update = store.sql.prepare('UPDATE merge_queue SET state = ?, head = ?, reason = ?, updatedAt = ? WHERE id = ?');
  const requeue = store.sql.prepare('UPDATE merge_queue SET state = ?, head = ?, reason = NULL, enqueuedAt = ?, updatedAt = ? WHERE id = ?');
  const remove = store.sql.prepare('DELETE FROM merge_queue WHERE id = ?');
  const metaRead = store.sql.prepare('SELECT baseSha, pendingBaseSha, priorPatchId, transientErrors, conflictRetries, conflictFiles FROM merge_queue_meta WHERE id = ?');
  const metaWrite = store.sql.prepare('INSERT INTO merge_queue_meta (id, baseSha, pendingBaseSha, priorPatchId, transientErrors, conflictRetries, conflictFiles) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET baseSha = excluded.baseSha, pendingBaseSha = excluded.pendingBaseSha, priorPatchId = excluded.priorPatchId, transientErrors = excluded.transientErrors, conflictRetries = excluded.conflictRetries, conflictFiles = excluded.conflictFiles');
  const metaCount = store.sql.prepare('UPDATE merge_queue_meta SET transientErrors = ? WHERE id = ?');
  const readMeta = (id: string): QueueMeta => {
    const row = metaRead.get(id) as Record<string, unknown>;
    let conflictFiles: string[] = [];
    try { conflictFiles = JSON.parse(String(row.conflictFiles ?? '[]')) as string[]; } catch { /* old or corrupt metadata is conservatively empty */ }
    return { baseSha: String(row.baseSha), pendingBaseSha: (row.pendingBaseSha as string | null) ?? null, priorPatchId: (row.priorPatchId as string | null) ?? null, transientErrors: Number(row.transientErrors ?? 0), conflictRetries: Number(row.conflictRetries ?? 0), conflictFiles };
  };
  const iso = () => now().toISOString();
  const item = (id: string) => { const row = read.get(id) as Record<string, unknown> | undefined; return row ? asRow(row) : undefined; };
  const setState = (row: MergeQueueRow, state: QueueState, head = row.head, reason: string | null = null) => { update.run(state, head, reason, iso(), row.id); return item(row.id)!; };
  const event = (row: MergeQueueRow, kind: string, reason?: string) => store.appendEvent(`project:${row.repoSlug}`, kind, { project: row.repoSlug, number: row.number, head: row.head, ...(reason ? { reason } : {}) });
  const fail = (row: MergeQueueRow, reason: string) => { const saved = setState(row, 'failed', row.head, reason); event(saved, 'queue.failed', reason); };
  const review = (row: MergeQueueRow, reason: string) => { const saved = setState(row, 'review', row.head, reason); event(saved, 'queue.review', reason); };
  const resetTransient = (id: string) => metaCount.run(0, id);
  const markTransient = (row: MergeQueueRow, reason: string): boolean => {
    const meta = metaRead.get(row.id) as { transientErrors?: number } | undefined;
    const attempts = Number(meta?.transientErrors ?? 0) + 1;
    metaCount.run(attempts, row.id);
    const saved = setState(row, row.state, row.head, reason);
    if (attempts < 3) return false;
    const failed = setState(saved, 'failed', saved.head, reason);
    event(failed, 'queue.failed', reason);
    return true;
  };

  async function enqueue(input: { repoSlug?: string; number: number }): Promise<ToolOutcome<{ item: MergeQueueRow }>> {
    const repoSlug = input.repoSlug ?? singleRepoSlug(store);
    if (!repoSlug) return { ok: false, reason: 'repoSlug is required when multiple repositories are present' };
    const old = byNumber.get(repoSlug, input.number) as Record<string, unknown> | undefined;
    if (old) {
      const row = asRow(old);
      if (row.state === 'merged') return { ok: false, reason: 'already merged' };
      if (row.state === 'failed' || row.state === 'conflict') {
        const pr = store.getPrByNumber(repoSlug, input.number);
        const worker = pr && store.getWorker(pr.workerId);
        if (!pr || !worker) return { ok: false, reason: 'pr worker not found' };
        requeue.run('queued', pr.head, iso(), iso(), row.id);
        metaWrite.run(row.id, worker.baseSha, null, null, 0, 0, '[]');
        return { ok: true, item: item(row.id)! };
      }
      return { ok: true, item: row };
    }
    const pr = store.getPrByNumber(repoSlug, input.number);
    if (!pr) return { ok: false, reason: 'pr not found' };
    const worker = store.getWorker(pr.workerId);
    if (!worker) return { ok: false, reason: 'pr worker not found' };
    const at = iso(); const id = `mq-${randomUUID()}`;
    insert.run(id, repoSlug, input.number, worker.workerId, 'queued', pr.head, at, at);
    metaWrite.run(id, worker.baseSha, null, null, 0, 0, '[]');
    return { ok: true, item: item(id)! };
  }

  function queue(input: { project: string }): ToolOutcome<{ items: MergeQueueRow[] }> {
    return { ok: true, items: (list.all(input.project) as Record<string, unknown>[]).map(asRow) };
  }

  function dequeue(input: { repoSlug?: string; number: number }): ToolOutcome<{ dequeued: true }> {
    const repoSlug = input.repoSlug ?? singleRepoSlug(store);
    if (!repoSlug) return { ok: false, reason: 'repoSlug is required when multiple repositories are present' };
    const found = byNumber.get(repoSlug, input.number) as Record<string, unknown> | undefined;
    if (!found) return { ok: false, reason: 'queue item not found' };
    const row = asRow(found);
    if (row.state === 'merged') return { ok: false, reason: 'already merged' };
    remove.run(row.id); store.sql.prepare('DELETE FROM merge_queue_meta WHERE id = ?').run(row.id);
    return { ok: true, dequeued: true };
  }

  async function mergeBase(row: MergeQueueRow, worker: WorkerRow): Promise<{ base: string; meta: { baseSha: string; priorPatchId: string | null } }> {
    let base: string;
    try { await workspace.fetch(worker.repo); base = await workspace.resolveSha(worker.repo, `origin/${worker.baseRef}`); }
    catch (error) { throw transientError(error, 'fetch failed'); }
    const meta = readMeta(row.id);
    return { base, meta };
  }

  async function runMerge(worker: WorkerRow): Promise<void> {
    let result: { stdout: string; stderr?: string; code: number } | undefined;
    let failure: QueueError | undefined;
    try { result = await exec('git', ['merge', '--no-commit', `origin/${worker.baseRef}`], { cwd: worker.worktree }); }
    catch (error) { failure = Object.assign(new Error(errorMessage(error)), error as object) as QueueError; }
    if (result?.code === 0) return;
    const unresolvedResult = await exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: worker.worktree }).catch(() => undefined);
    const files = String(unresolvedResult?.stdout ?? '').split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
    if (files.length) throw Object.assign(new Error(`merge conflict: ${files.join(', ')}`), { conflict: true, files });
    try { await exec('git', ['merge', '--abort'], { cwd: worker.worktree }); } catch { /* preserve the original failure */ }
    const message = result?.stderr?.trim() || failure?.stderr?.trim() || failure?.stdout?.trim() || failure?.message || 'git merge failed';
    throw new Error(message);
  }

  async function prepare(row: MergeQueueRow, worker: WorkerRow): Promise<MergeQueueRow> {
    const { base, meta } = await mergeBase(row, worker);
    if (meta.baseSha === base) return row;
    const currentHead = await workspace.head(worker.worktree).catch(() => worker.head ?? row.head);
    store.updateWorker(worker.workerId, { head: currentHead });
    const updating = setState(row, 'updating', currentHead);
    const priorPatchId = await workspace.patchId(worker.repo, meta.baseSha, updating.head);
    try { await runMerge(worker); }
    catch (error) {
      if ((error as QueueError).conflict) {
        const head = await workspace.head(worker.worktree).catch(() => currentHead);
        store.updateWorker(worker.workerId, { head });
        throw Object.assign(error as QueueError, { baseSha: base, currentHead: head });
      }
      throw error;
    }
    const head = await workspace.commitAll(worker.worktree, `helm: merge origin/${worker.baseRef}`);
    store.updateWorker(worker.workerId, { head });
    metaWrite.run(row.id, base, null, priorPatchId, 0, 0, '[]');
    return setState(updating, 'gating', head);
  }

  const conflictState = (row: MergeQueueRow, reason: string): MergeQueueRow => { const saved = setState(row, 'conflict', row.head, reason); event(saved, 'queue.failed', reason); return saved; };
  const markerFiles = async (worker: WorkerRow, head: string, files: string[]): Promise<string[]> => {
    if (!files.length) return [];
    const unmerged = await exec('git', ['ls-files', '-u', '--', ...files], { cwd: worker.worktree }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    if (String(unmerged.stdout).trim()) return files;
    const markers = await exec('git', ['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>)( |$)', head, '--', ...files], { cwd: worker.worktree }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    const prefix = `${head}:`;
    const found = String(markers.stdout).split(/\r?\n/).map((line) => line.startsWith(prefix) ? line.slice(prefix.length) : line).filter((file) => files.includes(file));
    return [...new Set(found)];
  };
  const mergeResolved = async (worker: WorkerRow, base: string, head: string): Promise<boolean> => {
    const ancestor = await exec('git', ['merge-base', '--is-ancestor', base, head], { cwd: worker.worktree }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    if (ancestor.code !== 0) return false;
    const mergeHead = await exec('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: worker.worktree }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    return mergeHead.code !== 0;
  };
  const sendConflictRetry = async (row: MergeQueueRow, worker: WorkerRow, base: string, files: string[], attempts: number, currentHead = worker.head ?? row.head): Promise<MergeQueueRow> => {
    const failureRow = currentHead === row.head ? row : { ...row, head: currentHead };
    store.appendEvent(worker.workerId, 'conflict', { project: worker.repoSlug, head: currentHead, files });
    if (!retry) return conflictState(failureRow, `conflict retry unavailable: ${files.join(', ')}`);
    if (!existsSync(worker.worktree)) return conflictState(failureRow, `worktree missing: ${worker.worktree}`);
    if (!['idle', 'waiting', 'succeeded', 'failed', 'interrupted'].includes(worker.state)) return conflictState(failureRow, `worker is ${worker.state}, not steerable`);
    const result = await retry({ workerId: worker.workerId, kind: 'conflict' });
    if (!result.ok) return conflictState(failureRow, `conflict retry refused: ${result.reason}`);
    const meta = readMeta(row.id);
    metaWrite.run(row.id, meta.baseSha, base, meta.priorPatchId, 0, attempts + 1, JSON.stringify(files));
    return setState(row, 'updating', currentHead, 'conflict retry sent');
  };

  async function checkAndMerge(row: MergeQueueRow, worker: WorkerRow): Promise<boolean> {
    let status;
    try { status = await github.prStatus(row.repoSlug, row.number); }
    catch (error) { return !markTransient(row, `checks API failed: ${errorMessage(error)}`) && row.state !== 'review'; }
    const state = String(status.state);
    if (state === 'merged') { resetTransient(row.id); const saved = setState(row, 'merged'); event(saved, 'queue.merged'); return true; }
    if (state !== 'open') { fail(row, `pr is ${state}`); return true; }
    if (status.head !== row.head) { fail(row, `head changed: expected ${row.head}, got ${status.head}`); return true; }
    if (status.mergeable === null || status.mergeable === undefined || String(status.mergeable).toLowerCase() === 'unknown') { return markTransient(row, 'mergeable is unknown') || row.state !== 'review'; }
    resetTransient(row.id);
    const unfinished = status.checks.find((check) => check.status !== 'completed');
    if (unfinished) {
      if (now().getTime() - Date.parse(row.updatedAt) >= settings.queue.checksTimeoutMin * 60_000) fail(row, `check timeout: ${unfinished.name}`);
      return row.state !== 'review';
    }
    const failing = status.checks.find((check) => !passing.has(check.conclusion ?? ''));
    if (failing) { fail(row, `check "${failing.name}" did not succeed (${failing.conclusion ?? 'no conclusion'})`); return true; }
    const meta = readMeta(row.id);
    if (meta.priorPatchId) {
      const currentPatchId = await workspace.patchId(worker.repo, meta.baseSha, row.head);
      if (currentPatchId !== meta.priorPatchId) {
        metaWrite.run(row.id, meta.baseSha, meta.pendingBaseSha, currentPatchId, 0, meta.conflictRetries, JSON.stringify(meta.conflictFiles));
        if (row.state !== 'review') review(row, 'the interdiff changed after the base moved');
        return row.state !== 'review';
      }
    }
    const ready = row.state === 'review' ? row : setState(row, 'ready');
    const merged = await prMerge({ repoSlug: ready.repoSlug, number: ready.number, expectedHead: ready.head });
    if (merged.ok) { const saved = setState(ready, 'merged'); event(saved, 'queue.merged'); return true; }
    if (/no approving review/i.test(merged.reason)) { if (row.state !== 'review') review(ready, merged.reason); return row.state !== 'review'; }
    fail(ready, merged.reason);
    return true;
  }

  async function process(row: MergeQueueRow): Promise<boolean> {
    const worker = store.getWorker(row.workerId);
    if (!worker) { conflictState(row, 'worker not found'); return true; }
    let current = row;
    if (current.state === 'updating') {
      if (worker.state === 'running' || worker.state === 'queued') return false;
      if (worker.state === 'unknown' || worker.state === 'stopped') { conflictState(current, `worker is ${worker.state}, not steerable`); return true; }
      if (!existsSync(worker.worktree)) { conflictState(current, `worktree missing: ${worker.worktree}`); return true; }
      const meta = readMeta(current.id);
      const base = meta.pendingBaseSha ?? meta.baseSha;
      let head = worker.head ?? await workspace.head(worker.worktree).catch(() => current.head);
      try { head = await workspace.commitAll(worker.worktree, 'helm: resolve merge conflict'); store.updateWorker(worker.workerId, { head }); }
      catch (error) { conflictState(current, `conflict commit failed: ${errorMessage(error)}`); return true; }
      if (!(await mergeResolved(worker, base, head))) {
        if (meta.conflictRetries >= 2) { conflictState(current, `merge remains unresolved against ${base}`); return true; }
        await sendConflictRetry(current, worker, base, meta.conflictFiles, meta.conflictRetries);
        return true;
      }
      const files = await markerFiles(worker, head, meta.conflictFiles);
      if (files.length) {
        if (meta.conflictRetries >= 2) { conflictState(current, `conflict markers remain: ${files.join(', ')}`); return true; }
        await sendConflictRetry(current, worker, base, files, meta.conflictRetries);
        return true;
      }
      metaWrite.run(current.id, base, null, meta.priorPatchId, 0, meta.conflictRetries, '[]');
      current = setState(current, 'gating', head);
    }
    try { current = await prepare(current, worker); }
    catch (error) {
      const problem = error as QueueError;
      if (problem.conflict) {
        const meta = readMeta(current.id);
        await sendConflictRetry(current, worker, problem.baseSha ?? meta.baseSha, problem.files ?? [problem.message], meta.conflictRetries, problem.currentHead);
        return true;
      }
      if (problem.transient) return markTransient(current, problem.message) || current.state !== 'review';
      fail(current, errorMessage(error));
      return true;
    }
    if (current.state === 'review') return checkAndMerge(current, worker);
    if (current.state === 'queued' || current.state === 'updating' || current.state === 'gating') {
      current = setState(current, 'gating');
      const gated = await gate({ workerId: current.workerId });
      if (!gated.ok) { fail(current, gated.reason); return true; }
      if (!gated.passed) { fail(current, 'gate failed'); return true; }
      try { await workspace.push(worker.worktree, worker.branch); const ready = await exec('gh', ['pr', 'ready', String(current.number), '--repo', current.repoSlug], { cwd: worker.worktree }); if (ready.code !== 0) throw new Error(ready.stderr?.trim() || 'gh pr ready failed'); }
      catch (error) { fail(current, errorMessage(error)); return true; }
      current = setState(current, 'checks');
    }
    if (current.state === 'checks' || current.state === 'ready') return checkAndMerge(current, worker);
    return true;
  }

  let running: Promise<void> | undefined;
  async function tick(): Promise<void> {
    if (running) return running;
    running = (async () => {
      const rows = (active.all() as Record<string, unknown>[]).map(asRow);
      const byRepo = new Map<string, MergeQueueRow[]>();
      for (const row of rows) byRepo.set(row.repoSlug, [...(byRepo.get(row.repoSlug) ?? []), row]);
      for (const repoRows of byRepo.values()) {
        for (const row of repoRows) {
          const worked = await process(row);
          if (row.state !== 'review' || worked) break;
        }
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  return { enqueue, queue, dequeue, tick };
}
