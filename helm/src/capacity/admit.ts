import { loadSettings, type Settings } from '../settings.js';
import { existsSync } from 'node:fs';
import type { Store, LoadClass } from '../types.js';
import { agingPoints, type AdmissionRank } from './priority.js';
import { createCapacitySampler, type CapacityExec, type CapacitySampler, type CapacitySnapshot } from './sampler.js';

export type CapacityJobKind = 'builder' | 'review' | 'gate' | 'validator';
export type CapacityJob = Readonly<{ id: string; workerId: string; kind: CapacityJobKind; loadClass: LoadClass; priority?: number; rank?: AdmissionRank; dedupeKey?: string; payload?: unknown; pid?: number }>;
export type CapacityQueueEntry = Readonly<{ id: string; workerId: string; kind: CapacityJobKind; loadClass: LoadClass; queuedAt: string; waitMs: number; priority: number; score: number; reasons: readonly string[]; dedupeKey?: string }>;
export type CapacityStatus = Readonly<{
  budget: number;
  usedUnits: number;
  availableUnits: number;
  runningJobs: number;
  maxWorkers: number;
  processLimited: boolean;
  runningClasses: Readonly<Record<LoadClass, number>>;
  queue: readonly CapacityQueueEntry[];
  snapshot: CapacitySnapshot;
}>;

type SettingsLoader = () => Settings['capacity'];
type Callback = () => void | Promise<void>;
type Rehydrator = (job: CapacityJob) => Callback | undefined;

const DEFAULT_CAPACITY = { sampleSec: 5, reserveGb: 2, gbPerUnit: 1, units: { light: 1, medium: 2, heavy: 4 }, pressureWarnPenalty: 1, pressureCriticalPenalty: 2, simulatorPenalty: 1, processHeadroomMinPct: 0.15, waitMilestoneMin: 10 };
const AGING_MS = 60_000;

function priority(kind: CapacityJobKind): number {
  return kind === 'gate' ? 0 : kind === 'review' ? 1 : 2;
}

function processSensitive(kind: CapacityJobKind): boolean {
  return kind === 'builder' || kind === 'validator' || kind === 'gate';
}

function rssMb(output: string, rootPid = process.pid): number {
  const rows = output.split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length >= 3 && row.every(Number.isFinite));
  const children = new Map<number, number[]>();
  for (const row of rows) { const pid = row[0]!; const ppid = row[1]!; children.set(ppid, [...(children.get(ppid) ?? []), pid]); }
  const pids = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length) for (const child of children.get(pending.pop()!) ?? []) { if (pids.has(child)) continue; pids.add(child); pending.push(child); }
  return rows.filter((row) => pids.has(row[0]!)).reduce((total, row) => total + (row[2] ?? 0), 0) / 1024;
}

export type CapacityAdmission = Readonly<{
  admit(job: CapacityJob, callback: Callback): Promise<{ started: true } | { queued: true }>;
  finish(id: string): void;
  cancel(id: string, reason?: string): void;
  setPid(id: string, pid: number): void;
  updatePayload(id: string, payload: unknown): void;
  rehydrate(factory: Rehydrator): void;
  findQueued(workerId: string, kind: CapacityJobKind, dedupeKey?: string): CapacityQueueEntry | undefined;
  tick(): Promise<void>;
  close(): Promise<void>;
  status(): Promise<CapacityStatus>;
  sampler: CapacitySampler;
}>;

export function createCapacityAdmission(options: Readonly<{
  home: string;
  maxWorkers: number | (() => number);
  store: Store;
  settings: Pick<Settings, 'capacity'>;
  sampler?: CapacitySampler;
  exec?: CapacityExec;
  statfs?: (path: string) => Promise<{ bavail: number; bsize: number }>;
  now?: () => Date;
  reload?: SettingsLoader;
  canStart?: (job: CapacityJob) => boolean;
}>): CapacityAdmission {
  const now = options.now ?? (() => new Date());
  const maxWorkers = (): number => typeof options.maxWorkers === 'function' ? options.maxWorkers() : options.maxWorkers;
  const baseSettings = options.settings.capacity ?? loadSettings('/missing-capacity-settings').capacity!;
  const settings = (): NonNullable<Settings['capacity']> => {
    try { return options.reload?.() ?? (existsSync(`${options.home}/helm.json`) ? loadSettings(options.home).capacity! : baseSettings); } catch { return baseSettings; }
  };
  const sampler = options.sampler ?? createCapacitySampler({ home: options.home, store: options.store, sampleSec: settings().sampleSec, exec: options.exec, statfs: options.statfs, now });
  const callbacks = new Map<string, Callback>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const rssSamples = new Set<Promise<void>>();
  let ticking: Promise<void> | undefined;
  let closed = false;
  const testWithoutCapacityOverrides = (process.argv.includes('--test') || process.env.NODE_TEST_CONTEXT !== undefined) && !options.sampler && !options.exec;

  options.store.sql.exec(`
    CREATE TABLE IF NOT EXISTS capacity_jobs (
      id TEXT PRIMARY KEY,
      workerId TEXT NOT NULL,
      kind TEXT NOT NULL,
      loadClass TEXT NOT NULL,
      priority INTEGER NOT NULL,
      queuedAt TEXT NOT NULL,
      startedAt TEXT,
      endedAt TEXT,
      durationMs INTEGER,
      peakRssMb REAL,
      notifiedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS capacity_jobs_worker ON capacity_jobs(workerId);
    CREATE INDEX IF NOT EXISTS capacity_jobs_queue ON capacity_jobs (endedAt, startedAt, priority, queuedAt);
  `);
  for (const column of ['payload TEXT', 'pid INTEGER', 'dedupeKey TEXT', 'rank TEXT']) {
    try { options.store.sql.exec(`ALTER TABLE capacity_jobs ADD COLUMN ${column}`); } catch { /* already present */ }
  }
  function unit(loadClass: LoadClass): number { return settings().units[loadClass]; }

  function projects(): string[] {
    const values = new Set(options.store.listWorkers().map((worker) => worker.repoSlug));
    try {
      for (const row of options.store.sql.prepare('SELECT project FROM supervisors').all() as Array<{ project?: unknown }>) {
        if (typeof row.project === 'string' && row.project) values.add(row.project);
      }
    } catch { /* the optional supervisor service may not have initialized its table */ }
    return [...values];
  }

  function queueEntries(rows: Array<Record<string, unknown>>): CapacityQueueEntry[] {
    return rows.map((row) => {
      const { base, reasons } = jobFromRow(row).rank ?? { base: 10, reasons: [] }, waitMs = Math.max(0, now().getTime() - Date.parse(String(row.queuedAt))), aging = agingPoints(waitMs);
      return {
        id: String(row.id), workerId: String(row.workerId), kind: String(row.kind) as CapacityJobKind, loadClass: String(row.loadClass) as LoadClass, queuedAt: String(row.queuedAt), waitMs, priority: Number(row.priority),
        score: base + aging, reasons: aging ? [...reasons, `aging +${aging}`] : reasons, ...(row.dedupeKey ? { dedupeKey: String(row.dedupeKey) } : {}),
      };
    }).sort((a, b) => a.priority - b.priority || b.score - a.score || a.queuedAt.localeCompare(b.queuedAt));
  }

  function processAlert(snapshot: CapacitySnapshot, current: NonNullable<Settings['capacity']>): void {
    const headroom = snapshot.processHeadroomPct;
    if (typeof headroom !== 'number' || headroom >= current.processHeadroomMinPct) return;
    const at = now();
    const top = snapshot.topProcesses ?? [];
    for (const project of projects()) {
      const workerId = `project:${project}`;
      const previous = options.store.listEvents(workerId, { limit: 1_000_000 }).reverse().find((event) => event.kind === 'watch.alert' && event.data.rule === 'procs.low');
      if (previous && at.getTime() - Date.parse(previous.at) < 60 * 60_000) continue;
      options.store.appendEvent(workerId, 'watch.alert', {
        rule: 'procs.low',
        detail: { processCount: snapshot.processCount, maxProcesses: snapshot.maxProcesses, headroomPct: headroom, topProcesses: top },
        project,
      }, at.toISOString());
    }
  }

  function pidAlive(pid: number | null | undefined): boolean {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }

  function jobFromRow(row: Record<string, unknown>): CapacityJob {
    let payload: unknown;
    try { payload = row.payload ? JSON.parse(String(row.payload)) : undefined; } catch { payload = undefined; }
    return {
      id: String(row.id), workerId: String(row.workerId), kind: String(row.kind) as CapacityJobKind,
      loadClass: String(row.loadClass) as LoadClass, priority: Number(row.priority),
      ...(row.dedupeKey ? { dedupeKey: String(row.dedupeKey) } : {}), ...(payload === undefined ? {} : { payload }), ...(row.rank ? { rank: JSON.parse(String(row.rank)) as AdmissionRank } : {}),
      ...(row.pid === null || row.pid === undefined ? {} : { pid: Number(row.pid) }),
    };
  }

  function releaseDeadProcesses(includeUnknown = false): void {
    const rows = options.store.sql.prepare(`SELECT id,pid FROM capacity_jobs WHERE endedAt IS NULL AND startedAt IS NOT NULL${includeUnknown ? '' : ' AND pid IS NOT NULL'}`).all() as Array<{ id?: unknown; pid?: unknown }>;
    for (const row of rows) {
      const pid = row.pid === null || row.pid === undefined ? undefined : Number(row.pid);
      if (pidAlive(pid)) continue;
      options.store.sql.prepare('UPDATE capacity_jobs SET endedAt = ?, durationMs = MAX(0, ? - CAST(strftime(\'%s\', startedAt) AS INTEGER) * 1000) WHERE id = ? AND endedAt IS NULL').run(now().toISOString(), now().getTime(), String(row.id));
      callbacks.delete(String(row.id));
    }
  }

  releaseDeadProcesses(true);

  async function status(): Promise<CapacityStatus> {
    releaseDeadProcesses();
    const snapshot = await sampler.sample();
    const current = settings() ?? DEFAULT_CAPACITY;
    processAlert(snapshot, current);
    const processLimited = typeof snapshot.processHeadroomPct === 'number' && snapshot.processHeadroomPct < current.processHeadroomMinPct;
    const rows = options.store.sql.prepare('SELECT * FROM capacity_jobs WHERE endedAt IS NULL').all() as Array<Record<string, unknown>>;
    const running = rows.filter((row) => row.startedAt !== null && row.startedAt !== undefined);
    const usedUnits = running.reduce((total, row) => total + unit(String(row.loadClass) as LoadClass), 0);
    const ceiling = maxWorkers();
    const pressureAvailableGb = snapshot.pressureFreePct !== undefined && snapshot.totalRamGb !== undefined
      ? snapshot.pressureFreePct / 100 * snapshot.totalRamGb
      : snapshot.freeRamGb;
    const availableGb = snapshot.memoryPressure === 'critical'
      ? 0
      : snapshot.memoryPressure === 'warn'
        ? Math.max(snapshot.freeRamGb, pressureAvailableGb) / 2
        : Math.max(snapshot.freeRamGb, pressureAvailableGb);
    const ramUnits = testWithoutCapacityOverrides ? Number.MAX_SAFE_INTEGER : Math.floor(Math.max(0, availableGb - current.reserveGb) / Math.max(current.gbPerUnit, 0.1));
    const resourceBudget = Math.max(0, ramUnits - (snapshot.bootedSimulators ?? 0) * current.simulatorPenalty);
    const budget = processLimited ? 0 : resourceBudget;
    const queue = queueEntries(rows.filter((row) => row.startedAt === null || row.startedAt === undefined));
    const runningClasses: Record<LoadClass, number> = { light: 0, medium: 0, heavy: 0 };
    for (const row of running) { const loadClass = String(row.loadClass) as LoadClass; if (loadClass in runningClasses) runningClasses[loadClass] += 1; }
    return { budget, usedUnits, availableUnits: Math.max(0, budget - usedUnits), runningJobs: running.length, maxWorkers: ceiling, processLimited, runningClasses, queue, snapshot };
  }

  async function sampleRss(id: string): Promise<void> {
    if (!options.exec) return;
    try {
      const row = options.store.sql.prepare('SELECT pid FROM capacity_jobs WHERE id = ?').get(id) as { pid?: unknown } | undefined;
      const pid = row?.pid === null || row?.pid === undefined ? undefined : Number(row.pid);
      if (!pid) return;
      const result = await options.exec('ps', ['-axo', 'pid=,ppid=,rss='], { timeoutMs: 1000 });
      const peak = rssMb(result.stdout, pid);
      options.store.sql.prepare('UPDATE capacity_jobs SET peakRssMb = MAX(COALESCE(peakRssMb, 0), ?) WHERE id = ?').run(peak, id);
    } catch { /* telemetry must never affect the job */ }
  }

  function sampleRssTracked(id: string): void {
    const pending = sampleRss(id);
    rssSamples.add(pending);
    void pending.then(() => rssSamples.delete(pending), () => rssSamples.delete(pending));
  }

  function start(row: CapacityJob): void {
    const startedAt = now().toISOString();
    const changed = options.store.sql.prepare('UPDATE capacity_jobs SET startedAt = ?, pid = ? WHERE id = ? AND startedAt IS NULL AND endedAt IS NULL').run(startedAt, row.pid ?? null, row.id);
    if (!Number(changed.changes)) return;
    const { score, reasons } = queueEntries([options.store.sql.prepare('SELECT * FROM capacity_jobs WHERE id = ?').get(row.id) as Record<string, unknown>])[0]!;
    options.store.appendEvent(row.workerId, 'capacity.started', { kind: row.kind, loadClass: row.loadClass, units: unit(row.loadClass), score, reasons });
    const timer = setInterval(() => { sampleRssTracked(row.id); }, 1000);
    timer.unref?.();
    timers.set(row.id, timer);
    sampleRssTracked(row.id);
    try {
      const result = callbacks.get(row.id)?.();
      if (result && typeof (result as Promise<void>).then === 'function') {
        void Promise.resolve(result).catch((error) => {
          options.store.appendEvent(row.workerId, 'capacity.error', { message: error instanceof Error ? error.message : String(error) });
        }).finally(() => finish(row.id));
      }
    } catch (error) {
      options.store.appendEvent(row.workerId, 'capacity.error', { message: error instanceof Error ? error.message : String(error) });
      finish(row.id);
    }
  }

  async function tick(): Promise<void> {
    if (closed) return;
    if (ticking) return ticking;
    ticking = (async () => {
      const current = settings() ?? DEFAULT_CAPACITY;
      const currentStatus = await status();
      for (const entry of currentStatus.queue) {
        if (entry.waitMs >= current.waitMilestoneMin * 60_000) {
          const changed = options.store.sql.prepare('UPDATE capacity_jobs SET notifiedAt = ? WHERE id = ? AND notifiedAt IS NULL').run(now().toISOString(), entry.id);
          if (Number(changed.changes)) options.store.appendEvent(entry.workerId, 'capacity.waiting', { kind: entry.kind, loadClass: entry.loadClass, waitedMs: entry.waitMs });
        }
      }
      let statusNow = currentStatus;
      while (statusNow.queue.length) {
        const eligible = statusNow.queue.filter((entry) => !options.canStart || options.canStart(jobFromRow(options.store.sql.prepare('SELECT * FROM capacity_jobs WHERE id = ?').get(entry.id) as Record<string, unknown>)));
        const head = eligible[0];
        if (!head) break;
        const fits = (entry: CapacityQueueEntry) => !(statusNow.processLimited && processSensitive(entry.kind)) && (statusNow.maxWorkers === 0 || statusNow.runningJobs < statusNow.maxWorkers) && (statusNow.runningJobs === 0 || statusNow.availableUnits >= unit(entry.loadClass));
        const headFits = fits(head);
        if (!headFits && head.waitMs >= AGING_MS) break;
        const entry = headFits ? head : eligible.slice(1).find((candidate) => unit(candidate.loadClass) < unit(head.loadClass) && fits(candidate));
        if (!entry || !callbacks.has(entry.id)) break;
        start(jobFromRow(options.store.sql.prepare('SELECT * FROM capacity_jobs WHERE id = ?').get(entry.id) as Record<string, unknown>));
        statusNow = await status();
      }
    })().finally(() => { ticking = undefined; });
    return ticking;
  }

  async function admit(job: CapacityJob, callback: Callback): Promise<{ started: true } | { queued: true }> {
    callbacks.set(job.id, callback);
    options.store.sql.prepare(`INSERT OR IGNORE INTO capacity_jobs (id, workerId, kind, loadClass, priority, queuedAt, payload, pid, dedupeKey, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.workerId, job.kind, job.loadClass, job.priority ?? priority(job.kind), now().toISOString(), job.payload === undefined ? null : JSON.stringify(job.payload), job.pid ?? null, job.dedupeKey ?? null, job.rank ? JSON.stringify(job.rank) : null);
    const current = await status();
    const countFits = current.maxWorkers === 0 || current.runningJobs < current.maxWorkers;
    const resourceFits = current.runningJobs === 0 || current.availableUnits >= unit(job.loadClass);
    const newPriority = job.priority ?? priority(job.kind);
    const self = current.queue.find((entry) => entry.id === job.id);
    const hasEarlierJob = current.queue.some((entry) => entry.id !== job.id && (entry.priority < newPriority || entry.priority === newPriority && entry.score >= (self?.score ?? 10)));
    if ((options.canStart && !options.canStart(job)) || (current.processLimited && processSensitive(job.kind)) || !countFits || !resourceFits || hasEarlierJob) {
      options.store.appendEvent(job.workerId, 'capacity.queued', { kind: job.kind, loadClass: job.loadClass, units: unit(job.loadClass), budget: current.budget, usedUnits: current.usedUnits, score: self?.score, reasons: self?.reasons });
      return { queued: true };
    }
    start(job);
    return { started: true };
  }

  function finish(id: string): void {
    const timer = timers.get(id);
    if (timer) clearInterval(timer);
    timers.delete(id);
    const endedAt = now().toISOString();
    options.store.sql.prepare('UPDATE capacity_jobs SET endedAt = ?, durationMs = MAX(0, ? - CAST(strftime(\'%s\', startedAt) AS INTEGER) * 1000) WHERE id = ? AND endedAt IS NULL')
      .run(endedAt, now().getTime(), id);
    callbacks.delete(id);
    void tick().catch(() => undefined);
  }

  function cancel(id: string, reason = 'cancelled'): void {
    const row = options.store.sql.prepare('SELECT workerId FROM capacity_jobs WHERE id = ? AND endedAt IS NULL').get(id) as { workerId?: unknown } | undefined;
    if (!row) return;
    options.store.sql.prepare('UPDATE capacity_jobs SET endedAt = ?, durationMs = 0 WHERE id = ? AND startedAt IS NULL AND endedAt IS NULL').run(now().toISOString(), id);
    callbacks.delete(id);
    options.store.appendEvent(String(row.workerId), 'capacity.cancelled', { reason });
  }

  function setPid(id: string, pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    options.store.sql.prepare('UPDATE capacity_jobs SET pid = ? WHERE id = ? AND endedAt IS NULL').run(pid, id);
    sampleRssTracked(id);
  }

  async function close(): Promise<void> {
    if (closed) {
      if (ticking) await ticking;
      return;
    }
    closed = true;
    sampler.stop();
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    if (ticking) await ticking;
    await Promise.all([...rssSamples]);
    await sampler.close?.();
  }

  function updatePayload(id: string, payload: unknown): void {
    options.store.sql.prepare('UPDATE capacity_jobs SET payload = ? WHERE id = ? AND endedAt IS NULL').run(JSON.stringify(payload), id);
  }

  function rehydrate(factory: Rehydrator): void {
    const rows = options.store.sql.prepare('SELECT * FROM capacity_jobs WHERE endedAt IS NULL AND startedAt IS NULL').all() as Array<Record<string, unknown>>;
    for (const raw of rows) {
      const job = jobFromRow(raw);
      const callback = factory(job);
      if (callback) callbacks.set(job.id, callback);
      else cancel(job.id, 'no longer resumable');
    }
  }

  function findQueued(workerId: string, kind: CapacityJobKind, dedupeKey?: string): CapacityQueueEntry | undefined {
    return queueEntries(options.store.sql.prepare('SELECT * FROM capacity_jobs WHERE endedAt IS NULL AND startedAt IS NULL').all() as Array<Record<string, unknown>>).find((row) => String(row.workerId) === workerId && row.kind === kind && (dedupeKey === undefined || row.dedupeKey === dedupeKey));
  }

  return { admit, finish, cancel, setPid, updatePayload, rehydrate, findQueued, tick, close, status, sampler };
}
