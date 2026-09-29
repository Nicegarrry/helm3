import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../src/store.js';
import { createWatcher } from '../src/watch.js';
import type { WorkerRow } from '../src/types.js';

function worker(state: WorkerRow['state'] = 'running'): WorkerRow {
  const at = new Date(0).toISOString();
  return { workerId: 'w-watch', repo: '/repo', repoSlug: 'o/r', role: 'builder', model: 'm', objective: 'x', acceptance: null,
    contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'a'.repeat(40), branch: 'b', worktree: '/repo/w', state,
    head: null, sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: at, updatedAt: at };
}

const settings = { watch: { tickSec: 60, silenceMin: 15, sameRefusal: 3, attentionEverySec: 180, cooldownMin: 15 } };

function append(store: ReturnType<typeof openStore>, clock: Date, kind: string, data: Record<string, unknown> = {}): void {
  store.appendEvent('w-watch', kind, data, clock.toISOString());
}

test('watch rules emit alerts and dedupe with a fake clock', async () => {
  const store = openStore(':memory:');
  try {
    store.insertWorker(worker());
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const tick = createWatcher({ store, settings, now: () => clock });
    append(store, clock, 'turn.start');
    append(store, clock, 'tool.refused', { reason: 'outside worktree' });
    append(store, clock, 'tool.refused', { reason: 'outside worktree' });
    append(store, clock, 'tool.refused', { reason: 'outside worktree' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 1);
    append(store, clock, 'turn.start');
    append(store, clock, 'tool.refused', { reason: 'outside worktree' });
    append(store, clock, 'tool.refused', { reason: 'outside worktree' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 1);
    append(store, clock, 'spend.warning', { spendUsd: 8 });
    append(store, clock, 'result.invalid', { message: 'bad result' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 3);
    append(store, clock, 'error', { message: 'boom' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 4);
    append(store, clock, 'error', { message: 'again' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 4);
    clock = new Date(clock.getTime() + 16 * 60_000);
    append(store, clock, 'error', { message: 'again' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 5);
  } finally { store.close(); }
});

test('silence alerts once per run and never alerts waiting workers', async () => {
  const store = openStore(':memory:');
  try {
    store.insertWorker(worker());
    let clock = new Date('2026-01-01T00:16:00.000Z');
    const tick = createWatcher({ store, settings, now: () => clock });
    append(store, new Date(clock.getTime() - 16 * 60_000), 'turn.start');
    await tick();
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert' && event.data.rule === 'silence').length, 1);
    const restartedTick = createWatcher({ store, settings, now: () => clock });
    await restartedTick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert' && event.data.rule === 'silence').length, 1);
    store.updateWorker('w-watch', { state: 'waiting' as WorkerRow['state'] });
    clock = new Date(clock.getTime() + 16 * 60_000);
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert' && event.data.rule === 'silence').length, 1);
  } finally { store.close(); }
});
