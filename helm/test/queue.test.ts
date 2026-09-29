import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createQueue, type QueueExec } from '../src/queue.js';
import { createReview } from '../src/review.js';
import { createSupervisor } from '../src/supervise.js';
import { openStore } from '../src/store.js';
import { loadSettings, type Settings } from '../src/settings.js';
import type { GitHub, PrStatus, WorkerRow, Workspace } from '../src/types.js';

const h1 = '1'.repeat(40);
const h2 = '2'.repeat(40);
const h3 = '3'.repeat(40);

function worker(id: string, number: number, head: string, worktree = `/worktree/${id}`, state: WorkerRow['state'] = 'succeeded'): WorkerRow {
  const at = new Date('2026-01-01T00:00:00.000Z').toISOString();
  return { workerId: id, repo: '/repo', repoSlug: 'owner/repo', role: 'builder', model: 'codex/test', objective: `PR ${number}`, acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'base', branch: `helm/${id}`, worktree, state, head, sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: at, updatedAt: at };
}

function setup(options: { gate?: boolean; mergeHead?: string; worktree?: string; patchIds?: Record<string, string>; exec?: QueueExec; pending?: boolean; guardReviews?: boolean; fetchError?: boolean; statusError?: boolean; mergeable?: boolean | null; merged?: boolean; retry?: (input: { workerId: string; kind: 'conflict' }) => Promise<{ ok: true; turn: number; message: string } | { ok: false; reason: string }>; workerState?: WorkerRow['state']; missingWorktree?: boolean } = {}) {
  const store = openStore(':memory:');
  const retryWorktree = options.retry && !options.missingWorktree ? options.worktree ?? mkdtempSync(join(tmpdir(), 'helm-queue-')) : undefined;
  const workers = [worker('w-1', 1, h1, retryWorktree, options.workerState), worker('w-2', 2, h2)];
  for (const row of workers) { store.insertWorker(row); store.insertPr({ number: Number(row.workerId.slice(-1)), workerId: row.workerId, url: `https://example.invalid/${row.workerId}`, head: row.head!, createdAt: row.createdAt }); }
  let base = 'base';
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const heads = new Map<number, string>([[1, h1], [2, h2]]);
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  const workspace: Workspace = {
    async fetch() { if (options.fetchError) throw new Error('network unavailable'); }, async patchId(_repo, patchBase, head) { return options.patchIds?.[`${patchBase}:${head}`] ?? 'same'; },
    async commitAll(path) { const head = options.mergeHead ?? h3; heads.set(path.endsWith('w-2') ? 2 : 1, head); return head; },
    async push() {}, async head(path) { return heads.get(path.endsWith('w-2') ? 2 : 1) ?? h1; }, async isClean() { return true; }, async diffStat() { return ''; },
    async resolveSha() { return base; }, async defaultBranch() { return 'main'; }, async create(_repo, path, branch, baseSha) { return { path, branch, baseSha }; }, async remove() {}, async clone() {},
  } as Workspace;
  const github: GitHub = {
    async prStatus(_repo, number): Promise<PrStatus> { if (options.statusError) throw new Error('checks service unavailable'); return { number, state: options.merged ? 'merged' : 'open', head: heads.get(number)!, mergeable: options.mergeable === undefined ? true : options.mergeable, draft: false, checks: options.pending ? [{ name: 'ci', status: 'pending', conclusion: null }] : [], reviews: [], url: 'https://example.invalid/pr' }; },
    async openPr() { return { number: 1, url: 'https://example.invalid/pr' }; }, async comment() { return { body: 'APPROVE: ok', issueNumber: 1 }; }, async postComment() {}, async merge() {},
  };
  const exec: QueueExec = options.exec ?? (async (file, args, opts) => { calls.push({ file, args, cwd: opts.cwd }); if (file === 'git' && args[0] === 'ls-files') return { stdout: '', stderr: '', code: 1 }; if (file === 'git' && args[0] === 'grep') return { stdout: '', stderr: '', code: 1 }; if (file === 'git' && args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) return { stdout: '', stderr: '', code: 1 }; return { stdout: '', stderr: '', code: 0 }; });
  const settings = { ...loadSettings('/missing-queue-settings'), queue: { tickSec: 1, checksTimeoutMin: 1 } } as Settings;
  const review = createReview({ store, github, workspace, jev: { shadow: false, async ask() { return { ok: false as const, reason: 'no key' }; } }, settings });
  const queue = createQueue({ store, workspace, github, settings, retry: options.retry, gate: async ({ workerId }) => ({ ok: true, head: store.getWorker(workerId)?.head ?? h1, passed: options.gate ?? true }), prMerge: async ({ number, expectedHead }) => { if (!options.guardReviews) return { ok: true, merged: true }; const reason = await review.guard({ number, expectedHead }); return reason ? { ok: false, reason } : { ok: true, merged: true }; }, exec, now: () => clock });
  return { store, queue, review, calls, setBase: (value: string) => { base = value; }, setClock: (value: Date) => { clock = value; }, heads, supervisor: createSupervisor({ store, settings, hosts: { herdr: {} as never, tmux: {} as never } }) };
}

function rows(d: ReturnType<typeof setup>) {
  const result = d.queue.queue({ project: 'owner/repo' });
  if (!result.ok) throw new Error(result.reason);
  return result.items;
}

test('two PRs on one repository are processed in order, one per tick', async () => {
  const d = setup();
  try {
    await d.queue.enqueue({ number: 1 }); await d.queue.enqueue({ number: 2 });
    await d.queue.tick();
    assert.equal(rows(d)[0]?.state, 'merged');
    assert.equal(rows(d)[1]?.state, 'queued');
    await d.queue.tick();
    assert.equal(rows(d)[1]?.state, 'merged');
  } finally { d.store.close(); }
});

test('queue number-only calls refuse ambiguity and project selects the requested repository', async () => {
  const d = setup();
  try {
    const source = d.store.getWorker('w-1')!;
    const other = { ...source, workerId: 'w-other', repoSlug: 'owner/other', branch: 'helm/other', worktree: '/other' };
    d.store.insertWorker(other);
    d.store.insertPr({ repoSlug: other.repoSlug, number: 1, workerId: other.workerId, url: 'https://example.invalid/owner/other/1', head: h1, createdAt: other.createdAt });
    assert.deepEqual(await d.queue.enqueue({ number: 1 }), { ok: false, reason: 'PR #1 is ambiguous across repos: owner/other, owner/repo; pass project' });
    assert.equal((await d.queue.enqueue({ project: 'owner/repo', number: 1 })).ok, true);
    assert.deepEqual(d.queue.dequeue({ project: 'owner/repo', number: 1 }), { ok: true, dequeued: true });
  } finally { d.store.close(); }
});

test('a base move with an unchanged patch id carries approval forward', async () => {
  const d = setup({ mergeHead: h3, patchIds: { [`base:${h1}`]: 'p', [`base-2:${h3}`]: 'p' } });
  try { await d.queue.enqueue({ number: 1 }); d.setBase('base-2'); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'merged'); assert.ok(d.calls.some((call) => call.file === 'git' && call.args[0] === 'merge')); }
  finally { d.store.close(); }
});

test('a changed interdiff enters review and emits queue.review', async () => {
  const d = setup({ mergeHead: h3, guardReviews: true, patchIds: { [`base:h1`]: 'old', [`base-2:${h3}`]: 'new' } });
  d.supervisor.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner/repo' });
  try { await d.queue.enqueue({ number: 1 }); d.setBase('base-2'); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'review'); await d.supervisor.consume(); const wakes = d.supervisor.wakes({ project: 'owner/repo', ack: false }); assert.equal(wakes.ok && wakes.wakes[0]?.kind, 'queue.review'); }
  finally { d.store.close(); }
});

test('a red gate fails the item and emits queue.failed', async () => {
  const d = setup({ gate: false }); d.supervisor.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner/repo' });
  try { await d.queue.enqueue({ number: 1 }); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'failed'); await d.supervisor.consume(); const wakes = d.supervisor.wakes({ project: 'owner/repo', ack: false }); assert.equal(wakes.ok && wakes.wakes[0]?.kind, 'queue.failed'); }
  finally { d.store.close(); }
});

test('a merge conflict enters conflict and emits a wake, without force or rebase', async () => {
  const d = setup({ exec: async (file, args, opts) => { d.calls.push({ file, args, cwd: opts.cwd }); if (file === 'git' && args[0] === 'merge') throw Object.assign(new Error('merge failed'), { stdout: 'CONFLICT (content): conflict.txt', code: 1 }); if (file === 'git' && args[0] === 'diff') return { stdout: 'conflict.txt\n', stderr: '', code: 0 }; return { stdout: '', stderr: '', code: 0 }; } });
  d.heads.set(1, h3);
  d.supervisor.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner/repo' });
  try { await d.queue.enqueue({ number: 1 }); d.setBase('base-2'); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'conflict'); assert.equal(rows(d)[0]?.head, h3); assert.equal(d.store.listEvents('w-1').find((event) => event.kind === 'conflict')?.data.head, h3); assert.ok(d.calls.some((call) => call.args.includes('--no-commit'))); assert.equal(d.calls.some((call) => call.args.includes('--force') || call.args.includes('rebase')), false); await d.supervisor.consume(); const wakes = d.supervisor.wakes({ project: 'owner/repo', ack: false }); assert.equal(wakes.ok && wakes.wakes[0]?.kind, 'queue.failed'); }
  finally { d.store.close(); }
});

test('a conflict retries the original worker and a clean unchanged fix merges without re-review', async () => {
  const retryCalls: Array<{ workerId: string; kind: 'conflict' }> = [];
  const d = setup({ guardReviews: true, retry: async (input) => { retryCalls.push(input); return { ok: true, turn: 2, message: 'retry sent' }; }, exec: async (file, args, opts) => { d.calls.push({ file, args, cwd: opts.cwd }); if (file === 'git' && args[0] === 'merge') return { stdout: '', stderr: 'CONFLICT', code: 1 }; if (file === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) return { stdout: 'conflict.txt\n', stderr: '', code: 0 }; if (file === 'git' && args[0] === 'ls-files') return { stdout: '', stderr: '', code: 1 }; if (file === 'git' && args[0] === 'grep') return { stdout: '', stderr: '', code: 1 }; if (file === 'git' && args[0] === 'rev-parse') return { stdout: '', stderr: '', code: 1 }; return { stdout: '', stderr: '', code: 0 }; } });
  try {
    await d.queue.enqueue({ number: 1 });
    await d.review.record({ number: 1, head: h1, commentUrl: 'https://example.invalid/pr/1#issuecomment-1', reviewer: 'claude-sonnet', verdict: 'approve' });
    d.setBase('base-2'); await d.queue.tick();
    assert.deepEqual(retryCalls, [{ workerId: 'w-1', kind: 'conflict' }]); const conflict = d.store.listEvents('w-1').find((event) => event.kind === 'conflict'); assert.deepEqual(conflict?.data.files, ['conflict.txt']); assert.equal(rows(d)[0]?.state, 'updating'); assert.equal(rows(d)[0]?.reason, 'conflict retry sent');
    d.store.updateWorker('w-1', { head: h3, state: 'succeeded' }); d.heads.set(1, h3); await d.queue.tick();
    assert.equal(rows(d)[0]?.state, 'merged');
  } finally { d.store.close(); }
});

test('trailing whitespace and markdown separators do not trigger a conflict retry', async () => {
  let retries = 0;
  const d = setup({ guardReviews: true, retry: async () => { retries += 1; return { ok: true, turn: retries, message: 'retry sent' }; }, exec: async (file, args, opts) => { d.calls.push({ file, args, cwd: opts.cwd }); if (file === 'git' && args[0] === 'merge') return { stdout: '', stderr: 'CONFLICT', code: 1 }; if (file === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) return { stdout: 'conflict.txt\n', stderr: '', code: 0 }; if (file === 'git' && args[0] === 'diff' && args[1] === '--check') return { stdout: 'README.md:2: trailing whitespace\nREADME.md:5:=======', stderr: '', code: 2 }; if (file === 'git' && args[0] === 'ls-files') return { stdout: '', stderr: '', code: 1 }; if (file === 'git' && args[0] === 'grep') return { stdout: '', stderr: '', code: 1 }; if (file === 'git' && args[0] === 'rev-parse') return { stdout: '', stderr: '', code: 1 }; return { stdout: '', stderr: '', code: 0 }; } });
  try { await d.queue.enqueue({ number: 1 }); await d.review.record({ number: 1, head: h1, commentUrl: 'https://example.invalid/pr/1#issuecomment-3', reviewer: 'claude-sonnet', verdict: 'approve' }); d.setBase('base-2'); await d.queue.tick(); d.store.updateWorker('w-1', { head: h3, state: 'succeeded' }); d.heads.set(1, h3); await d.queue.tick(); assert.equal(retries, 1); assert.equal(rows(d)[0]?.state, 'merged'); assert.equal(d.calls.some((call) => call.args.includes('--check')), false); }
  finally { d.store.close(); }
});

test('leftover conflict markers trigger one second retry, then conflict and a wake', async () => {
  let retries = 0;
  const worktree = mkdtempSync(join(tmpdir(), 'helm-queue-git-'));
  execFileSync('git', ['init', '-q'], { cwd: worktree }); execFileSync('git', ['config', 'user.email', 'helm@example.invalid'], { cwd: worktree }); execFileSync('git', ['config', 'user.name', 'Helm Test'], { cwd: worktree });
  writeFileSync(join(worktree, 'conflict.txt'), '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n'); execFileSync('git', ['add', 'conflict.txt'], { cwd: worktree }); execFileSync('git', ['commit', '-qm', 'marker'], { cwd: worktree });
  const markerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
  const d = setup({ worktree, mergeHead: markerHead, retry: async () => { retries += 1; return { ok: true, turn: retries, message: 'retry sent' }; }, exec: async (file, args, opts) => { d.calls.push({ file, args, cwd: opts.cwd }); if (file === 'git' && args[0] === 'merge') return { stdout: '', stderr: 'CONFLICT', code: 1 }; if (file === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) return { stdout: 'conflict.txt\n', stderr: '', code: 0 }; if (file === 'git' && args[0] === 'merge-base') return { stdout: '', stderr: '', code: 0 }; if (file === 'git' && args[0] === 'rev-parse') return { stdout: '', stderr: '', code: 1 }; if (file === 'git' && (args[0] === 'ls-files' || args[0] === 'grep')) { try { return { stdout: execFileSync(file, args, { cwd: opts.cwd, encoding: 'utf8' }), stderr: '', code: 0 }; } catch (error) { const failure = error as { stdout?: string; stderr?: string; status?: number }; return { stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? ''), code: Number(failure.status ?? 1) }; } } return { stdout: '', stderr: '', code: 0 }; } });
  d.supervisor.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner/repo' });
  try { await d.queue.enqueue({ number: 1 }); d.setBase('base-2'); await d.queue.tick(); d.store.updateWorker('w-1', { head: h3, state: 'succeeded' }); d.heads.set(1, h3); await d.queue.tick(); assert.equal(retries, 2); assert.equal(rows(d)[0]?.state, 'updating'); assert.deepEqual(d.store.listEvents('w-1').filter((event) => event.kind === 'conflict').at(-1)?.data.files, ['conflict.txt']); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'conflict'); await d.supervisor.consume(); const wakes = d.supervisor.wakes({ project: 'owner/repo', ack: false }); assert.equal(wakes.ok && wakes.wakes[0]?.kind, 'queue.failed'); }
  finally { d.store.close(); }
});

test('an aborted merge or leftover MERGE_HEAD triggers a second retry then conflict', async () => {
  for (const mode of ['aborted', 'merge-head'] as const) {
    let retries = 0;
    const d = setup({ retry: async () => { retries += 1; return { ok: true, turn: retries, message: 'retry sent' }; }, exec: async (file, args, opts) => { d.calls.push({ file, args, cwd: opts.cwd }); if (file === 'git' && args[0] === 'merge') return { stdout: '', stderr: 'CONFLICT', code: 1 }; if (file === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) return { stdout: 'conflict.txt\n', stderr: '', code: 0 }; if (file === 'git' && args[0] === 'merge-base') return { stdout: '', stderr: '', code: mode === 'aborted' ? 1 : 0 }; if (file === 'git' && args[0] === 'rev-parse') return { stdout: mode === 'merge-head' ? 'other\n' : '', stderr: '', code: mode === 'merge-head' ? 0 : 1 }; return { stdout: '', stderr: '', code: 0 }; } });
    d.supervisor.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner/repo' });
    try { await d.queue.enqueue({ number: 1 }); d.setBase('base-2'); await d.queue.tick(); d.store.updateWorker('w-1', { head: h3, state: 'succeeded' }); d.heads.set(1, h3); await d.queue.tick(); assert.equal(retries, 2); assert.equal(rows(d)[0]?.state, 'updating'); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'conflict'); await d.supervisor.consume(); const wakes = d.supervisor.wakes({ project: 'owner/repo', ack: false }); assert.equal(wakes.ok && wakes.wakes[0]?.kind, 'queue.failed'); }
    finally { d.store.close(); }
  }
});

test('a changed conflict fix requires approval at the new head, and missing or stopped workers wake as conflict', async () => {
  const d = setup({ guardReviews: true, patchIds: { [`base:h1`]: 'old', [`base-2:${h3}`]: 'new' }, retry: async () => ({ ok: true, turn: 1, message: 'retry sent' }), exec: async (file, args, opts) => { d.calls.push({ file, args, cwd: opts.cwd }); if (file === 'git' && args[0] === 'merge') return { stdout: '', stderr: 'CONFLICT', code: 1 }; if (file === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) return { stdout: 'conflict.txt\n', stderr: '', code: 0 }; if (file === 'git' && args[0] === 'ls-files') return { stdout: '', stderr: '', code: 1 }; if (file === 'git' && args[0] === 'grep') return { stdout: '', stderr: '', code: 1 }; if (file === 'git' && args[0] === 'rev-parse') return { stdout: '', stderr: '', code: 1 }; return { stdout: '', stderr: '', code: 0 }; } });
  try { await d.queue.enqueue({ number: 1 }); d.setBase('base-2'); await d.queue.tick(); d.store.updateWorker('w-1', { head: h3, state: 'succeeded' }); d.heads.set(1, h3); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'review'); await d.review.record({ number: 1, head: h3, commentUrl: 'https://example.invalid/pr/1#issuecomment-2', reviewer: 'claude-sonnet', verdict: 'approve' }); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'merged'); }
  finally { d.store.close(); }

  for (const options of [{ missingWorktree: true }, { workerState: 'stopped' as const }]) {
    const d2 = setup({ ...options, retry: async () => ({ ok: true, turn: 1, message: 'retry sent' }), exec: async (file, args, opts) => { d2.calls.push({ file, args, cwd: opts.cwd }); if (file === 'git' && args[0] === 'merge') return { stdout: '', stderr: 'CONFLICT', code: 1 }; if (file === 'git' && args[0] === 'diff' && args.includes('--diff-filter=U')) return { stdout: 'conflict.txt\n', stderr: '', code: 0 }; return { stdout: '', stderr: '', code: 0 }; } });
    d2.supervisor.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner/repo' });
    try { await d2.queue.enqueue({ number: 1 }); d2.setBase('base-2'); await d2.queue.tick(); assert.equal(rows(d2)[0]?.state, 'conflict'); await d2.supervisor.consume(); const wakes = d2.supervisor.wakes({ project: 'owner/repo', ack: false }); assert.equal(wakes.ok && wakes.wakes[0]?.kind, 'queue.failed'); }
    finally { d2.store.close(); }
  }
});

test('review waits for review.record approval, then merges on a later tick', async () => {
  const d = setup({ mergeHead: h3, guardReviews: true, patchIds: { [`base:h1`]: 'old', [`base-2:${h3}`]: 'new' } });
  try {
    await d.queue.enqueue({ number: 1 }); d.setBase('base-2'); await d.queue.tick();
    assert.equal(rows(d)[0]?.state, 'review');
    await d.review.record({ number: 1, head: h3, commentUrl: 'https://example.invalid/pr/1#issuecomment-1', reviewer: 'claude-sonnet', verdict: 'approve' });
    await d.queue.tick();
    assert.equal(rows(d)[0]?.state, 'merged');
  } finally { d.store.close(); }
});

test('a review row does not block the next item on its repository', async () => {
  const d = setup({ mergeHead: h3, guardReviews: true, patchIds: { [`base:h1`]: 'old', [`base-2:${h3}`]: 'new' } });
  try { await d.queue.enqueue({ number: 1 }); await d.queue.enqueue({ number: 2 }); d.setBase('base-2'); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'review'); await d.queue.tick(); assert.notEqual(rows(d)[1]?.state, 'queued'); }
  finally { d.store.close(); }
});

test('failed and conflict items requeue, while merged items refuse enqueue and dequeue works for non-merged rows', async () => {
  const d = setup({ gate: false });
  try {
    await d.queue.enqueue({ number: 1 }); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'failed');
    const requeued = await d.queue.enqueue({ number: 1 }); assert.equal(requeued.ok, true); assert.equal(rows(d)[0]?.state, 'queued');
    assert.deepEqual(d.queue.dequeue({ number: 1 }), { ok: true, dequeued: true });
    const merged = await setup(); try { await merged.queue.enqueue({ number: 1 }); await merged.queue.tick(); assert.deepEqual(await merged.queue.enqueue({ number: 1 }), { ok: false, reason: 'already merged' }); assert.deepEqual(merged.queue.dequeue({ number: 1 }), { ok: false, reason: 'already merged' }); } finally { merged.store.close(); }
  } finally { d.store.close(); }
});

test('fetch, unknown mergeability, and checks API errors fail only on the third consecutive tick', async () => {
  for (const option of [{ fetchError: true }, { mergeable: null }, { statusError: true }]) {
    const d = setup(option);
    try { await d.queue.enqueue({ number: 1 }); await d.queue.tick(); assert.notEqual(rows(d)[0]?.state, 'failed'); await d.queue.tick(); assert.notEqual(rows(d)[0]?.state, 'failed'); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'failed'); }
    finally { d.store.close(); }
  }
});

test('an already merged PR is recovered as merged when the queue reaches it', async () => {
  const d = setup({ merged: true });
  try { await d.queue.enqueue({ number: 1 }); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'merged'); }
  finally { d.store.close(); }
});

test('pending checks time out across ticks', async () => {
  const d = setup({ pending: true });
  try { await d.queue.enqueue({ number: 1 }); await d.queue.tick(); d.setClock(new Date('2026-01-01T00:02:00.000Z')); await d.queue.tick(); const row = rows(d)[0]!; assert.equal(row.state, 'failed'); assert.match(row.reason!, /timeout/); }
  finally { d.store.close(); }
});
