import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore } from '../src/store.js';
import type { WorkerRow } from '../src/types.js';

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'helm-store-'));
  return { dir, path: join(dir, 'helm.sqlite') };
}

function makeWorker(overrides: Partial<WorkerRow> = {}): WorkerRow {
  const now = new Date().toISOString();
  return {
    workerId: 'w-00000001',
    repo: '/tmp/repo',
    repoSlug: 'owner/repo',
    role: 'builder',
    model: 'test/model',
    objective: 'do the thing',
    acceptance: null,
    contextPaths: [],
    allowWorkflows: false,
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    branch: 'helm/w-00000001',
    worktree: '/tmp/repo/worktrees/w-00000001',
    state: 'queued',
    head: null,
    sessionFile: null,
    result: null,
    rawResultText: null,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('contextPaths and allowWorkflows round-trip through insert and update', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-store-'));
  const store = openStore(join(dir, 'helm.sqlite'));
  try {
    store.insertWorker(makeWorker({ workerId: 'w-ctx', contextPaths: ['docs/a.md', 'src'], allowWorkflows: true }));
    assert.deepEqual(store.getWorker('w-ctx')?.contextPaths, ['docs/a.md', 'src']);
    assert.equal(store.getWorker('w-ctx')?.allowWorkflows, true);
    store.updateWorker('w-ctx', { contextPaths: ['only.md'], allowWorkflows: false });
    assert.deepEqual(store.getWorker('w-ctx')?.contextPaths, ['only.md']);
    assert.equal(store.getWorker('w-ctx')?.allowWorkflows, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('insert, get, update a worker', () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    const row = makeWorker();
    store.insertWorker(row);
    const fetched = store.getWorker(row.workerId);
    assert.ok(fetched);
    assert.equal(fetched?.objective, 'do the thing');
    assert.equal(fetched?.result, null);

    store.updateWorker(row.workerId, { state: 'running', head: 'b'.repeat(40) });
    const updated = store.getWorker(row.workerId);
    assert.equal(updated?.state, 'running');
    assert.equal(updated?.head, 'b'.repeat(40));

    store.updateWorker(row.workerId, {
      result: { status: 'succeeded', summary: 'done', changedFiles: ['a.ts'], commandsRun: ['npm test'] },
    });
    const withResult = store.getWorker(row.workerId);
    assert.deepEqual(withResult?.result, { status: 'succeeded', summary: 'done', changedFiles: ['a.ts'], commandsRun: ['npm test'] });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateWorker always refreshes updatedAt unless the patch supplies its own (F14)', async () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    const row = makeWorker({ workerId: 'w-touch' });
    store.insertWorker(row);
    const before = store.getWorker('w-touch')?.updatedAt;
    assert.equal(before, row.updatedAt);

    // Wait long enough that a fresh ISO timestamp is guaranteed to differ.
    await new Promise((r) => setTimeout(r, 10));
    // A patch that touches nothing timestamp-related should still bump updatedAt.
    store.updateWorker('w-touch', { state: 'running' });
    const afterStateChange = store.getWorker('w-touch')?.updatedAt;
    assert.ok(afterStateChange && afterStateChange > (before ?? ''), 'updatedAt should advance on any patch');

    // An explicit updatedAt in the patch is respected as-is.
    const explicit = new Date(0).toISOString();
    store.updateWorker('w-touch', { state: 'idle', updatedAt: explicit });
    assert.equal(store.getWorker('w-touch')?.updatedAt, explicit);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listWorkers filters by repo and state', () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    store.insertWorker(makeWorker({ workerId: 'w-1', repo: '/repo/a', state: 'queued' }));
    store.insertWorker(makeWorker({ workerId: 'w-2', repo: '/repo/a', state: 'running' }));
    store.insertWorker(makeWorker({ workerId: 'w-3', repo: '/repo/b', state: 'running' }));

    assert.equal(store.listWorkers().length, 3);
    assert.equal(store.listWorkers({ repo: '/repo/a' }).length, 2);
    assert.equal(store.listWorkers({ state: 'running' }).length, 2);
    assert.equal(store.listWorkers({ repo: '/repo/a', state: 'running' }).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('idempotency key: repeat spawn returns the existing worker', () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    const row = makeWorker({ workerId: 'w-idem', idempotencyKey: 'key-1' });
    store.insertWorker(row);
    const found = store.findByIdempotencyKey('key-1');
    assert.equal(found?.workerId, 'w-idem');
    assert.equal(store.findByIdempotencyKey('missing'), undefined);
    // A second insert with the same idempotency key must be rejected by the unique index,
    // so callers are expected to check findByIdempotencyKey first.
    assert.throws(() => store.insertWorker(makeWorker({ workerId: 'w-other', idempotencyKey: 'key-1' })));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('events append in order and seq is monotonic', () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    store.insertWorker(makeWorker({ workerId: 'w-events' }));
    const e1 = store.appendEvent('w-events', 'spawned', { model: 'test/model' });
    const e2 = store.appendEvent('w-events', 'turn.start', { message: 'go' });
    const e3 = store.appendEvent('w-events', 'turn.end');
    assert.ok(e1.seq < e2.seq && e2.seq < e3.seq);

    const all = store.listEvents('w-events');
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((event) => event.kind), ['spawned', 'turn.start', 'turn.end']);
    assert.deepEqual(all[0]?.data, { model: 'test/model' });

    const afterFirst = store.listEvents('w-events', { afterSeq: e1.seq });
    assert.equal(afterFirst.length, 2);
    assert.equal(afterFirst[0]?.kind, 'turn.start');

    const limited = store.listEvents('w-events', { limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.kind, 'spawned');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markInterrupted flips running workers and appends a state event', () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    store.insertWorker(makeWorker({ workerId: 'w-run-1', state: 'running' }));
    store.insertWorker(makeWorker({ workerId: 'w-run-2', state: 'running' }));
    store.insertWorker(makeWorker({ workerId: 'w-idle', state: 'idle' }));

    const affected = store.markInterrupted();
    assert.deepEqual(affected.sort(), ['w-run-1', 'w-run-2']);

    assert.equal(store.getWorker('w-run-1')?.state, 'interrupted');
    assert.equal(store.getWorker('w-run-2')?.state, 'interrupted');
    assert.equal(store.getWorker('w-idle')?.state, 'idle');

    const events1 = store.listEvents('w-run-1');
    assert.equal(events1.length, 1);
    assert.equal(events1[0]?.kind, 'state');
    assert.deepEqual(events1[0]?.data, { from: 'running', to: 'interrupted' });

    // Second call is a no-op: nothing left running.
    assert.deepEqual(store.markInterrupted(), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spendFor and spendTotal sum tokens and cost, counting null cost as unknown', () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    store.insertWorker(makeWorker({ workerId: 'w-spend-1' }));
    store.insertWorker(makeWorker({ workerId: 'w-spend-2' }));
    const at = new Date().toISOString();
    store.addSpend({ workerId: 'w-spend-1', model: 'm1', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, at });
    store.addSpend({ workerId: 'w-spend-1', model: 'm1', inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, costUsd: null, at });
    store.addSpend({ workerId: 'w-spend-2', model: 'm2', inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02, at });

    const s1 = store.spendFor('w-spend-1');
    assert.equal(s1.spendUsd, 0.01);
    assert.equal(s1.unknownCostEvents, 1);
    assert.deepEqual(s1.tokens, { input: 110, output: 55, cacheRead: 1, cacheWrite: 2 });

    const total = store.spendTotal();
    assert.ok(Math.abs(total.spendUsd - 0.03) < 1e-9);
    assert.equal(total.unknownCostEvents, 1);
    assert.deepEqual(total.tokens, { input: 310, output: 155, cacheRead: 1, cacheWrite: 2 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gates and prs round-trip', () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    store.insertWorker(makeWorker({ workerId: 'w-gate' }));
    store.insertGate({
      gateId: 'g-1',
      workerId: 'w-gate',
      head: 'a'.repeat(40),
      passed: true,
      checks: [{ name: 'test', command: 'npm test', exitCode: 0, outputPath: '/tmp/test.log', durationMs: 42 }],
      at: new Date().toISOString(),
    });
    const gates = store.listGates('w-gate');
    assert.equal(gates.length, 1);
    assert.equal(gates[0]?.passed, true);
    assert.equal(gates[0]?.checks[0]?.name, 'test');

    store.insertPr({ number: 7, workerId: 'w-gate', url: 'https://github.com/o/r/pull/7', head: 'a'.repeat(40), createdAt: new Date().toISOString() });
    assert.equal(store.getPrByWorker('w-gate')?.number, 7);
    assert.equal(store.getPrByNumber(7)?.workerId, 'w-gate');
    assert.equal(store.getPrByNumber(999), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listAllEvents spans workers, ascends by seq, and honors afterSeq and limit', () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    store.insertWorker(makeWorker({ workerId: 'w-a' }));
    store.insertWorker(makeWorker({ workerId: 'w-b', branch: 'helm/w-b', worktree: '/tmp/repo/worktrees/w-b' }));
    store.appendEvent('w-a', 'spawned');
    store.appendEvent('w-b', 'spawned');
    store.appendEvent('w-a', 'turn.start', { message: 'go' });
    store.appendEvent('w-b', 'tool.call', { tool: 'bash' });
    store.appendEvent('w-a', 'result', { status: 'succeeded' });

    const all = store.listAllEvents();
    assert.deepEqual(all.map((e) => [e.seq, e.workerId]), [[1, 'w-a'], [2, 'w-b'], [3, 'w-a'], [4, 'w-b'], [5, 'w-a']]);
    assert.deepEqual(all[3]?.data, { tool: 'bash' });

    assert.deepEqual(store.listAllEvents({ afterSeq: 2 }).map((e) => e.seq), [3, 4, 5]);
    assert.deepEqual(store.listAllEvents({ limit: 2 }).map((e) => e.seq), [1, 2]);
    assert.deepEqual(store.listAllEvents({ afterSeq: 1, limit: 2 }).map((e) => e.seq), [2, 3]);
    assert.deepEqual(store.listAllEvents({ afterSeq: 5 }), []);
    assert.equal(store.listAllEvents({ limit: 5000 }).length, 5, 'an oversized limit is capped, not rejected');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spendSeries returns the last N rows ascending by at, keeping null cost', () => {
  const { dir, path } = tempDbPath();
  const store = openStore(path);
  try {
    const base = { workerId: 'w-1', model: 'test/model', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // Inserted out of time order on purpose: the series must sort by `at`, not by insertion.
    store.addSpend({ ...base, costUsd: 0.3, at: '2026-01-01T00:00:03.000Z' });
    store.addSpend({ ...base, costUsd: 0.1, at: '2026-01-01T00:00:01.000Z' });
    store.addSpend({ ...base, costUsd: null, at: '2026-01-01T00:00:02.000Z' });
    store.addSpend({ ...base, costUsd: 0.4, at: '2026-01-01T00:00:04.000Z' });

    const all = store.spendSeries(10);
    assert.deepEqual(all.map((p) => p.at.slice(17, 19)), ['01', '02', '03', '04']);
    assert.deepEqual(all.map((p) => p.costUsd), [0.1, null, 0.3, 0.4]);

    const lastTwo = store.spendSeries(2);
    assert.deepEqual(lastTwo.map((p) => p.costUsd), [0.3, 0.4], 'limit keeps the newest rows');
    assert.deepEqual(store.spendSeries(0), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
