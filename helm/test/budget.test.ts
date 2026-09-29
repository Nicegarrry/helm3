import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../src/store.js';
import { attachWorker, budgetStatus, closeBudget, listBudgetStatuses, openBudget, openBudgetFor } from '../src/budget.js';

function spend(store: ReturnType<typeof openStore>, workerId: string, model: string, costUsd: number, inputTokens = 0, outputTokens = 0): void {
  store.addSpend({ workerId, model, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, at: new Date().toISOString() });
}

test('budgets are independent, rotate on open, and keep worker attribution on the old sprint', () => {
  const store = openStore(':memory:');
  try {
    const first = openBudget(store, { project: 'acme/one', label: 'sprint-1', capUsd: 1, openedAt: '2026-09-29T00:00:00.000Z' });
    const other = openBudget(store, { project: 'acme/two', label: 'sprint-1', capUsd: 1, openedAt: '2026-09-29T00:00:00.000Z' });
    attachWorker(store, 'w-one', first.id);
    attachWorker(store, 'w-two', other.id);
    spend(store, 'w-one', 'pi/model', 0.9);
    spend(store, 'w-two', 'pi/model', 0.1);
    assert.equal(budgetStatus(store, first).spentUsd, 0.9);
    assert.equal(budgetStatus(store, other).spentUsd, 0.1);

    const second = openBudget(store, { project: 'acme/one', label: 'sprint-2', capUsd: 2, openedAt: '2026-09-30T00:00:00.000Z' });
    assert.equal(openBudgetFor(store, 'acme/one')?.id, second.id);
    assert.equal(listBudgetStatuses(store, 'acme/one').find((row) => row.id === first.id)?.closedAt, '2026-09-30T00:00:00.000Z');
    assert.equal(budgetStatus(store, second).spentUsd, 0);
  } finally {
    store.close();
  }
});

test('a Codex token cap exhausts independently of dollar spend', () => {
  const store = openStore(':memory:');
  try {
    const budget = openBudget(store, { project: 'acme/codex', label: 'sprint', capUsd: 10, capCodexTokens: 100, openedAt: new Date().toISOString() });
    attachWorker(store, 'w-codex', budget.id);
    spend(store, 'w-codex', 'codex/gpt-5.6-luna', 0, 60, 40);
    const status = budgetStatus(store, budget);
    assert.equal(status.spentUsd, 0);
    assert.equal(status.spentCodexTokens, 100);
    assert.equal(status.exhausted, true);
  } finally {
    store.close();
  }
});

test('closing an absent budget is a no-op and status keeps closed budgets', () => {
  const store = openStore(':memory:');
  try {
    assert.equal(closeBudget(store, 'missing/project', new Date().toISOString()), undefined);
    const budget = openBudget(store, { project: 'acme/closed', label: 'sprint', capUsd: 1, openedAt: '2026-09-29T00:00:00.000Z' });
    const closed = closeBudget(store, budget.project, '2026-09-29T01:00:00.000Z');
    assert.equal(closed?.closedAt, '2026-09-29T01:00:00.000Z');
    assert.equal(listBudgetStatuses(store, budget.project).length, 1);
  } finally {
    store.close();
  }
});
