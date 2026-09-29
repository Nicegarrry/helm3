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

test('watch rules emit alerts and dedupe with a fake clock', async () => {
  const store = openStore(':memory:');
  try {
    store.insertWorker(worker());
    let clock = new Date();
    const tick = createWatcher({ store, settings, now: () => clock });
    store.appendEvent('w-watch', 'turn.start');
    store.appendEvent('w-watch', 'tool.refused', { reason: 'outside worktree' });
    store.appendEvent('w-watch', 'tool.refused', { reason: 'outside worktree' });
    store.appendEvent('w-watch', 'tool.refused', { reason: 'outside worktree' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 1);
    store.appendEvent('w-watch', 'turn.start');
    store.appendEvent('w-watch', 'tool.refused', { reason: 'outside worktree' });
    store.appendEvent('w-watch', 'tool.refused', { reason: 'outside worktree' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 1);
    store.appendEvent('w-watch', 'spend.warning', { spendUsd: 8 });
    store.appendEvent('w-watch', 'result.invalid', { message: 'bad result' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 3);
    store.appendEvent('w-watch', 'error', { message: 'boom' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 4);
    store.appendEvent('w-watch', 'error', { message: 'again' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 4);
    clock = new Date(clock.getTime() + 16 * 60_000);
    store.appendEvent('w-watch', 'error', { message: 'again' });
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert').length, 5);
  } finally { store.close(); }
});

test('silence alerts once per run and never alerts waiting workers', async () => {
  const store = openStore(':memory:');
  try {
    store.insertWorker(worker());
    let clock = new Date(Date.now() + 16 * 60_000);
    const tick = createWatcher({ store, settings, now: () => clock });
    store.appendEvent('w-watch', 'turn.start');
    await tick();
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert' && event.data.rule === 'silence').length, 1);
    store.updateWorker('w-watch', { state: 'waiting' as WorkerRow['state'] });
    clock = new Date(clock.getTime() + 16 * 60_000);
    await tick();
    assert.equal(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert' && event.data.rule === 'silence').length, 1);
  } finally { store.close(); }
});
