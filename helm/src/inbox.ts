/** Durable worker questions. A5a uses the Store.sql seam so this module owns only its table. */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { consumer } from './daemon.js';
import type { Jev, JevAnswers } from './jev.js';
import type { Settings } from './settings.js';
import type { EventRow, Store } from './types.js';
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

const DEFAULT_ENVELOPE = 'Work only in the assigned worktree. Outside the autonomy envelope: production data or migrations, spending money, deleting data, secrets, merging or force-pushing main, and provider settings.';
const TRIAGE_ROUTE_CRITERIA = {
  answer_from_issue: 'the issue text already states the answer, or the envelope explicitly permits the action',
  needs_supervisor: 'a judgement call, scope question, conflict or tooling problem not settled by the issue, and inside the envelope',
  needs_human: 'outside the envelope: production data or migrations, spending money, deleting data, secrets, merging or force-pushing main, provider settings',
} as const;

export type InboxTriage = Readonly<Record<string, unknown>>;

export type InboxTriageOptions = Readonly<{
  store: Store;
  settings: Pick<Settings, 'jev' | 'supervisor'>;
  jev: Jev;
}>;

function probability(answer: JevAnswers[string] | undefined, truth: boolean): number {
  if (!answer) return 0;
  const probabilities = answer.probabilities;
  if (probabilities) {
    const value = probabilities[String(truth)] ?? probabilities[truth ? 'true' : 'false'];
    if (typeof value === 'number') return value;
  }
  if (typeof answer.noul === 'boolean') {
    if (answer.noul !== truth) return 0;
    return typeof answer.confidence === 'number' ? answer.confidence : 1;
  }
  return 0;
}

function triageFrom(answers: JevAnswers, threshold: number, shadow: boolean): InboxTriage {
  const routeAnswer = answers.route;
  const route = routeAnswer?.choice;
  const outside = probability(answers.outside, true);
  const human = routeAnswer?.probabilities?.needs_human
    ?? (route === 'needs_human' ? routeAnswer?.confidence ?? 1 : 0);
  const confidence = routeAnswer?.confidence;
  const selected = human >= threshold || outside >= threshold
    ? 'needs_human'
    : route === 'answer_from_issue' && typeof confidence === 'number' && confidence >= 0.9 && outside < 0.2
      ? 'answer_from_issue'
      : 'needs_supervisor';
  const inIssue = typeof answers.inIssue?.noul === 'boolean' ? answers.inIssue.noul : probability(answers.inIssue, true);
  return { route: selected, confidence: confidence ?? null, outside, inIssue, shadow };
}

function setTriage(sql: DatabaseSync, id: string, triage: InboxTriage): void {
  ensureInboxTable(sql);
  sql.prepare('UPDATE inbox SET triage = ? WHERE id = ?').run(JSON.stringify(triage), id);
}

function triageEvent(options: InboxTriageOptions, event: EventRow): Promise<void> | void {
  if (event.kind !== 'ask') return;
  const inboxId = typeof event.data.inboxId === 'string' ? event.data.inboxId : undefined;
  if (!inboxId) return;
  const item = getInbox(options.store.sql, inboxId);
  if (!item || item.triage) return;
  const worker = options.store.getWorker(event.workerId);
  if (!worker) return;
  const envelope = options.settings.supervisor.envelope ?? DEFAULT_ENVELOPE;
  return options.jev.ask('triage', {
    workerId: worker.workerId,
    project: worker.repoSlug,
    state: { envelope, objective: worker.objective, acceptance: worker.acceptance, question: item.question },
    questions: {
      route: { type: 'choice', instructions: 'How should this worker question be routed?', criteria: TRIAGE_ROUTE_CRITERIA },
      outside: { type: 'noul', instructions: 'Would acting on this require an action outside the autonomy envelope?' },
      inIssue: { type: 'noul', instructions: 'Does the issue text or envelope already contain the answer?' },
    },
  }).then((result) => {
    const triage = result.ok
      ? triageFrom(result.answers, options.settings.jev.triageHumanAt, options.jev.shadow)
      : { route: 'needs_supervisor', reason: result.reason, shadow: options.jev.shadow };
    setTriage(options.store.sql, item.id, triage);
  });
}

/** Create the restart-safe A5b consumer; it never changes wake routing. */
export function createInboxTriage(options: InboxTriageOptions): () => Promise<void> {
  return consumer(options.store, 'inbox-triage', async (events) => {
    for (const event of events) await triageEvent(options, event);
  });
}
