/** Per-project and per-sprint spend budgets. The tables are owned by this module. */
import { randomBytes } from 'node:crypto';
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

export function ensureBudgetTables(store: Store): void {
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
    CREATE TABLE IF NOT EXISTS worker_budget_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workerId TEXT NOT NULL,
      budgetId TEXT NOT NULL,
      attachedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worker_budget_history_budget ON worker_budget_history(budgetId);
    CREATE INDEX IF NOT EXISTS worker_budget_history_worker ON worker_budget_history(workerId, attachedAt);
    INSERT INTO worker_budget_history (workerId, budgetId, attachedAt)
    SELECT wb.workerId, wb.budgetId, '1970-01-01T00:00:00.000Z'
    FROM worker_budget wb
    WHERE NOT EXISTS (SELECT 1 FROM worker_budget_history wbh WHERE wbh.workerId = wb.workerId);
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
  store.sql.prepare('UPDATE budgets SET closedAt = ? WHERE id = ?').run(closedAt, current.id);
  return { ...current, closedAt };
}

export function openBudgetFor(store: Store, project: string): BudgetRow | undefined {
  ensureBudgetTables(store);
  const row = store.sql.prepare('SELECT * FROM budgets WHERE project = ? AND closedAt IS NULL ORDER BY openedAt DESC LIMIT 1').get(project) as Record<string, unknown> | undefined;
  return row ? toBudget(row) : undefined;
}

export function budgetForWorker(store: Store, workerId: string): BudgetRow | undefined {
  ensureBudgetTables(store);
  const row = store.sql.prepare('SELECT b.* FROM worker_budget wb JOIN budgets b ON b.id = wb.budgetId WHERE wb.workerId = ?').get(workerId) as Record<string, unknown> | undefined;
  return row ? toBudget(row) : undefined;
}

export function attachWorker(store: Store, workerId: string, budgetId: string, attachedAt: string = new Date().toISOString()): void {
  ensureBudgetTables(store);
  const current = budgetForWorker(store, workerId);
  store.sql.prepare('INSERT INTO worker_budget (workerId, budgetId) VALUES (?, ?) ON CONFLICT(workerId) DO UPDATE SET budgetId = excluded.budgetId').run(workerId, budgetId);
  const hasHistory = store.sql.prepare('SELECT 1 FROM worker_budget_history WHERE workerId = ? LIMIT 1').get(workerId);
  if (!hasHistory || current?.id !== budgetId) {
    store.sql.prepare('INSERT INTO worker_budget_history (workerId, budgetId, attachedAt) VALUES (?, ?, ?)').run(workerId, budgetId, attachedAt);
  }
}

function budgetSpend(store: Store, budget: BudgetRow): { spentUsd: number; spentCodexTokens: number } {
  const row = store.sql.prepare(`
    WITH intervals AS (
      SELECT
        workerId,
        budgetId,
        attachedAt,
        LEAD(attachedAt) OVER (PARTITION BY workerId ORDER BY attachedAt ASC, id ASC) AS nextAttachedAt,
        ROW_NUMBER() OVER (PARTITION BY workerId ORDER BY attachedAt ASC, id ASC) AS rn
      FROM worker_budget_history
    )
    SELECT COALESCE(SUM(CASE WHEN s.costUsd IS NULL THEN 0 ELSE s.costUsd END), 0) AS spentUsd,
           COALESCE(SUM(CASE WHEN s.model LIKE 'codex/%' THEN s.inputTokens + s.outputTokens ELSE 0 END), 0) AS spentCodexTokens
    FROM spend s
    JOIN intervals i ON i.workerId = s.workerId
      AND i.budgetId = ?
      AND (i.rn = 1 OR s.at >= i.attachedAt)
      AND (i.nextAttachedAt IS NULL OR s.at < i.nextAttachedAt)
  `).get(budget.id) as { spentUsd: number; spentCodexTokens: number };
  return { spentUsd: Number(row.spentUsd), spentCodexTokens: Number(row.spentCodexTokens) };
}

function budgetWorkers(store: Store, budgetId: string): string[] {
  return (store.sql.prepare(`
    SELECT DISTINCT workerId FROM (
      SELECT workerId FROM worker_budget WHERE budgetId = ?
      UNION
      SELECT workerId FROM worker_budget_history WHERE budgetId = ?
    ) ORDER BY workerId
  `).all(budgetId, budgetId) as Array<{ workerId: string }>).map((row) => row.workerId);
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
  const budgets = (store.sql.prepare(`SELECT * FROM budgets ${project ? 'WHERE project = ?' : ''} ORDER BY openedAt ASC`).all(...(project ? [project] : [])) as Record<string, unknown>[]).map(toBudget);
  return budgets.map((budget) => budgetStatus(store, budget));
}

export function budgetWarningEmitted(store: Store, budgetId: string): boolean {
  ensureBudgetTables(store);
  const row = store.sql.prepare(`SELECT 1 AS found FROM events WHERE kind = 'spend.warning' AND data LIKE ? LIMIT 1`).get(`%"budgetId":"${budgetId}"%`) as { found: number } | undefined;
  return row !== undefined;
}
