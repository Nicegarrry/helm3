import { randomUUID } from 'node:crypto';
import type { EventRow, Store, SupervisorHost, SupervisorRow, WakeRow, ToolOutcome } from './types.js';
import { consumer } from './daemon.js';
import type { Settings } from './settings.js';
import type { Host } from './host.js';

export type SupervisorRegisterInput = Readonly<{ project: string; repo: string; host: SupervisorHost; label: string }>;
export type WakeListInput = Readonly<{ project: string; ack: boolean }>;
export type SupervisorRotateInput = Readonly<{ project: string; focus: string }>;

export type SupervisorService = Readonly<{
  register(input: SupervisorRegisterInput): ToolOutcome<{ supervisor: SupervisorRow }>;
  list(): ToolOutcome<{ supervisors: SupervisorRow[] }>;
  wakes(input: WakeListInput): ToolOutcome<{ wakes: WakeRow[] }>;
  rotate(input: SupervisorRotateInput): ToolOutcome<{ wakes: WakeRow[] }>;
  manualWake(project: string, text: string): ToolOutcome<{ wake: WakeRow }>;
  consume(): Promise<void>;
  tick(): Promise<void>;
}>;

type Options = Readonly<{
  store: Store;
  settings: Settings;
  hosts: Readonly<Record<SupervisorHost, Host>>;
  now?: () => Date;
  log?: (line: string) => void;
}>;

const STATE_WAKE_TARGETS = new Set(['succeeded', 'failed', 'idle', 'waiting', 'unknown', 'stopped']);

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function toSupervisor(row: Record<string, unknown>): SupervisorRow {
  return {
    project: row.project as string,
    repo: row.repo as string,
    host: row.host as SupervisorHost,
    label: row.label as string,
    createdAt: row.createdAt as string,
    lastWakeAt: (row.lastWakeAt as string | null) ?? null,
  };
}

function toWake(row: Record<string, unknown>): WakeRow {
  return {
    id: row.id as string,
    project: row.project as string,
    kind: row.kind as string,
    workerId: (row.workerId as string | null) ?? null,
    summary: row.summary as string,
    command: Boolean(row.command),
    createdAt: row.createdAt as string,
    deliveredAt: (row.deliveredAt as string | null) ?? null,
    ackedAt: (row.ackedAt as string | null) ?? null,
  };
}

function eventWake(event: EventRow, project: string, now: string): Omit<WakeRow, 'deliveredAt' | 'ackedAt'> | null {
  if (event.kind === 'ask') {
    return { id: `wake-${randomUUID()}`, project, kind: 'ask', workerId: event.workerId, summary: String(event.data.question ?? event.data.summary ?? 'worker asked a question'), command: false, createdAt: now };
  }
  if (event.kind === 'watch.alert') {
    return { id: `wake-${randomUUID()}`, project, kind: 'watch.alert', workerId: event.workerId, summary: String(event.data.detail ?? event.data.summary ?? event.data.rule ?? 'watch alert'), command: false, createdAt: now };
  }
  if (event.kind === 'state' && STATE_WAKE_TARGETS.has(String(event.data.to ?? ''))) {
    const target = String(event.data.to);
    return { id: `wake-${randomUUID()}`, project, kind: 'state', workerId: event.workerId, summary: `worker ${target}`, command: false, createdAt: now };
  }
  return null;
}

function ascii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function createSupervisor(options: Options): SupervisorService {
  const { store, settings, hosts } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.error(line));
  store.sql.exec(`
    CREATE TABLE IF NOT EXISTS supervisors (
      project TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      host TEXT NOT NULL,
      label TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastWakeAt TEXT
    );
    CREATE TABLE IF NOT EXISTS wakes (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      kind TEXT NOT NULL,
      workerId TEXT,
      summary TEXT NOT NULL,
      command INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      deliveredAt TEXT,
      ackedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS wakes_pending ON wakes(project, deliveredAt, createdAt);
  `);

  const listSupervisorsStmt = store.sql.prepare('SELECT * FROM supervisors ORDER BY project ASC');
  const getSupervisorStmt = store.sql.prepare('SELECT * FROM supervisors WHERE project = ?');
  const upsertSupervisorStmt = store.sql.prepare(`
    INSERT INTO supervisors (project, repo, host, label, createdAt, lastWakeAt) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(project) DO UPDATE SET repo = excluded.repo, host = excluded.host, label = excluded.label
  `);
  const insertWakeStmt = store.sql.prepare('INSERT INTO wakes (id, project, kind, workerId, summary, command, createdAt, deliveredAt, ackedAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)');
  const listWakesStmt = store.sql.prepare('SELECT * FROM wakes WHERE project = ? AND ackedAt IS NULL ORDER BY createdAt ASC, id ASC');
  const pendingWakesStmt = store.sql.prepare('SELECT * FROM wakes WHERE project = ? AND deliveredAt IS NULL ORDER BY createdAt ASC, id ASC');
  const markWakeDeliveredStmt = store.sql.prepare('UPDATE wakes SET deliveredAt = ? WHERE id = ? AND deliveredAt IS NULL');
  const markWakesAckedStmt = store.sql.prepare('UPDATE wakes SET ackedAt = ? WHERE project = ? AND ackedAt IS NULL');
  const updateLastWakeStmt = store.sql.prepare('UPDATE supervisors SET lastWakeAt = ? WHERE project = ?');
  const deliveredSinceStmt = store.sql.prepare('SELECT COUNT(DISTINCT deliveredAt) AS count FROM wakes WHERE project = ? AND deliveredAt >= ?');
  const warnedOld = new Set<string>();

  function supervisor(project: string): SupervisorRow | null {
    const row = getSupervisorStmt.get(project) as Record<string, unknown> | undefined;
    return row ? toSupervisor(row) : null;
  }

  function insertWake(wake: Omit<WakeRow, 'deliveredAt' | 'ackedAt'>): WakeRow {
    insertWakeStmt.run(wake.id, wake.project, wake.kind, wake.workerId, wake.summary, wake.command ? 1 : 0, wake.createdAt);
    return { ...wake, deliveredAt: null, ackedAt: null };
  }

  const consumeEvents = consumer(store, 'supervisor-wakes', async (events) => {
    for (const event of events) {
      const worker = store.getWorker(event.workerId);
      if (!worker) continue;
      if (!supervisor(worker.repoSlug)) continue;
      const wake = eventWake(event, worker.repoSlug, nowIso(now));
      if (wake) insertWake(wake);
    }
  });

  async function deliver(): Promise<void> {
    const current = now();
    const currentIso = current.toISOString();
    const supervisors = (listSupervisorsStmt.all() as Record<string, unknown>[]).map(toSupervisor);
    for (const registered of supervisors) {
      const pending = (pendingWakesStmt.all(registered.project) as Record<string, unknown>[]).map(toWake);
      if (!pending.length) continue;
      const ageLimit = current.getTime() - 30 * 60_000;
      for (const wake of pending) {
        if (!warnedOld.has(wake.id) && Date.parse(wake.createdAt) <= ageLimit) {
          warnedOld.add(wake.id);
          log(`daemon.log: wake ${wake.id} for ${registered.project} has been undelivered for over 30 minutes`);
        }
      }

      const command = pending.find((wake) => wake.command);
      const lastWake = registered.lastWakeAt ? Date.parse(registered.lastWakeAt) : 0;
      const intervalReady = !lastWake || current.getTime() - lastWake >= settings.wake.minIntervalSec * 1000;
      const deliveredCount = Number((deliveredSinceStmt.get(registered.project, new Date(current.getTime() - 60 * 60_000).toISOString()) as { count: number }).count);
      if (!intervalReady || deliveredCount >= settings.wake.maxPerHour) continue;

      const host = hosts[registered.host];
      let pane;
      try { pane = await host.resolve(registered.label); } catch { pane = null; }
      if (!pane) continue;
      let status;
      try { status = await host.status(pane); } catch { status = 'unknown'; }
      if (status !== 'idle') continue;
      try {
        if (!(await host.promptEmpty(pane))) continue;
      } catch {
        continue;
      }

      if (command) {
        await host.send(pane, command.summary);
        markWakeDeliveredStmt.run(currentIso, command.id);
      } else {
        const byKind = new Map<string, number>();
        for (const wake of pending) byKind.set(wake.kind, (byKind.get(wake.kind) ?? 0) + 1);
        const counts = [...byKind.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ');
        const line = `helm: ${pending.length} new for ${ascii(registered.project)} (${counts}). Call wake.list.`;
        await host.send(pane, line);
        for (const wake of pending) markWakeDeliveredStmt.run(currentIso, wake.id);
      }
      updateLastWakeStmt.run(currentIso, registered.project);
    }
  }

  return {
    register(input) {
      const createdAt = supervisor(input.project)?.createdAt ?? nowIso(now);
      upsertSupervisorStmt.run(input.project, input.repo, input.host, input.label, createdAt);
      return { ok: true, supervisor: supervisor(input.project)! };
    },
    list() {
      return { ok: true, supervisors: (listSupervisorsStmt.all() as Record<string, unknown>[]).map(toSupervisor) };
    },
    wakes(input) {
      if (!supervisor(input.project)) return { ok: false, reason: `supervisor not registered: ${input.project}` };
      const wakes = (listWakesStmt.all(input.project) as Record<string, unknown>[]).map(toWake);
      if (input.ack && wakes.length) markWakesAckedStmt.run(nowIso(now), input.project);
      return { ok: true, wakes };
    },
    rotate(input) {
      if (!supervisor(input.project)) return { ok: false, reason: `supervisor not registered: ${input.project}` };
      const createdAt = nowIso(now);
      const wakes = [
        insertWake({ id: `wake-${randomUUID()}`, project: input.project, kind: 'command', workerId: null, summary: `/compact ${ascii(input.focus)}`, command: true, createdAt }),
        insertWake({ id: `wake-${randomUUID()}`, project: input.project, kind: 'command', workerId: null, summary: 'helm: context rotated; run your startup read order.', command: true, createdAt: new Date(Date.parse(createdAt) + 1).toISOString() }),
      ];
      return { ok: true, wakes };
    },
    manualWake(project, text) {
      if (!supervisor(project)) return { ok: false, reason: `supervisor not registered: ${project}` };
      return { ok: true, wake: insertWake({ id: `wake-${randomUUID()}`, project, kind: 'manual', workerId: null, summary: text, command: true, createdAt: nowIso(now) }) };
    },
    consume: consumeEvents,
    async tick() {
      await consumeEvents();
      await deliver();
    },
  };
}
