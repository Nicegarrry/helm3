/** Per-project and per-sprint spend budgets. The tables are owned by this module. */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './types.js';

export type BudgetRow = Readonly<{
  id: string;
  project: string;
  label: string;
  capUsd: number;
  capCodexTokens: number | null;
  openedAt: string;
  closedAt: string | null;
}>;

export type BudgetStatus = BudgetRow & Readonly<{
  spentUsd: number;
  spentCodexTokens: number;
  remainingUsd: number;
  remainingCodexTokens: number | null;
  workers: string[];
  workerCount: number;
  exhausted: boolean;
  warning: boolean;
}>;

type MemoryState = { budgets: BudgetRow[]; workerBudget: Map<string, string> };
const memory = new WeakMap<object, MemoryState>();

function memoryState(store: Store): MemoryState {
  let state = memory.get(store.sql as unknown as object);
  if (!state) {
    state = { budgets: [], workerBudget: new Map() };
    memory.set(store.sql as unknown as object, state);
  }
  return state;
}

function hasSql(store: Store): store is Store & { sql: DatabaseSync } {
  return typeof (store.sql as unknown as { exec?: unknown }).exec === 'function';
}

export function ensureBudgetTables(store: Store): void {
  if (!hasSql(store)) return;
  store.sql.exec(`
    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      label TEXT NOT NULL,
      capUsd REAL NOT NULL,
      capCodexTokens INTEGER,
      openedAt TEXT NOT NULL,
      closedAt TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS budgets_open_project ON budgets(project) WHERE closedAt IS NULL;
    CREATE TABLE IF NOT EXISTS worker_budget (
      workerId TEXT PRIMARY KEY,
      budgetId TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worker_budget_budget ON worker_budget(budgetId);
  `);
}

function toBudget(row: Record<string, unknown>): BudgetRow {
  return {
    id: row.id as string,
    project: row.project as string,
    label: row.label as string,
    capUsd: Number(row.capUsd),
    capCodexTokens: row.capCodexTokens === null || row.capCodexTokens === undefined ? null : Number(row.capCodexTokens),
    openedAt: row.openedAt as string,
    closedAt: (row.closedAt as string | null) ?? null,
  };
}

function id(): string { return `b-${randomBytes(4).toString('hex')}`; }

export function openBudget(store: Store, input: { project: string; label: string; capUsd: number; capCodexTokens?: number | null; openedAt: string }): BudgetRow {
  ensureBudgetTables(store);
  const budget: BudgetRow = {
    id: id(), project: input.project, label: input.label, capUsd: input.capUsd,
    capCodexTokens: input.capCodexTokens ?? null, openedAt: input.openedAt, closedAt: null,
  };
  if (!hasSql(store)) {
    const state = memoryState(store);
    const now = input.openedAt;
    state.budgets = state.budgets.map((row) => row.project === input.project && row.closedAt === null ? { ...row, closedAt: now } : row);
    state.budgets.push(budget);
    return budget;
  }
  store.sql.exec('BEGIN IMMEDIATE');
  try {
    store.sql.prepare('UPDATE budgets SET closedAt = ? WHERE project = ? AND closedAt IS NULL').run(input.openedAt, input.project);
    store.sql.prepare('INSERT INTO budgets (id, project, label, capUsd, capCodexTokens, openedAt, closedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(budget.id, budget.project, budget.label, budget.capUsd, budget.capCodexTokens, budget.openedAt);
    store.sql.exec('COMMIT');
  } catch (err) {
    try { store.sql.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw err;
  }
  return budget;
}

export function closeBudget(store: Store, project: string, closedAt: string): BudgetRow | undefined {
  ensureBudgetTables(store);
  const current = openBudgetFor(store, project);
  if (!current) return undefined;
  if (!hasSql(store)) {
    const state = memoryState(store);
    const closed = { ...current, closedAt };
    state.budgets = state.budgets.map((row) => row.id === current.id ? closed : row);
    return closed;
  }
  store.sql.prepare('UPDATE budgets SET closedAt = ? WHERE id = ?').run(closedAt, current.id);
  return { ...current, closedAt };
}

export function openBudgetFor(store: Store, project: string): BudgetRow | undefined {
  ensureBudgetTables(store);
  if (!hasSql(store)) return memoryState(store).budgets.find((row) => row.project === project && row.closedAt === null);
  const row = store.sql.prepare('SELECT * FROM budgets WHERE project = ? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1').get(project) as Record<string, unknown> | undefined;
  return row ? toBudget(row) : undefined;
}

export function budgetForWorker(store: Store, workerId: string): BudgetRow | undefined {
  ensureBudgetTables(store);
  if (!hasSql(store)) {
    const budgetId = memoryState(store).workerBudget.get(workerId);
    return budgetId ? budgetById(store, budgetId) : undefined;
  }
  const row = store.sql.prepare('SELECT b.* FROM worker_budget wb JOIN budgets b ON b.id = wb.budgetId WHERE wb.workerId = ?').get(workerId) as Record<string, unknown> | undefined;
  return row ? toBudget(row) : undefined;
}

export function attachWorker(store: Store, workerId: string, budgetId: string): void {
  ensureBudgetTables(store);
  if (!hasSql(store)) {
    memoryState(store).workerBudget.set(workerId, budgetId);
    return;
  }
  store.sql.prepare('INSERT INTO worker_budget (workerId, budgetId) VALUES (?, ?) ON CONFLICT(workerId) DO UPDATE SET budgetId = excluded.budgetId').run(workerId, budgetId);
}

function budgetById(store: Store, budgetId: string): BudgetRow | undefined {
  if (!hasSql(store)) return memoryState(store).budgets.find((row) => row.id === budgetId);
  const row = store.sql.prepare('SELECT * FROM budgets WHERE id = ?').get(budgetId) as Record<string, unknown> | undefined;
  return row ? toBudget(row) : undefined;
}

function budgetSpend(store: Store, budget: BudgetRow): { spentUsd: number; spentCodexTokens: number } {
  if (!hasSql(store)) {
    const workers = [...memoryState(store).workerBudget.entries()].filter(([, id]) => id === budget.id).map(([workerId]) => workerId);
    const summaries = workers.map((workerId) => store.spendFor(workerId));
    return {
      spentUsd: summaries.reduce((total, spend) => total + spend.spendUsd, 0),
      spentCodexTokens: summaries.reduce((total, spend) => total + spend.tokens.input + spend.tokens.output, 0),
    };
  }
  const row = store.sql.prepare(`
    SELECT COALESCE(SUM(CASE WHEN s.costUsd IS NULL THEN 0 ELSE s.costUsd END), 0) AS spentUsd,
           COALESCE(SUM(CASE WHEN s.model LIKE 'codex/%' THEN s.inputTokens + s.outputTokens ELSE 0 END), 0) AS spentCodexTokens
    FROM spend s JOIN worker_budget wb ON wb.workerId = s.workerId WHERE wb.budgetId = ?
  `).get(budget.id) as { spentUsd: number; spentCodexTokens: number };
  return { spentUsd: Number(row.spentUsd), spentCodexTokens: Number(row.spentCodexTokens) };
}

function budgetWorkers(store: Store, budgetId: string): string[] {
  if (!hasSql(store)) return [...memoryState(store).workerBudget.entries()].filter(([, id]) => id === budgetId).map(([workerId]) => workerId);
  return (store.sql.prepare('SELECT workerId FROM worker_budget WHERE budgetId = ? ORDER BY workerId').all(budgetId) as Array<{ workerId: string }>).map((row) => row.workerId);
}

export function budgetStatus(store: Store, budget: BudgetRow): BudgetStatus {
  const spend = budgetSpend(store, budget);
  const workers = budgetWorkers(store, budget.id);
  const remainingUsd = Math.max(0, budget.capUsd - spend.spentUsd);
  const remainingCodexTokens = budget.capCodexTokens === null ? null : Math.max(0, budget.capCodexTokens - spend.spentCodexTokens);
  const exhausted = spend.spentUsd >= budget.capUsd || (budget.capCodexTokens !== null && spend.spentCodexTokens >= budget.capCodexTokens);
  const warning = spend.spentUsd >= budget.capUsd * 0.8 || (budget.capCodexTokens !== null && spend.spentCodexTokens >= budget.capCodexTokens * 0.8);
  return { ...budget, ...spend, remainingUsd, remainingCodexTokens, workers, workerCount: workers.length, exhausted, warning };
}

export function listBudgetStatuses(store: Store, project?: string): BudgetStatus[] {
  ensureBudgetTables(store);
  const budgets = hasSql(store)
    ? (store.sql.prepare(`SELECT * FROM budgets ${project ? 'WHERE project = ?' : ''} ORDER BY openedAt ASC`).all(...(project ? [project] : [])) as Record<string, unknown>[]).map(toBudget)
    : memoryState(store).budgets.filter((row) => !project || row.project === project);
  return budgets.map((budget) => budgetStatus(store, budget));
}

export function budgetExhausted(store: Store, budget: BudgetRow): boolean { return budgetStatus(store, budget).exhausted; }

export function budgetWarningEmitted(store: Store, budgetId: string): boolean {
  ensureBudgetTables(store);
  if (!hasSql(store)) return store.listAllEvents({ limit: 1_000_000 }).some((event) => event.kind === 'spend.warning' && event.data.budgetId === budgetId);
  const row = store.sql.prepare(`SELECT 1 AS found FROM events WHERE kind = 'spend.warning' AND data LIKE ? LIMIT 1`).get(`%"budgetId":"${budgetId}"%`) as { found: number } | undefined;
  return row !== undefined;
}
