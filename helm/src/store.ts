/** SQLite storage: workers, events, gates, prs, spend. See DESIGN.md. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventRow, GateRow, PrRow, SpendRow, SpendSummary, Store, WorkerRow, WorkerState } from './types.js';

const WORKER_COLUMNS = [
  'workerId', 'repo', 'repoSlug', 'role', 'model', 'objective', 'acceptance', 'baseRef', 'baseSha',
  'branch', 'worktree', 'state', 'head', 'sessionFile', 'result', 'rawResultText', 'idempotencyKey',
  'createdAt', 'updatedAt',
] as const;

function toWorkerRow(row: Record<string, unknown>): WorkerRow {
  return {
    workerId: row.workerId as string,
    repo: row.repo as string,
    repoSlug: row.repoSlug as string,
    role: row.role as WorkerRow['role'],
    model: row.model as string,
    objective: row.objective as string,
    acceptance: (row.acceptance as string | null) ?? null,
    baseRef: row.baseRef as string,
    baseSha: row.baseSha as string,
    branch: row.branch as string,
    worktree: row.worktree as string,
    state: row.state as WorkerState,
    head: (row.head as string | null) ?? null,
    sessionFile: (row.sessionFile as string | null) ?? null,
    result: row.result ? JSON.parse(row.result as string) : null,
    rawResultText: (row.rawResultText as string | null) ?? null,
    idempotencyKey: (row.idempotencyKey as string | null) ?? null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function toEventRow(row: Record<string, unknown>): EventRow {
  return {
    seq: row.seq as number,
    workerId: row.workerId as string,
    at: row.at as string,
    kind: row.kind as string,
    data: row.data ? JSON.parse(row.data as string) : {},
  };
}

function toGateRow(row: Record<string, unknown>): GateRow {
  return {
    gateId: row.gateId as string,
    workerId: row.workerId as string,
    head: row.head as string,
    passed: Boolean(row.passed),
    checks: JSON.parse(row.checks as string),
    at: row.at as string,
  };
}

function toPrRow(row: Record<string, unknown>): PrRow {
  return {
    number: row.number as number,
    workerId: row.workerId as string,
    url: row.url as string,
    head: row.head as string,
    createdAt: row.createdAt as string,
  };
}

function summarize(rows: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null }[]): SpendSummary {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let spendUsd = 0;
  let unknownCostEvents = 0;
  for (const row of rows) {
    tokens.input += row.inputTokens;
    tokens.output += row.outputTokens;
    tokens.cacheRead += row.cacheReadTokens;
    tokens.cacheWrite += row.cacheWriteTokens;
    if (row.costUsd === null) unknownCostEvents += 1;
    else spendUsd += row.costUsd;
  }
  return { spendUsd, tokens, unknownCostEvents };
}

export function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workers (
      workerId TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      repoSlug TEXT NOT NULL,
      role TEXT NOT NULL,
      model TEXT NOT NULL,
      objective TEXT NOT NULL,
      acceptance TEXT,
      baseRef TEXT NOT NULL,
      baseSha TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree TEXT NOT NULL,
      state TEXT NOT NULL,
      head TEXT,
      sessionFile TEXT,
      result TEXT,
      rawResultText TEXT,
      idempotencyKey TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workers_idempotency_key ON workers(idempotencyKey) WHERE idempotencyKey IS NOT NULL;
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      workerId TEXT NOT NULL,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS events_worker ON events(workerId, seq);
    CREATE TABLE IF NOT EXISTS gates (
      gateId TEXT PRIMARY KEY,
      workerId TEXT NOT NULL,
      head TEXT NOT NULL,
      passed INTEGER NOT NULL,
      checks TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gates_worker ON gates(workerId);
    CREATE TABLE IF NOT EXISTS prs (
      number INTEGER PRIMARY KEY,
      workerId TEXT NOT NULL,
      url TEXT NOT NULL,
      head TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prs_worker ON prs(workerId);
    CREATE TABLE IF NOT EXISTS spend (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workerId TEXT NOT NULL,
      model TEXT NOT NULL,
      inputTokens INTEGER NOT NULL,
      outputTokens INTEGER NOT NULL,
      cacheReadTokens INTEGER NOT NULL,
      cacheWriteTokens INTEGER NOT NULL,
      costUsd REAL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS spend_worker ON spend(workerId);
  `);

  const insertWorkerStmt = db.prepare(
    `INSERT INTO workers (${WORKER_COLUMNS.join(', ')}) VALUES (${WORKER_COLUMNS.map(() => '?').join(', ')})`,
  );
  const getWorkerStmt = db.prepare('SELECT * FROM workers WHERE workerId = ?');
  const findByIdempotencyKeyStmt = db.prepare('SELECT * FROM workers WHERE idempotencyKey = ?');
  const appendEventStmt = db.prepare('INSERT INTO events (workerId, at, kind, data) VALUES (?, ?, ?, ?)');
  const getEventStmt = db.prepare('SELECT * FROM events WHERE seq = ?');
  const insertGateStmt = db.prepare('INSERT INTO gates (gateId, workerId, head, passed, checks, at) VALUES (?, ?, ?, ?, ?, ?)');
  const listGatesStmt = db.prepare('SELECT * FROM gates WHERE workerId = ? ORDER BY at ASC');
  const insertPrStmt = db.prepare('INSERT INTO prs (number, workerId, url, head, createdAt) VALUES (?, ?, ?, ?, ?)');
  const getPrByWorkerStmt = db.prepare('SELECT * FROM prs WHERE workerId = ? ORDER BY number DESC LIMIT 1');
  const getPrByNumberStmt = db.prepare('SELECT * FROM prs WHERE number = ?');
  const addSpendStmt = db.prepare(
    'INSERT INTO spend (workerId, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const spendForStmt = db.prepare('SELECT inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd FROM spend WHERE workerId = ?');
  const spendTotalStmt = db.prepare('SELECT inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd FROM spend');
  const runningWorkersStmt = db.prepare("SELECT workerId FROM workers WHERE state = 'running'");

  return {
    insertWorker(row: WorkerRow): void {
      insertWorkerStmt.run(
        row.workerId, row.repo, row.repoSlug, row.role, row.model, row.objective, row.acceptance,
        row.baseRef, row.baseSha, row.branch, row.worktree, row.state, row.head, row.sessionFile,
        row.result ? JSON.stringify(row.result) : null, row.rawResultText, row.idempotencyKey,
        row.createdAt, row.updatedAt,
      );
    },

    updateWorker(workerId: string, patch: Partial<Omit<WorkerRow, 'workerId' | 'createdAt'>>): void {
      const entries = Object.entries(patch);
      if (entries.length === 0) return;
      const sets = entries.map(([key]) => `${key} = ?`).join(', ');
      const values = entries.map(([key, value]) => (key === 'result' ? (value ? JSON.stringify(value) : null) : value)) as (string | number | null)[];
      db.prepare(`UPDATE workers SET ${sets} WHERE workerId = ?`).run(...values, workerId);
    },

    getWorker(workerId: string): WorkerRow | undefined {
      const row = getWorkerStmt.get(workerId) as Record<string, unknown> | undefined;
      return row ? toWorkerRow(row) : undefined;
    },

    findByIdempotencyKey(key: string): WorkerRow | undefined {
      const row = findByIdempotencyKeyStmt.get(key) as Record<string, unknown> | undefined;
      return row ? toWorkerRow(row) : undefined;
    },

    listWorkers(filter?: { repo?: string; state?: WorkerState }): WorkerRow[] {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter?.repo) { clauses.push('repo = ?'); params.push(filter.repo); }
      if (filter?.state) { clauses.push('state = ?'); params.push(filter.state); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM workers ${where} ORDER BY createdAt ASC`).all(...params) as Record<string, unknown>[];
      return rows.map(toWorkerRow);
    },

    appendEvent(workerId: string, kind: string, data: Record<string, unknown> = {}): EventRow {
      const at = new Date().toISOString();
      const result = appendEventStmt.run(workerId, at, kind, JSON.stringify(data));
      const seq = Number(result.lastInsertRowid);
      const row = getEventStmt.get(seq) as Record<string, unknown>;
      return toEventRow(row);
    },

    listEvents(workerId: string, opts?: { afterSeq?: number; limit?: number }): EventRow[] {
      const afterSeq = opts?.afterSeq ?? 0;
      const limit = opts?.limit ?? 1000;
      const rows = db.prepare('SELECT * FROM events WHERE workerId = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
        .all(workerId, afterSeq, limit) as Record<string, unknown>[];
      return rows.map(toEventRow);
    },

    insertGate(row: GateRow): void {
      insertGateStmt.run(row.gateId, row.workerId, row.head, row.passed ? 1 : 0, JSON.stringify(row.checks), row.at);
    },

    listGates(workerId: string): GateRow[] {
      const rows = listGatesStmt.all(workerId) as Record<string, unknown>[];
      return rows.map(toGateRow);
    },

    insertPr(row: PrRow): void {
      insertPrStmt.run(row.number, row.workerId, row.url, row.head, row.createdAt);
    },

    getPrByWorker(workerId: string): PrRow | undefined {
      const row = getPrByWorkerStmt.get(workerId) as Record<string, unknown> | undefined;
      return row ? toPrRow(row) : undefined;
    },

    getPrByNumber(number: number): PrRow | undefined {
      const row = getPrByNumberStmt.get(number) as Record<string, unknown> | undefined;
      return row ? toPrRow(row) : undefined;
    },

    addSpend(row: SpendRow): void {
      addSpendStmt.run(row.workerId, row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.costUsd, row.at);
    },

    spendFor(workerId: string): SpendSummary {
      const rows = spendForStmt.all(workerId) as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null }[];
      return summarize(rows);
    },

    spendTotal(): SpendSummary {
      const rows = spendTotalStmt.all() as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null }[];
      return summarize(rows);
    },

    markInterrupted(): string[] {
      const rows = runningWorkersStmt.all() as { workerId: string }[];
      const ids = rows.map((row) => row.workerId);
      const at = new Date().toISOString();
      for (const workerId of ids) {
        db.prepare("UPDATE workers SET state = 'interrupted', updatedAt = ? WHERE workerId = ?").run(at, workerId);
        appendEventStmt.run(workerId, at, 'state', JSON.stringify({ from: 'running', to: 'interrupted' }));
      }
      return ids;
    },

    close(): void {
      db.close();
    },
  };
}
