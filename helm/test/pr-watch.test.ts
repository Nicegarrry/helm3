import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrTicker } from '../src/pr-watch.js';
import { openStore } from '../src/store.js';
import type { GitHub, WorkerRow } from '../src/types.js';

function makeWorker(workerId: string, repoSlug = 'o/r'): WorkerRow {
  return {
    workerId, repo: '/tmp/repo', repoSlug, role: 'builder', model: 'codex/model', objective: 'task', acceptance: null,
    contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'base', branch: `helm/${workerId}`, worktree: `/tmp/${workerId}`, state: 'succeeded', head: 'old', sessionFile: null,
    result: null, rawResultText: null, idempotencyKey: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('external PR merges emit once and refresh the stored row', async () => {
  const store = openStore(':memory:');
  try {
    const worker = makeWorker('w-external');
    store.insertWorker(worker);
    store.insertPr({ repoSlug: 'o/r', number: 12, workerId: worker.workerId, url: 'https://github.test/12', head: 'old', createdAt: worker.createdAt });
    let calls = 0;
    const github = { prStatus: async () => { calls += 1; return { number: 12, state: 'merged' as const, head: 'new', mergeable: true, draft: false, checks: [], reviews: [], url: 'https://github.test/12', title: 'Title', base: 'main' }; } } as unknown as GitHub;
    const tick = createPrTicker({ store, github });
    await tick(); await tick();
    assert.equal(calls, 1);
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'pr.merged').length, 1);
    assert.equal(store.getPrByNumber('o/r', 12)?.head, 'new');
    assert.equal(store.getPrByNumber('o/r', 12)?.state, 'merged');
    assert.equal(store.listAllEvents().find((event) => event.kind === 'pr.merged')?.data.external, true);
  } finally { store.close(); }
});

test('external merge does not announce when Helm merged while the GitHub check was in flight', async () => {
  const store = openStore(':memory:');
  try {
    const worker = makeWorker('w-race');
    store.insertWorker(worker);
    store.insertPr({ repoSlug: 'o/r', number: 15, workerId: worker.workerId, url: 'https://github.test/15', head: 'old', createdAt: worker.createdAt });
    let release!: (status: { number: number; state: 'merged'; head: string; mergeable: true; draft: false; checks: never[]; reviews: never[]; url: string }) => void;
    const status = new Promise<{ number: number; state: 'merged'; head: string; mergeable: true; draft: false; checks: never[]; reviews: never[]; url: string }>((resolve) => { release = resolve; });
    const github = { prStatus: async () => status } as unknown as GitHub;
    const tick = createPrTicker({ store, github });
    const pending = tick();
    await new Promise((resolve) => setImmediate(resolve));
    store.updatePr({ ...store.getPrByNumber('o/r', 15)!, state: 'merged', checkedAt: new Date().toISOString() });
    release({ number: 15, state: 'merged', head: 'new', mergeable: true, draft: false, checks: [], reviews: [], url: 'https://github.test/15' });
    await pending;
    assert.equal(store.listAllEvents().some((event) => event.kind === 'pr.merged'), false);
  } finally { store.close(); }
});

test('legacy PR rows are silently backfilled and terminal rows are never polled again', async () => {
  const store = openStore(':memory:');
  try {
    const worker = makeWorker('w-legacy');
    store.insertWorker(worker);
    store.insertPr({ repoSlug: 'o/r', number: 13, workerId: worker.workerId, url: 'https://github.test/13', head: 'old', createdAt: worker.createdAt });
    store.sql.prepare('UPDATE prs SET state = NULL, checkedAt = NULL WHERE repoSlug = ? AND number = ?').run('o/r', 13);
    let calls = 0;
    const github = { prStatus: async () => { calls += 1; return { number: 13, state: 'merged' as const, head: 'new', mergeable: true, draft: false, checks: [], reviews: [], url: 'https://github.test/13' }; } } as unknown as GitHub;
    const tick = createPrTicker({ store, github });
    await tick();
    assert.equal(calls, 1);
    assert.equal(store.getPrByNumber('o/r', 13)?.state, 'merged');
    assert.equal(store.listAllEvents().some((event) => event.kind === 'pr.merged'), false);
    await tick();
    assert.equal(calls, 1);
  } finally { store.close(); }
});

test('PR polling is capped at ten rows and skips rows checked within five minutes', async () => {
  const store = openStore(':memory:');
  try {
    for (let number = 1; number <= 11; number += 1) {
      const worker = makeWorker(`w-${number}`);
      store.insertWorker(worker);
      store.insertPr({ repoSlug: 'o/r', number, workerId: worker.workerId, url: `https://github.test/${number}`, head: 'old', createdAt: worker.createdAt });
    }
    let current = new Date('2026-01-01T00:00:00.000Z');
    const calls: number[] = [];
    const github = { prStatus: async (_repo: string, number: number) => { calls.push(number); return { number, state: 'open' as const, head: 'old', mergeable: true, draft: false, checks: [], reviews: [], url: `https://github.test/${number}` }; } } as unknown as GitHub;
    const tick = createPrTicker({ store, github, now: () => current });
    await tick();
    assert.equal(calls.length, 10);
    current = new Date(current.getTime() + 4 * 60_000);
    await tick();
    assert.equal(calls.length, 11);
    current = new Date(current.getTime() + 1 * 60_000);
    await tick();
    assert.equal(calls.length, 21);
  } finally { store.close(); }
});

test('PR polling backs off after errors', async () => {
  const store = openStore(':memory:');
  try {
    const worker = makeWorker('w-error');
    store.insertWorker(worker);
    store.insertPr({ repoSlug: 'o/r', number: 14, workerId: worker.workerId, url: 'https://github.test/14', head: 'old', createdAt: worker.createdAt });
    let current = new Date('2026-01-01T00:00:00.000Z');
    let calls = 0;
    const github = { prStatus: async () => { calls += 1; throw new Error('temporary'); } } as unknown as GitHub;
    const tick = createPrTicker({ store, github, now: () => current });
    await tick();
    assert.equal(calls, 1);
    await tick();
    assert.equal(calls, 1);
    current = new Date(current.getTime() + 5 * 60_000);
    await tick();
    assert.equal(calls, 2);
    current = new Date(current.getTime() + 5 * 60_000);
    await tick();
    assert.equal(calls, 2);
    current = new Date(current.getTime() + 5 * 60_000);
    await tick();
    assert.equal(calls, 3);
  } finally { store.close(); }
});
