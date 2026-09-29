import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../src/store.js';
import { compactEvents, createWatcher } from '../src/watch.js';
import type { Jev } from '../src/jev.js';
import type { EventRow, WorkerRow } from '../src/types.js';

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

test('compacts the attention window into stable worktree-free lines', () => {
  const events: EventRow[] = [
    { seq: 1, workerId: 'w-watch', at: new Date(0).toISOString(), kind: 'tool.call', data: { tool: 'bash', summary: 'git status /repo/w/src' } },
    { seq: 2, workerId: 'w-watch', at: new Date(0).toISOString(), kind: 'tool.refused', data: { tool: 'edit', reason: 'outside /repo/w' } },
    { seq: 3, workerId: 'w-watch', at: new Date(0).toISOString(), kind: 'state', data: { from: 'running', to: 'waiting' } },
    { seq: 4, workerId: 'w-watch', at: new Date(0).toISOString(), kind: 'notice', data: { message: 'checking /repo/w' } },
  ];
  assert.deepEqual(compactEvents(events, '/repo/w'), [
    'call bash: git status <worktree>/src',
    'REFUSED edit: outside <worktree>',
    'state running->waiting',
    'notice: checking <worktree>',
  ]);
});

function attentionJev(shadow: boolean, confidence = 0.45): Jev & { calls: number } {
  const fake = {
    shadow,
    calls: 0,
    async ask() {
      fake.calls += 1;
      return { ok: true as const, answers: { attention: { noul: true, confidence } } };
    },
  };
  return fake;
}

function addAttentionRun(store: ReturnType<typeof openStore>, clock: Date): void {
  append(store, new Date(clock.getTime() - 60_000), 'turn.start');
  for (let index = 0; index < 8; index += 1) append(store, clock, 'tool.call', { tool: 'bash', summary: `step ${index}` });
}

test('attention uses fake Jev, respects shadow mode, and is rate limited', async () => {
  const store = openStore(':memory:');
  try {
    store.insertWorker(worker());
    const jev = attentionJev(true);
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const tick = createWatcher({ store, settings, jev, now: () => clock });
    addAttentionRun(store, clock);
    await tick();
    assert.equal(jev.calls, 1);
    assert.deepEqual(store.listEvents('w-watch').filter((event) => event.kind === 'watch.shadow').map((event) => event.data), [
      { rule: 'jev.attention', attention: 0.45 },
    ]);
    append(store, clock, 'notice', { message: 'more work' });
    await tick();
    assert.equal(jev.calls, 1);
    clock = new Date(clock.getTime() + 181_000);
    append(store, clock, 'tool.call', { tool: 'bash', summary: 'npm test' });
    await tick();
    assert.equal(jev.calls, 2);

    const alertJev = attentionJev(false);
    const alertTick = createWatcher({ store, settings, jev: alertJev, now: () => clock });
    append(store, clock, 'notice', { message: 'alert me' });
    await alertTick();
    assert.deepEqual(store.listEvents('w-watch').filter((event) => event.kind === 'watch.alert' && event.data.rule === 'jev.attention').map((event) => event.data), [
      { rule: 'jev.attention', attention: 0.45 },
    ]);
  } finally { store.close(); }
});
