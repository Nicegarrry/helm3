/** SQLite storage for the core tables: workers, events, gates, prs, and spend. Feature modules own their tables via Store.sql. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { EventRow, GateRow, PrInput, PrRow, PrResolution, SpendRow, SpendSummary, Store, WorkerMeta, WorkerRow, WorkerState } from './types.js';

const WORKER_COLUMNS = [
  'workerId', 'repo', 'repoSlug', 'role', 'model', 'objective', 'acceptance', 'contextPaths', 'allowWorkflows', 'baseRef', 'baseSha',
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
    contextPaths: row.contextPaths ? JSON.parse(row.contextPaths as string) : [],
    allowWorkflows: Boolean(row.allowWorkflows),
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
    repoSlug: row.repoSlug as string,
    number: row.number as number,
    workerId: row.workerId as string,
    url: row.url as string,
    head: row.head as string,
    createdAt: row.createdAt as string,
    state: (row.state as PrRow['state']) ?? null,
    checkedAt: (row.checkedAt as string | null) ?? null,
  };
}

function repoSlugFromPrUrl(url: string): string | undefined {
  return url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+(?:[/?#]|$)/i)?.[1];
}

function migratePrs(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(prs)').all() as Array<{ name: string; pk: number }>;
  if (columns.length === 0) return;
  const repoColumn = columns.find((column) => column.name === 'repoSlug');
  const numberColumn = columns.find((column) => column.name === 'number');
  const isComposite = repoColumn?.pk === 1 && numberColumn?.pk === 2;
  if (isComposite) {
    if (!columns.some((column) => column.name === 'state')) db.exec('ALTER TABLE prs ADD COLUMN state TEXT');
    if (!columns.some((column) => column.name === 'checkedAt')) db.exec('ALTER TABLE prs ADD COLUMN checkedAt TEXT');
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DROP TABLE IF EXISTS prs_v2;
      CREATE TABLE prs_v2 (
        repoSlug TEXT NOT NULL,
        number INTEGER NOT NULL,
        workerId TEXT NOT NULL,
        url TEXT NOT NULL,
        head TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        state TEXT,
        checkedAt TEXT,
        PRIMARY KEY (repoSlug, number)
      );
    `);
    const rows = db.prepare('SELECT number, workerId, url, head, createdAt FROM prs').all() as Array<Record<string, unknown>>;
    const insert = db.prepare('INSERT INTO prs_v2 (repoSlug, number, workerId, url, head, createdAt, state, checkedAt) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)');
    const workerRepo = db.prepare('SELECT repoSlug FROM workers WHERE workerId = ?');
    for (const row of rows) {
      const fromUrl = repoSlugFromPrUrl(String(row.url));
      const fromWorker = workerRepo.get(String(row.workerId)) as { repoSlug?: string } | undefined;
      const repoSlug = fromUrl ?? fromWorker?.repoSlug ?? `unknown/${String(row.workerId)}`;
      insert.run(repoSlug, Number(row.number), String(row.workerId), String(row.url), String(row.head), String(row.createdAt));
    }
    db.exec('DROP TABLE prs; ALTER TABLE prs_v2 RENAME TO prs;');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
    throw error;
  }
}

function toWorkerMeta(row: Record<string, unknown>): WorkerMeta {
  return {
    workerId: row.workerId as string,
    issue: (row.issue as number | null) ?? null,
    prBase: (row.prBase as string | null) ?? null,
    baselineId: (row.baselineId as string | null) ?? null,
    band: (row.band as string | null) ?? null,
    complexity: (row.complexity as number | null) ?? null,
    skills: row.skills ? JSON.parse(row.skills as string) : [],
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
      contextPaths TEXT NOT NULL DEFAULT '[]',
      allowWorkflows INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE IF NOT EXISTS cursors (
      name TEXT PRIMARY KEY,
      seq INTEGER NOT NULL
    );
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
      repoSlug TEXT NOT NULL,
      number INTEGER NOT NULL,
      workerId TEXT NOT NULL,
      url TEXT NOT NULL,
      head TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      state TEXT,
      checkedAt TEXT,
      PRIMARY KEY (repoSlug, number)
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
    CREATE TABLE IF NOT EXISTS worker_meta (
      workerId TEXT PRIMARY KEY,
      issue INTEGER,
      prBase TEXT,
      baselineId TEXT,
      band TEXT,
      complexity REAL,
      skills TEXT NOT NULL DEFAULT '[]'
    );
  `);
  migratePrs(db);
  db.exec('CREATE INDEX IF NOT EXISTS prs_worker ON prs(workerId);');

  const insertWorkerStmt = db.prepare(
    `INSERT INTO workers (${WORKER_COLUMNS.join(', ')}) VALUES (${WORKER_COLUMNS.map(() => '?').join(', ')})`,
  );
  const getWorkerStmt = db.prepare('SELECT * FROM workers WHERE workerId = ?');
  const getMetaStmt = db.prepare('SELECT * FROM worker_meta WHERE workerId = ?');
  const setMetaStmt = db.prepare(`
    INSERT INTO worker_meta (workerId, issue, prBase, baselineId, band, complexity, skills)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workerId) DO UPDATE SET issue = excluded.issue, prBase = excluded.prBase,
      baselineId = excluded.baselineId, band = excluded.band, complexity = excluded.complexity, skills = excluded.skills
  `);
  const findByIdempotencyKeyStmt = db.prepare('SELECT * FROM workers WHERE idempotencyKey = ?');
  const appendEventStmt = db.prepare('INSERT INTO events (workerId, at, kind, data) VALUES (?, ?, ?, ?)');
  const getEventStmt = db.prepare('SELECT * FROM events WHERE seq = ?');
  const listAllEventsStmt = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?');
  const getCursorStmt = db.prepare('SELECT seq FROM cursors WHERE name = ?');
  const setCursorStmt = db.prepare('INSERT INTO cursors (name, seq) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET seq = excluded.seq');
  const insertGateStmt = db.prepare('INSERT INTO gates (gateId, workerId, head, passed, checks, at) VALUES (?, ?, ?, ?, ?, ?)');
  const listGatesStmt = db.prepare('SELECT * FROM gates WHERE workerId = ? ORDER BY at ASC');
  const insertPrStmt = db.prepare('INSERT INTO prs (repoSlug, number, workerId, url, head, createdAt, state, checkedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const updatePrStmt = db.prepare('UPDATE prs SET workerId = ?, url = ?, head = ?, createdAt = ?, state = ?, checkedAt = ? WHERE repoSlug = ? AND number = ?');
  const getPrByWorkerStmt = db.prepare('SELECT * FROM prs WHERE workerId = ? ORDER BY number DESC LIMIT 1');
  const getPrByNumberStmt = db.prepare('SELECT * FROM prs WHERE repoSlug = ? AND number = ?');
  const resolvePrByNumberStmt = db.prepare('SELECT * FROM prs WHERE number = ? ORDER BY repoSlug ASC');
  const listPrsStmt = db.prepare('SELECT * FROM prs ORDER BY repoSlug ASC, number ASC');
  const addSpendStmt = db.prepare(
    'INSERT INTO spend (workerId, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const spendForStmt = db.prepare('SELECT inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd FROM spend WHERE workerId = ?');
  const spendTotalStmt = db.prepare('SELECT inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd FROM spend');
  const spendSeriesStmt = db.prepare('SELECT at, costUsd FROM spend ORDER BY at DESC, id DESC LIMIT ?');
  const runningWorkersStmt = db.prepare("SELECT workerId FROM workers WHERE state = 'running'");

  return {
    sql: db,
    insertWorker(row: WorkerRow): void {
      insertWorkerStmt.run(
        row.workerId, row.repo, row.repoSlug, row.role, row.model, row.objective, row.acceptance,
        JSON.stringify(row.contextPaths), row.allowWorkflows ? 1 : 0, row.baseRef, row.baseSha, row.branch, row.worktree, row.state, row.head, row.sessionFile,
        row.result ? JSON.stringify(row.result) : null, row.rawResultText, row.idempotencyKey,
        row.createdAt, row.updatedAt,
      );
    },

    updateWorker(workerId: string, patch: Partial<Omit<WorkerRow, 'workerId' | 'createdAt'>>): void {
      if (Object.keys(patch).length === 0) return;
      // Always bump updatedAt so it reflects the last write, unless the caller supplied one itself.
      const fullPatch = patch.updatedAt === undefined ? { ...patch, updatedAt: new Date().toISOString() } : patch;
      const entries = Object.entries(fullPatch);
      const sets = entries.map(([key]) => `${key} = ?`).join(', ');
      const values = entries.map(([key, value]) => {
        if (key === 'result') return value ? JSON.stringify(value) : null;
        if (key === 'contextPaths') return JSON.stringify(value ?? []);
        if (key === 'allowWorkflows') return value ? 1 : 0;
        return value;
      }) as (string | number | null)[];
      db.prepare(`UPDATE workers SET ${sets} WHERE workerId = ?`).run(...values, workerId);
    },

    getWorker(workerId: string): WorkerRow | undefined {
      const row = getWorkerStmt.get(workerId) as Record<string, unknown> | undefined;
      return row ? toWorkerRow(row) : undefined;
    },

    getMeta(workerId: string): WorkerMeta | undefined {
      const row = getMetaStmt.get(workerId) as Record<string, unknown> | undefined;
      return row ? toWorkerMeta(row) : undefined;
    },

    setMeta(workerId: string, patch: Partial<Omit<WorkerMeta, 'workerId'>>): void {
      const current = this.getMeta(workerId) ?? { workerId, issue: null, prBase: null, baselineId: null, band: null, complexity: null, skills: [] };
      const next = { ...current, ...patch };
      setMetaStmt.run(next.workerId, next.issue, next.prBase, next.baselineId, next.band, next.complexity, JSON.stringify(next.skills));
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

    appendEvent(workerId: string, kind: string, data: Record<string, unknown> = {}, at = new Date().toISOString()): EventRow {
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

    listAllEvents(opts?: { afterSeq?: number; limit?: number }): EventRow[] {
      const afterSeq = opts?.afterSeq ?? 0;
      const limit = Math.min(Math.max(opts?.limit ?? 100, 0), 1000);
      const rows = listAllEventsStmt.all(afterSeq, limit) as Record<string, unknown>[];
      return rows.map(toEventRow);
    },

    getCursor(name: string): number {
      const row = getCursorStmt.get(name) as { seq: number } | undefined;
      return row?.seq ?? 0;
    },

    setCursor(name: string, seq: number): void {
      setCursorStmt.run(name, seq);
    },

    insertGate(row: GateRow): void {
      insertGateStmt.run(row.gateId, row.workerId, row.head, row.passed ? 1 : 0, JSON.stringify(row.checks), row.at);
    },

    listGates(workerId: string): GateRow[] {
      const rows = listGatesStmt.all(workerId) as Record<string, unknown>[];
      return rows.map(toGateRow);
    },

    insertPr(row: PrInput): void {
      const worker = db.prepare('SELECT repoSlug FROM workers WHERE workerId = ?').get(row.workerId) as { repoSlug?: string } | undefined;
      const repoSlug = row.repoSlug ?? repoSlugFromPrUrl(row.url) ?? worker?.repoSlug ?? `unknown/${row.workerId}`;
      insertPrStmt.run(repoSlug, row.number, row.workerId, row.url, row.head, row.createdAt, row.state ?? 'open', row.checkedAt ?? null);
    },

    updatePr(row: PrRow): void {
      updatePrStmt.run(row.workerId, row.url, row.head, row.createdAt, row.state, row.checkedAt, row.repoSlug, row.number);
    },

    getPrByWorker(workerId: string): PrRow | undefined {
      const row = getPrByWorkerStmt.get(workerId) as Record<string, unknown> | undefined;
      return row ? toPrRow(row) : undefined;
    },

    getPrByNumber(repoSlug: string, number: number): PrRow | undefined {
      const row = getPrByNumberStmt.get(repoSlug, number) as Record<string, unknown> | undefined;
      return row ? toPrRow(row) : undefined;
    },

    listPrs(): PrRow[] {
      return (listPrsStmt.all() as Record<string, unknown>[]).map(toPrRow);
    },

    resolvePrByNumber(number: number, project?: string): PrResolution {
      if (project) return { pr: this.getPrByNumber(project, number) };
      const rows = (resolvePrByNumberStmt.all(number) as Record<string, unknown>[]).map(toPrRow);
      if (rows.length === 1) return { pr: rows[0] };
      if (rows.length > 1) return { reason: `PR #${number} is ambiguous across repos: ${rows.map((row) => row.repoSlug).join(', ')}; pass project` };
      return {};
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

    spendSeries(limit: number): Array<{ at: string; costUsd: number | null }> {
      // Take the newest `limit` rows by insertion id, then flip them so the caller sees ascending time.
      const rows = spendSeriesStmt.all(Math.max(limit, 0)) as { at: string; costUsd: number | null }[];
      return rows.reverse();
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
