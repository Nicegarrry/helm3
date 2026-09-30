import { loadSettings, type Settings } from '../settings.js';
import { existsSync } from 'node:fs';
import type { Store, LoadClass } from '../types.js';
import { createCapacitySampler, type CapacityExec, type CapacitySampler, type CapacitySnapshot } from './sampler.js';

export type CapacityJobKind = 'builder' | 'review' | 'gate' | 'validator';
export type CapacityJob = Readonly<{ id: string; workerId: string; kind: CapacityJobKind; loadClass: LoadClass; priority?: number }>;
export type CapacityQueueEntry = Readonly<{ id: string; workerId: string; kind: CapacityJobKind; loadClass: LoadClass; queuedAt: string; waitMs: number }>;
export type CapacityStatus = Readonly<{
  budget: number;
  usedUnits: number;
  availableUnits: number;
  runningClasses: Readonly<Record<LoadClass, number>>;
  queue: readonly CapacityQueueEntry[];
  snapshot: CapacitySnapshot;
}>;

type SettingsLoader = () => Settings['capacity'];
type Callback = () => void | Promise<void>;

const DEFAULT_CAPACITY = { sampleSec: 5, reserveGb: 4, gbPerUnit: 2, units: { light: 1, medium: 2, heavy: 4 }, pressureWarnPenalty: 1, pressureCriticalPenalty: 2, simulatorPenalty: 1, waitMilestoneMin: 10 };

function priority(kind: CapacityJobKind): number {
  return kind === 'gate' ? 0 : kind === 'review' ? 1 : 2;
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
  tick(): Promise<void>;
  status(): Promise<CapacityStatus>;
  sampler: CapacitySampler;
}>;

export function createCapacityAdmission(options: Readonly<{
  home: string;
  maxWorkers: number;
  store: Store;
  settings: Pick<Settings, 'capacity'>;
  sampler?: CapacitySampler;
  exec?: CapacityExec;
  statfs?: (path: string) => Promise<{ bavail: number; bsize: number }>;
  now?: () => Date;
  reload?: SettingsLoader;
}>): CapacityAdmission {
  const now = options.now ?? (() => new Date());
  const baseSettings = options.settings.capacity ?? loadSettings('/missing-capacity-settings').capacity!;
  const settings = (): NonNullable<Settings['capacity']> => {
    try { return options.reload?.() ?? (existsSync(`${options.home}/helm.json`) ? loadSettings(options.home).capacity! : baseSettings); } catch { return baseSettings; }
  };
  const sampler = options.sampler ?? createCapacitySampler({ home: options.home, store: options.store, sampleSec: settings().sampleSec, exec: options.exec, statfs: options.statfs, now });
  const callbacks = new Map<string, Callback>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
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
    CREATE INDEX IF NOT EXISTS capacity_jobs_queue ON capacity_jobs (endedAt, startedAt, priority, queuedAt);
  `);
  sampler.start();

  function unit(loadClass: LoadClass): number { return settings().units[loadClass]; }

  async function status(): Promise<CapacityStatus> {
    const snapshot = await sampler.sample();
    const current = settings() ?? DEFAULT_CAPACITY;
    const rows = options.store.sql.prepare('SELECT * FROM capacity_jobs WHERE endedAt IS NULL').all() as Array<Record<string, unknown>>;
    const running = rows.filter((row) => row.startedAt !== null && row.startedAt !== undefined);
    const usedUnits = running.reduce((total, row) => total + unit(String(row.loadClass) as LoadClass), 0);
    const telemetryUnavailable = snapshot.memoryPressure === 'unknown' && snapshot.freeRamGb < current.reserveGb;
    const ramUnits = testWithoutCapacityOverrides ? options.maxWorkers : telemetryUnavailable ? options.maxWorkers : Math.floor(Math.max(0, snapshot.freeRamGb - current.reserveGb) / Math.max(current.gbPerUnit, 0.1));
    const pressurePenalty = snapshot.memoryPressure === 'critical' ? current.pressureCriticalPenalty : snapshot.memoryPressure === 'warn' ? current.pressureWarnPenalty : 0;
    const budget = Math.max(0, Math.min(options.maxWorkers, ramUnits) - pressurePenalty - snapshot.bootedSimulators * current.simulatorPenalty);
    const queue = rows.filter((row) => row.startedAt === null || row.startedAt === undefined).sort((a, b) => Number(a.priority) - Number(b.priority) || String(a.queuedAt).localeCompare(String(b.queuedAt))).map((row) => ({
      id: String(row.id), workerId: String(row.workerId), kind: String(row.kind) as CapacityJobKind, loadClass: String(row.loadClass) as LoadClass, queuedAt: String(row.queuedAt), waitMs: Math.max(0, now().getTime() - Date.parse(String(row.queuedAt))),
    }));
    const runningClasses: Record<LoadClass, number> = { light: 0, medium: 0, heavy: 0 };
    for (const row of running) { const loadClass = String(row.loadClass) as LoadClass; if (loadClass in runningClasses) runningClasses[loadClass] += 1; }
    return { budget, usedUnits, availableUnits: Math.max(0, budget - usedUnits), runningClasses, queue, snapshot };
  }

  async function sampleRss(id: string): Promise<void> {
    if (!options.exec) return;
    try {
      const result = await options.exec('ps', ['-axo', 'pid=,ppid=,rss='], { timeoutMs: 1000 });
      const peak = rssMb(result.stdout);
      options.store.sql.prepare('UPDATE capacity_jobs SET peakRssMb = MAX(COALESCE(peakRssMb, 0), ?) WHERE id = ?').run(peak, id);
    } catch { /* telemetry must never affect the job */ }
  }

  async function start(row: CapacityJob): Promise<void> {
    const startedAt = now().toISOString();
    const changed = options.store.sql.prepare('UPDATE capacity_jobs SET startedAt = ? WHERE id = ? AND startedAt IS NULL AND endedAt IS NULL').run(startedAt, row.id);
    if (!Number(changed.changes)) return;
    options.store.appendEvent(row.workerId, 'capacity.started', { kind: row.kind, loadClass: row.loadClass, units: unit(row.loadClass) });
    const timer = setInterval(() => { void sampleRss(row.id); }, 1000);
    timer.unref?.();
    timers.set(row.id, timer);
    await sampleRss(row.id);
    await callbacks.get(row.id)?.();
  }

  async function tick(): Promise<void> {
    const current = settings() ?? DEFAULT_CAPACITY;
    const currentStatus = await status();
    for (const entry of currentStatus.queue) {
      if (entry.waitMs >= current.waitMilestoneMin * 60_000) {
        const changed = options.store.sql.prepare('UPDATE capacity_jobs SET notifiedAt = ? WHERE id = ? AND notifiedAt IS NULL').run(now().toISOString(), entry.id);
        if (Number(changed.changes)) options.store.appendEvent(entry.workerId, 'capacity.waiting', { kind: entry.kind, loadClass: entry.loadClass, waitedMs: entry.waitMs });
      }
    }
    for (const entry of currentStatus.queue) {
      const fresh = await status();
      if (fresh.availableUnits < unit(entry.loadClass)) continue;
      const row = { id: entry.id, workerId: entry.workerId, kind: entry.kind, loadClass: entry.loadClass } as CapacityJob;
      if (!callbacks.has(row.id)) continue;
      await start(row);
    }
  }

  async function admit(job: CapacityJob, callback: Callback): Promise<{ started: true } | { queued: true }> {
    callbacks.set(job.id, callback);
    options.store.sql.prepare(`INSERT OR IGNORE INTO capacity_jobs (id, workerId, kind, loadClass, priority, queuedAt) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.workerId, job.kind, job.loadClass, job.priority ?? priority(job.kind), now().toISOString());
    const current = await status();
    if (current.availableUnits < unit(job.loadClass)) {
      options.store.appendEvent(job.workerId, 'capacity.queued', { kind: job.kind, loadClass: job.loadClass, units: unit(job.loadClass), budget: current.budget, usedUnits: current.usedUnits });
      return { queued: true };
    }
    await start(job);
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

  return { admit, finish, tick, status, sampler };
}
