import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ghGitHub } from '../src/github.js';
import { createPrTicker, inferPrIssue, recordPrMerge } from '../src/pr-watch.js';
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

const captured = readFileSync(new URL('./fixtures/gh-pr-list.json', import.meta.url), 'utf8');

test('reconcile adopts captured outside PRs, infers issues, and deduplicates across ticks', async () => {
  const store = openStore(':memory:');
  try {
    for (const id of ['w-03d20cc7', 'w-1d04e3fd', 'w-77baf60f']) store.insertWorker(makeWorker(id));
    let current = new Date('2026-10-01T00:00:00Z');
    const github = ghGitHub(async () => ({ stdout: captured, stderr: '', code: 0 }));
    const tick = createPrTicker({ store, github, now: () => current });
    await tick();
    current = new Date(current.getTime() + 5 * 60_000);
    await tick();
    assert.equal(store.listPrs().length, 3);
    assert.equal(store.getMeta('w-03d20cc7')?.issue, 273);
    assert.equal(store.getMeta('w-1d04e3fd')?.issue, 205);
    assert.equal(store.getMeta('w-77baf60f')?.issue ?? null, null);
    assert.equal(store.getPrByNumber('o/r', 277)?.head, JSON.parse(captured)[0].headRefOid);
    const merges = store.listAllEvents().filter((event) => event.kind === 'pr.merged');
    assert.equal(merges.length, 3);
    assert.ok(merges.every((event) => event.data.external === true && event.data.adopted === true));
    assert.equal(store.getPrByNumber('o/r', 272), undefined);
  } finally { store.close(); }
});

test('an adopted open PR emits its later merge once and preserves explicit issue metadata', async () => {
  const store = openStore(':memory:');
  try {
    const remote = JSON.parse(captured)[0];
    store.insertWorker(makeWorker('w-03d20cc7'));
    store.setMeta('w-03d20cc7', { issue: 99, tier: 2 });
    let merged = false;
    let current = new Date('2026-10-01T00:00:00Z');
    // Derive the open lifecycle variant from the captured row; gh uses OPEN and null.
    const github = ghGitHub(async () => ({ stdout: JSON.stringify([{ ...remote, state: merged ? 'MERGED' : 'OPEN', mergedAt: merged ? remote.mergedAt : null }]), stderr: '', code: 0 }));
    const tick = createPrTicker({ store, github, now: () => current });
    await tick();
    assert.equal(store.getPrByNumber('o/r', 277)?.state, 'open');
    assert.equal(store.listAllEvents().length, 0);
    merged = true;
    current = new Date(current.getTime() + 5 * 60_000);
    await tick();
    const pr = store.getPrByNumber('o/r', 277)!;
    recordPrMerge(store, pr, {}); // Helm's merge completion racing with reconciliation.
    current = new Date(current.getTime() + 5 * 60_000);
    await tick();
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'pr.merged').length, 1);
    assert.equal(store.getMeta('w-03d20cc7')?.issue, 99);
    assert.equal(store.getMeta('w-03d20cc7')?.tier, 2);
  } finally { store.close(); }
});

test('issue inference accepts closing keywords only and preserves routing metadata', () => {
  const store = openStore(':memory:');
  try {
    for (const [index, body] of ['Fixes #11', 'resolves #12', 'Closes #13', 'mentions #14'].entries()) {
      const id = `w-infer-${index}`;
      store.insertWorker(makeWorker(id)); store.setMeta(id, { tier: 3 });
      inferPrIssue(store, id, body);
      assert.equal(store.getMeta(id)?.issue, index === 3 ? null : index + 11);
      assert.equal(store.getMeta(id)?.tier, 3);
    }
  } finally { store.close(); }
});

test('reconcile does not count a Helm merge again or adopt another repository worker', async () => {
  const store = openStore(':memory:');
  try {
    store.insertWorker(makeWorker('w-03d20cc7'));
    store.insertWorker(makeWorker('w-1d04e3fd', 'other/repo'));
    const pr = { repoSlug: 'o/r', number: 277, workerId: 'w-03d20cc7', url: 'https://github.com/o/r/pull/277', head: 'head', createdAt: '2026-09-30T00:00:00Z', state: 'merged' as const, checkedAt: null };
    store.insertPr(pr); recordPrMerge(store, pr, {});
    const github = ghGitHub(async (_file, args) => ({ stdout: args.includes('o/r') ? captured : '[]', stderr: '', code: 0 }));
    await createPrTicker({ store, github, now: () => new Date('2026-10-01T00:00:00Z') })();
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'pr.merged').length, 1);
    assert.equal(store.getPrByNumber('o/r', 276), undefined);
    assert.equal(store.getMeta('w-03d20cc7')?.issue, 273);
  } finally { store.close(); }
});

test('discovery leaves checkedAt alone so open Helm PRs are still polled, and baselines null-state rows silently', async () => {
  const store = openStore(':memory:');
  try {
    const remote = JSON.parse(captured)[0];
    for (const id of ['w-03d20cc7', 'w-1d04e3fd']) store.insertWorker(makeWorker(id));
    const legacy = { repoSlug: 'o/r', number: 276, workerId: 'w-1d04e3fd', url: 'https://github.com/o/r/pull/276', head: 'old', createdAt: '2026-09-30T00:00:00Z' };
    store.insertPr(legacy);
    store.sql.prepare('UPDATE prs SET state = NULL, checkedAt = NULL WHERE number = 276').run();
    const listed = ghGitHub(async () => ({ stdout: JSON.stringify([{ ...remote, state: 'OPEN', mergedAt: null }, JSON.parse(captured)[1]]), stderr: '', code: 0 }));
    const polled: number[] = [];
    const github = { ...listed, prStatus: async (_repo: string, number: number) => { polled.push(number); return { number, state: 'open' as const, head: 'h', mergeable: true, draft: false, checks: [], reviews: [], url: `https://github.com/o/r/pull/${number}` }; } } as GitHub;
    const current = new Date('2026-10-01T00:00:00Z');
    await createPrTicker({ store, github, now: () => current })();
    assert.deepEqual(polled, [277]);
    assert.equal(store.getPrByNumber('o/r', 277)?.checkedAt, current.toISOString());
    assert.equal(store.getPrByNumber('o/r', 276)?.state, 'merged');
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'pr.merged').length, 0);
  } finally { store.close(); }
});

test('discovery records pr.merged once when a tracked closed PR is seen merged', async () => {
  const store = openStore(':memory:');
  try {
    store.insertWorker(makeWorker('w-03d20cc7'));
    store.insertPr({ repoSlug: 'o/r', number: 277, workerId: 'w-03d20cc7', url: 'https://github.com/o/r/pull/277', head: 'old', createdAt: '2026-09-30T00:00:00Z', state: 'closed', checkedAt: '2026-09-30T00:00:00Z' });
    const github = ghGitHub(async () => ({ stdout: captured, stderr: '', code: 0 }));
    let current = new Date('2026-10-01T00:00:00Z');
    const tick = createPrTicker({ store, github, now: () => current });
    await tick();
    current = new Date(current.getTime() + 5 * 60_000);
    await tick();
    assert.equal(store.getPrByNumber('o/r', 277)?.state, 'merged');
    const merges = store.listAllEvents().filter((event) => event.kind === 'pr.merged' && event.data.number === 277);
    assert.equal(merges.length, 1);
    assert.equal(merges[0]?.data.adopted, false);
  } finally { store.close(); }
});
