import type { Store, Priority, LoadClass } from './types.js';
import { admissionRank, effectivePriority, agingPoints, type QuickCheck } from './capacity/priority.js';

export type Ticket = {
  id: string; project: string; repo: string; objective: string; acceptance: string | null; issue: number | null; baseRef: string;
  statedPriority: Priority; effectivePriority: Priority; requestedBy: 'owner' | 'auto'; state: 'queued' | 'dispatched' | 'done' | 'failed' | 'cancelled';
  workerId: string | null; createdAt: string; dispatchedAt: string | null; finishedAt: string | null; etaAt: string | null; lastPosition: number;
  loadClass: LoadClass; payload: string; idempotencyKey: string | null; quickCheck: string;
};
export function ensureTickets(store: Pick<Store, 'sql'>): void {
  store.sql.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, repo TEXT NOT NULL, objective TEXT NOT NULL, acceptance TEXT, issue INTEGER, baseRef TEXT NOT NULL,
    statedPriority TEXT NOT NULL, effectivePriority TEXT NOT NULL, requestedBy TEXT NOT NULL, state TEXT NOT NULL,
    workerId TEXT, createdAt TEXT NOT NULL, dispatchedAt TEXT, finishedAt TEXT, etaAt TEXT, lastPosition INTEGER NOT NULL DEFAULT 0,
    loadClass TEXT NOT NULL, payload TEXT NOT NULL, idempotencyKey TEXT, quickCheck TEXT NOT NULL DEFAULT '{}'
  ); CREATE INDEX IF NOT EXISTS tickets_state ON tickets(state, createdAt);
  CREATE INDEX IF NOT EXISTS tickets_worker ON tickets(workerId);
  CREATE UNIQUE INDEX IF NOT EXISTS tickets_idempotency ON tickets(idempotencyKey) WHERE idempotencyKey IS NOT NULL;`);
}
export function getTicket(store: Store, id: string): Ticket | undefined { return store.sql.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Ticket | undefined; }
export function insertTicket(store: Store, ticket: Ticket): void {
  const entries = Object.entries(ticket);
  store.sql.prepare(`INSERT INTO tickets (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`).run(...entries.map(([, value]) => value));
}
export function ticketRank(ticket: Ticket) { return admissionRank(ticket.effectivePriority, ticket.requestedBy, (JSON.parse(ticket.quickCheck) as QuickCheck).size); }
export function ticketLane(ticket: Pick<Ticket, 'effectivePriority' | 'requestedBy' | 'payload'>): number {
  if (JSON.parse(ticket.payload).input?.role === 'reviewer') return 1;
  return ticket.requestedBy === 'owner' || ticket.effectivePriority === 'urgent' ? 1.5 : 2;
}
export function bumpTicket(store: Store, ticket: Ticket, priority: Priority): void {
  const effective = effectivePriority(priority, JSON.parse(ticket.quickCheck));
  const next = { ...ticket, statedPriority: priority, effectivePriority: effective };
  const payload = JSON.parse(ticket.payload);
  if (payload.input) payload.input.priority = priority;
  store.sql.prepare('UPDATE tickets SET statedPriority = ?, effectivePriority = ?, payload = ? WHERE id = ?').run(priority, effective, JSON.stringify(payload), ticket.id);
  store.sql.prepare('UPDATE capacity_jobs SET priority = ?, rank = ? WHERE id = ? AND startedAt IS NULL AND endedAt IS NULL').run(ticketLane(next), JSON.stringify(ticketRank(next)), ticket.id);
}
/** One bounded history query per refresh, with median duration grouped by load class. */
export function refreshTickets(store: Store, concurrency: number, now = new Date()): void {
  const history = store.sql.prepare("SELECT loadClass, durationMs FROM capacity_jobs WHERE kind = 'builder' AND startedAt IS NOT NULL AND durationMs > 0 AND endedAt >= ? ORDER BY durationMs").all(new Date(now.getTime() - 14 * 86400_000).toISOString()) as Array<{ loadClass: LoadClass; durationMs: number }>;
  const medians = new Map<LoadClass, number>();
  for (const load of ['light', 'medium', 'heavy'] as const) {
    const values = history.filter((row) => row.loadClass === load).map((row) => row.durationMs / 60_000), mid = Math.floor(values.length / 2);
    medians.set(load, values.length ? values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2 : 20);
  }
  const predicted = (load: LoadClass) => medians.get(load) ?? 20;
  let minutes = (store.sql.prepare('SELECT loadClass, startedAt FROM capacity_jobs WHERE startedAt IS NOT NULL AND endedAt IS NULL').all() as Array<{ loadClass: LoadClass; startedAt: string }>).reduce((sum, row) => sum + Math.max(0, predicted(row.loadClass) - (now.getTime() - Date.parse(row.startedAt)) / 60_000), 0);
  const jobs = store.sql.prepare("SELECT t.*, c.priority, c.queuedAt, c.rowid AS queueOrder, json_extract(c.rank, '$.base') AS baseScore FROM tickets t JOIN capacity_jobs c ON c.id = t.id WHERE t.state = 'queued' AND c.startedAt IS NULL AND c.endedAt IS NULL").all() as Array<Ticket & { priority: number; queuedAt: string; queueOrder: number; baseScore: number }>;
  const score = (row: (typeof jobs)[number]) => row.baseScore + agingPoints(Math.max(0, now.getTime() - Date.parse(row.queuedAt)));
  jobs.sort((a, b) => a.priority - b.priority || score(b) - score(a) || a.queuedAt.localeCompare(b.queuedAt) || a.queueOrder - b.queueOrder);

  const running = Number((store.sql.prepare('SELECT COUNT(*) AS n FROM capacity_jobs WHERE startedAt IS NOT NULL AND endedAt IS NULL').get() as { n: number }).n);
  const divisor = concurrency > 0 ? concurrency : Math.max(1, running);
  jobs.forEach((ticket, index) => {
    store.sql.prepare('UPDATE tickets SET lastPosition = ?, etaAt = ? WHERE id = ?').run(index + 1, new Date(now.getTime() + minutes / divisor * 60_000).toISOString(), ticket.id);
    minutes += predicted(ticket.loadClass);
  });
}
export function ticketView(ticket: Ticket, now = new Date()) {
  return { ticketId: ticket.id, state: ticket.state, position: ticket.state === 'queued' ? ticket.lastPosition : 0, etaMinutes: ticket.state === 'queued' && ticket.etaAt ? Math.max(0, Math.ceil((Date.parse(ticket.etaAt) - now.getTime()) / 60_000)) : 0, ...(ticket.workerId ? { workerId: ticket.workerId } : {}) };
}
export function statusSections(store: Store, now = new Date()) {
  const backlog = (store.sql.prepare("SELECT * FROM tickets WHERE state = 'queued' ORDER BY lastPosition, createdAt").all() as Ticket[]).map((ticket) => ({ ...ticketView(ticket, now), id: ticket.id, project: ticket.project, priority: ticket.effectivePriority, ageMinutes: Math.max(0, Math.floor((now.getTime() - Date.parse(ticket.createdAt)) / 60_000)) }));
  const working = store.listWorkers().filter((worker) => ['running', 'queued', 'waiting'].includes(worker.state)).map((worker) => ({ workerId: worker.workerId, project: worker.repoSlug, model: worker.model, state: worker.state, elapsedMinutes: Math.max(0, Math.floor((now.getTime() - Date.parse(worker.createdAt)) / 60_000)), pr: store.getPrByWorker(worker.workerId)?.number ?? null }));
  const recent = (store.sql.prepare("SELECT * FROM tickets WHERE state IN ('done','failed') AND finishedAt >= ? ORDER BY finishedAt DESC LIMIT 10").all(new Date(now.getTime() - 86400_000).toISOString()) as Ticket[]).map((ticket) => { const pr = ticket.workerId ? store.getPrByWorker(ticket.workerId) : undefined; return { id: ticket.id, workerId: ticket.workerId, project: ticket.project, state: ticket.state, pr: pr?.number ?? null, merged: pr?.state === 'merged' }; });
  return { backlog, working, recent };
}
export function statusLines(sections: ReturnType<typeof statusSections>): string {
  const clean = (value: string) => value.replace(/[\r\n\t]/g, ' ').slice(0, 100);
  return ['Backlog', ...sections.backlog.slice(0, 5).map((row) => `${row.id} ${clean(row.project)} ${row.priority} #${row.position} ETA ${row.etaMinutes}m age ${row.ageMinutes}m`), 'Working', ...sections.working.slice(0, 5).map((row) => `${row.workerId} ${clean(row.project)} ${clean(row.model)} ${row.state} ${row.elapsedMinutes}m PR#${row.pr ?? '-'}`), 'Recent', ...sections.recent.map((row) => `${row.id} ${clean(row.project)} ${row.state} PR#${row.pr ?? '-'} merged ${row.merged ? 'yes' : 'no'}`)].join('\n');
}
