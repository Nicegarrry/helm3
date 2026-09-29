import assert from 'node:assert/strict';
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

function worker(id: string, number: number, head: string): WorkerRow {
  const at = new Date('2026-01-01T00:00:00.000Z').toISOString();
  return { workerId: id, repo: '/repo', repoSlug: 'owner/repo', role: 'builder', model: 'codex/test', objective: `PR ${number}`, acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'base', branch: `helm/${id}`, worktree: `/worktree/${id}`, state: 'succeeded', head, sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: at, updatedAt: at };
}

function setup(options: { gate?: boolean; mergeHead?: string; patchIds?: Record<string, string>; exec?: QueueExec; pending?: boolean; guardReviews?: boolean; fetchError?: boolean; statusError?: boolean; mergeable?: boolean | null; merged?: boolean } = {}) {
  const store = openStore(':memory:');
  const workers = [worker('w-1', 1, h1), worker('w-2', 2, h2)];
  for (const row of workers) { store.insertWorker(row); store.insertPr({ number: Number(row.workerId.slice(-1)), workerId: row.workerId, url: `https://example.invalid/${row.workerId}`, head: row.head!, createdAt: row.createdAt }); }
  let base = 'base';
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const heads = new Map<number, string>([[1, h1], [2, h2]]);
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  const workspace: Workspace = {
    async fetch() { if (options.fetchError) throw new Error('network unavailable'); }, async patchId(_repo, patchBase, head) { return options.patchIds?.[`${patchBase}:${head}`] ?? 'same'; },
    async commitAll(path) { const head = options.mergeHead ?? h3; heads.set(path.endsWith('w-2') ? 2 : 1, head); return head; },
    async push() {}, async head() { return h1; }, async isClean() { return true; }, async diffStat() { return ''; },
    async resolveSha() { return base; }, async defaultBranch() { return 'main'; }, async create(_repo, path, branch, baseSha) { return { path, branch, baseSha }; }, async remove() {}, async clone() {},
  } as Workspace;
  const github: GitHub = {
    async prStatus(_repo, number): Promise<PrStatus> { if (options.statusError) throw new Error('checks service unavailable'); return { number, state: options.merged ? 'merged' : 'open', head: heads.get(number)!, mergeable: options.mergeable === undefined ? true : options.mergeable, draft: false, checks: options.pending ? [{ name: 'ci', status: 'pending', conclusion: null }] : [], reviews: [], url: 'https://example.invalid/pr' }; },
    async openPr() { return { number: 1, url: 'https://example.invalid/pr' }; }, async comment() { return { body: 'APPROVE: ok', issueNumber: 1 }; }, async postComment() {}, async merge() {},
  };
  const exec: QueueExec = options.exec ?? (async (file, args, opts) => { calls.push({ file, args, cwd: opts.cwd }); return { stdout: '', stderr: '', code: 0 }; });
  const settings = { ...loadSettings('/missing-queue-settings'), queue: { tickSec: 1, checksTimeoutMin: 1 } } as Settings;
  const review = createReview({ store, github, workspace, jev: { shadow: false, async ask() { return { ok: false as const, reason: 'no key' }; } }, settings });
  const queue = createQueue({ store, workspace, github, settings, gate: async ({ workerId }) => ({ ok: true, head: store.getWorker(workerId)?.head ?? h1, passed: options.gate ?? true }), prMerge: async ({ number, expectedHead }) => { if (!options.guardReviews) return { ok: true, merged: true }; const reason = await review.guard({ number, expectedHead }); return reason ? { ok: false, reason } : { ok: true, merged: true }; }, exec, now: () => clock });
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
  d.supervisor.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner/repo' });
  try { await d.queue.enqueue({ number: 1 }); d.setBase('base-2'); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'conflict'); assert.equal(d.calls.some((call) => call.args.includes('--force') || call.args.includes('rebase')), false); await d.supervisor.consume(); const wakes = d.supervisor.wakes({ project: 'owner/repo', ack: false }); assert.equal(wakes.ok && wakes.wakes[0]?.kind, 'queue.failed'); }
  finally { d.store.close(); }
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
