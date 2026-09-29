/** Durable worker questions. A5a uses the Store.sql seam so this module owns only its table. */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InboxRow, InboxState } from './types.js';

export type NewInboxRow = Readonly<Pick<InboxRow, 'id' | 'workerId' | 'project' | 'question' | 'createdAt'>>;

export function ensureInboxTable(sql: DatabaseSync): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY,
      workerId TEXT NOT NULL,
      project TEXT NOT NULL,
      question TEXT NOT NULL,
      state TEXT NOT NULL,
      answer TEXT,
      answeredBy TEXT,
      triage TEXT,
      createdAt TEXT NOT NULL,
      answeredAt TEXT
    );
    CREATE INDEX IF NOT EXISTS inbox_project_state ON inbox(project, state, createdAt);
    CREATE INDEX IF NOT EXISTS inbox_worker_state ON inbox(workerId, state, createdAt);
  `);
}

function toInboxRow(row: Record<string, unknown>): InboxRow {
  return {
    id: row.id as string,
    workerId: row.workerId as string,
    project: row.project as string,
    question: row.question as string,
    state: row.state as InboxState,
    answer: (row.answer as string | null) ?? null,
    answeredBy: (row.answeredBy as string | null) ?? null,
    triage: row.triage ? JSON.parse(row.triage as string) as Record<string, unknown> : null,
    createdAt: row.createdAt as string,
    answeredAt: (row.answeredAt as string | null) ?? null,
  };
}

export function createInboxId(): string {
  return `q-${randomBytes(4).toString('hex')}`;
}

export function insertInbox(sql: DatabaseSync, row: NewInboxRow): void {
  ensureInboxTable(sql);
  sql.prepare(`INSERT INTO inbox (id, workerId, project, question, state, answer, answeredBy, triage, createdAt, answeredAt)
    VALUES (?, ?, ?, ?, 'open', NULL, NULL, NULL, ?, NULL)`).run(row.id, row.workerId, row.project, row.question, row.createdAt);
}

export function getInbox(sql: DatabaseSync, id: string): InboxRow | undefined {
  ensureInboxTable(sql);
  const row = sql.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? toInboxRow(row) : undefined;
}

export function listInbox(sql: DatabaseSync, opts: { project?: string; state?: InboxState; workerId?: string } = {}): InboxRow[] {
  ensureInboxTable(sql);
  const clauses = ['1 = 1'];
  const values: string[] = [];
  if (opts.project) { clauses.push('project = ?'); values.push(opts.project); }
  if (opts.state) { clauses.push('state = ?'); values.push(opts.state); }
  if (opts.workerId) { clauses.push('workerId = ?'); values.push(opts.workerId); }
  const rows = sql.prepare(`SELECT * FROM inbox WHERE ${clauses.join(' AND ')} ORDER BY createdAt ASC, id ASC`).all(...values) as Record<string, unknown>[];
  return rows.map(toInboxRow);
}

export function answerInbox(sql: DatabaseSync, id: string, answer: string, answeredBy: string, answeredAt: string): boolean {
  ensureInboxTable(sql);
  const result = sql.prepare(`UPDATE inbox SET state = 'answered', answer = ?, answeredBy = ?, answeredAt = ? WHERE id = ? AND state = 'open'`)
    .run(answer, answeredBy, answeredAt, id);
  return Number(result.changes) === 1;
}

export function supersedeOpenInbox(sql: DatabaseSync, workerId: string): number {
  ensureInboxTable(sql);
  const result = sql.prepare("UPDATE inbox SET state = 'superseded' WHERE workerId = ? AND state = 'open'").run(workerId);
  return Number(result.changes);
}
