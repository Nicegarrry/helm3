import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueue, type QueueExec } from '../src/queue.js';
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

function setup(options: { gate?: boolean; mergeHead?: string; patchIds?: Record<string, string>; exec?: QueueExec; pending?: boolean } = {}) {
  const store = openStore(':memory:');
  const workers = [worker('w-1', 1, h1), worker('w-2', 2, h2)];
  for (const row of workers) { store.insertWorker(row); store.insertPr({ number: Number(row.workerId.slice(-1)), workerId: row.workerId, url: `https://example.invalid/${row.workerId}`, head: row.head!, createdAt: row.createdAt }); }
  let base = 'base';
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const heads = new Map<number, string>([[1, h1], [2, h2]]);
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  const workspace: Workspace = {
    async fetch() {}, async patchId(_repo, patchBase, head) { return options.patchIds?.[`${patchBase}:${head}`] ?? 'same'; },
    async commitAll() { const head = options.mergeHead ?? h3; heads.set(1, head); return head; },
    async push() {}, async head() { return h1; }, async isClean() { return true; }, async diffStat() { return ''; },
    async resolveSha() { return base; }, async defaultBranch() { return 'main'; }, async create(_repo, path, branch, baseSha) { return { path, branch, baseSha }; }, async remove() {}, async clone() {},
  } as Workspace;
  const github: GitHub = {
    async prStatus(_repo, number): Promise<PrStatus> { return { number, state: 'open', head: heads.get(number)!, mergeable: true, draft: false, checks: options.pending ? [{ name: 'ci', status: 'pending', conclusion: null }] : [], reviews: [], url: 'https://example.invalid/pr' }; },
    async openPr() { return { number: 1, url: 'https://example.invalid/pr' }; }, async comment() { return { body: '' }; }, async postComment() {}, async merge() {},
  };
  const exec: QueueExec = options.exec ?? (async (file, args, opts) => { calls.push({ file, args, cwd: opts.cwd }); return { stdout: '', stderr: '', code: 0 }; });
  const settings = { ...loadSettings('/missing-queue-settings'), queue: { tickSec: 1, checksTimeoutMin: 1 } } as Settings;
  const queue = createQueue({ store, workspace, github, settings, gate: async ({ workerId }) => ({ ok: true, head: store.getWorker(workerId)?.head ?? h1, passed: options.gate ?? true }), prMerge: async ({ number }) => ({ ok: true, merged: true, number } as never), exec, now: () => clock });
  return { store, queue, calls, setBase: (value: string) => { base = value; }, setClock: (value: Date) => { clock = value; }, heads, supervisor: createSupervisor({ store, settings, hosts: { herdr: {} as never, tmux: {} as never } }) };
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
  const d = setup({ mergeHead: h3, patchIds: { [`base:h1`]: 'old', [`base-2:${h3}`]: 'new' } });
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
  const d = setup({ exec: async (file, args, opts) => { d.calls.push({ file, args, cwd: opts.cwd }); return file === 'git' ? { stdout: '', stderr: 'conflict', code: 1 } : { stdout: '', stderr: '', code: 0 }; } });
  d.supervisor.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner/repo' });
  try { await d.queue.enqueue({ number: 1 }); d.setBase('base-2'); await d.queue.tick(); assert.equal(rows(d)[0]?.state, 'conflict'); assert.equal(d.calls.some((call) => call.args.includes('--force') || call.args.includes('rebase')), false); await d.supervisor.consume(); const wakes = d.supervisor.wakes({ project: 'owner/repo', ack: false }); assert.equal(wakes.ok && wakes.wakes[0]?.kind, 'queue.failed'); }
  finally { d.store.close(); }
});

test('pending checks time out across ticks', async () => {
  const d = setup({ pending: true });
  try { await d.queue.enqueue({ number: 1 }); await d.queue.tick(); d.setClock(new Date('2026-01-01T00:02:00.000Z')); await d.queue.tick(); const row = rows(d)[0]!; assert.equal(row.state, 'failed'); assert.match(row.reason!, /timeout/); }
  finally { d.store.close(); }
});
