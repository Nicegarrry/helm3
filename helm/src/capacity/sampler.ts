import { spawn } from 'node:child_process';
import { statfs as fsStatfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { Store } from '../types.js';
import type { StatfsResult } from '../hygiene.js';

export type MemoryPressure = 'normal' | 'warn' | 'critical' | 'unknown';
export type CapacityExecResult = { stdout: string; stderr?: string; code?: number; transient?: boolean };
export type CapacityExec = (file: string, args: string[], options: { timeoutMs: number }) => Promise<CapacityExecResult>;
export type CapacityRunning = Readonly<{ gates: number; builds: number; reviews: number }>;
export type ProcessCount = Readonly<{ name: string; count: number }>;
export type CapacitySnapshot = Readonly<{
  sampledAt: string;
  freeRamGb: number;
  totalRamGb?: number;
  pressureFreePct?: number;
  memoryPressure: MemoryPressure;
  load1: number;
  cpuCount: number;
  freeDiskGb: number | null;
  bootedSimulators: number | null;
  processCount?: number;
  maxProcesses?: number | null;
  processHeadroomPct?: number | null;
  topProcesses?: readonly ProcessCount[];
  running: CapacityRunning;
}>;

const GB = 1024 ** 3;

export const defaultExec: CapacityExec = (file, args, options) => new Promise((resolve) => {
  const child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', transient = false;
  const killGroup = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  };
  const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 2 * 1024 * 1024) { transient = true; killGroup(); }
  };
  child.stdout.on('data', (chunk: Buffer) => { append('stdout', chunk); });
  child.stderr.on('data', (chunk: Buffer) => { append('stderr', chunk); });
  child.on('error', (error) => { transient = true; stderr ||= error.message; });
  child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, ...(code === null ? {} : { code }), ...(transient || code === null ? { transient: true } : {}) }); });
  const timer = setTimeout(() => { transient = true; killGroup(); }, options.timeoutMs);
  timer.unref?.();
});

export function availableRamGbFromVmStat(output: string): number | null {
  const pageSize = Number(output.match(/page size of (\d+) bytes/i)?.[1] ?? 4096);
  const labels = /^(?:Pages free|Pages inactive|Pages speculative|Pages purgeable):\s+(\d+)/gim;
  let pages = 0;
  let match: RegExpExecArray | null;
  while ((match = labels.exec(output))) pages += Number(match[1]);
  return pages > 0 && Number.isFinite(pageSize) ? (pages * pageSize) / GB : null;
}

function lineCount(output: string): number {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

function topProcesses(output: string): ProcessCount[] {
  const counts = new Map<string, number>();
  for (const line of output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([name, count]) => ({ name, count }));
}

export function parseMemoryPressure(output: string): MemoryPressure {
  const lower = output.toLowerCase();
  if (/critical|severe|red/.test(lower)) return 'critical';
  if (/warn|yellow|moderate/.test(lower)) return 'warn';
  const percentage = parseMemoryPressureFreePct(output);
  if (percentage !== null) return percentage <= 5 ? 'critical' : percentage <= 15 ? 'warn' : 'normal';
  if (/normal|green|healthy/.test(lower)) return 'normal';
  return 'unknown';
}

export function parseMemoryPressureFreePct(output: string): number | null {
  const percentage = Number(output.toLowerCase().match(/free percentage\s*:\s*(\d+(?:\.\d+)?)\s*%/)?.[1]);
  return Number.isFinite(percentage) ? percentage : null;
}

export function countBootedSimulators(output: string): number {
  try {
    const root = JSON.parse(output) as { devices?: Record<string, Array<{ state?: string }>> };
    return Object.values(root.devices ?? {}).flat().filter((device) => device.state === 'Booted').length;
  } catch {
    return 0;
  }
}

export function createSimulatorProbe(exec: CapacityExec, now: () => number = Date.now): () => Promise<CapacityExecResult> {
  let firstLaunchReady: boolean | undefined;
  let retryFirstLaunchAt = 0;
  let inFlight: Promise<CapacityExecResult> | undefined;
  const safeExec = (file: string, args: string[], timeoutMs: number): Promise<CapacityExecResult> => exec(file, args, { timeoutMs }).catch(() => ({ stdout: '', transient: true }));
  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (firstLaunchReady === undefined && now() >= retryFirstLaunchAt) {
        const firstLaunch = await safeExec('xcodebuild', ['-checkFirstLaunchStatus'], 1_000);
        if (firstLaunch.transient || typeof firstLaunch.code !== 'number') retryFirstLaunchAt = now() + 10 * 60_000;
        else firstLaunchReady = firstLaunch.code === 0;
      }
      if (!firstLaunchReady) return { stdout: '', code: 1 };
      return safeExec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], 300);
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

function runningFromStore(store: Store): CapacityRunning {
  const workers = store.listWorkers().filter((worker) => worker.state === 'running');
  let gates = 0;
  try {
    gates = Number((store.sql.prepare("SELECT COUNT(*) AS count FROM capacity_jobs WHERE kind = 'gate' AND startedAt IS NOT NULL AND endedAt IS NULL").get() as { count?: number } | undefined)?.count ?? 0);
  } catch { /* the capacity table is created by the admission service */ }
  return {
    gates,
    builds: workers.filter((worker) => worker.role === 'builder' || worker.role === 'validator').length,
    reviews: workers.filter((worker) => worker.role === 'reviewer').length,
  };
}

export type CapacitySampler = Readonly<{
  sample(): Promise<CapacitySnapshot>;
  invalidate(): void;
  start(): void;
  stop(): void;
  close?: () => Promise<void>;
}>;

export function createCapacitySampler(options: Readonly<{
  home: string;
  store: Store;
  sampleSec?: number;
  exec?: CapacityExec;
  statfs?: (path: string) => Promise<StatfsResult>;
  now?: () => Date;
}>): CapacitySampler {
  const exec = options.exec ?? defaultExec;
  const statfs = options.statfs ?? fsStatfs;
  const now = options.now ?? (() => new Date());
  let cached: CapacitySnapshot | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sampling: Promise<CapacitySnapshot> | undefined;
  const safeExec = (file: string, args: string[], timeoutMs: number) => exec(file, args, { timeoutMs }).catch(() => ({ stdout: '', code: 1 }));
  const probeSimulators = createSimulatorProbe(exec);

  async function sample(): Promise<CapacitySnapshot> {
    if (cached && Date.parse(cached.sampledAt) + (options.sampleSec ?? 5) * 1000 > now().getTime()) return cached;
    if (sampling) return sampling;
    sampling = (async () => {
      const [vm, pressure, disk, simulators] = await Promise.all([
        safeExec('vm_stat', [], 500),
        safeExec('memory_pressure', ['-Q'], 500),
        statfs(options.home).catch(() => null),
        probeSimulators(),
      ]);
      const uid = typeof process.getuid === 'function' ? String(process.getuid()) : undefined;
      const [processes, names, maxProcesses] = uid ? await Promise.all([
        safeExec('ps', ['-U', uid, '-o', 'pid='], 500),
        safeExec('ps', ['-U', uid, '-o', 'comm='], 500),
        safeExec('sysctl', ['-n', 'kern.maxprocperuid'], 500),
      ]) : [{ stdout: '', code: 1 }, { stdout: '', code: 1 }, { stdout: '', code: 1 }];
      const processCount = uid ? lineCount(processes.stdout) : undefined;
      const max = Number(maxProcesses.stdout.trim().split(/\s+/)[0]);
      const maxCount = Number.isFinite(max) && max > 0 ? max : null;
      const freeRamGb = availableRamGbFromVmStat(vm.stdout) ?? freemem() / GB;
      const pressureFreePct = parseMemoryPressureFreePct(pressure.stdout);
      const result: CapacitySnapshot = {
        sampledAt: now().toISOString(),
        freeRamGb,
        totalRamGb: totalmem() / GB,
        ...(pressureFreePct === null ? {} : { pressureFreePct }),
        memoryPressure: parseMemoryPressure(pressure.stdout),
        load1: loadavg()[0] ?? 0,
        cpuCount: Math.max(1, cpus().length),
        freeDiskGb: disk ? (disk.bavail * disk.bsize) / GB : null,
        bootedSimulators: simulators.code === 0 ? countBootedSimulators(simulators.stdout) : null,
        ...(processCount !== undefined ? { processCount } : {}),
        maxProcesses: maxCount,
        processHeadroomPct: processCount !== undefined && maxCount ? Math.max(0, (maxCount - processCount) / maxCount) : null,
        topProcesses: topProcesses(names.stdout),
        running: runningFromStore(options.store),
      };
      cached = result;
      return result;
    })().finally(() => { sampling = undefined; });
    return sampling;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => { void sample().catch(() => undefined); }, Math.max(1, options.sampleSec ?? 5) * 1000);
    timer.unref?.();
  }

  return {
    sample,
    invalidate: () => { cached = undefined; },
    start,
    stop: () => { if (timer) clearInterval(timer); timer = undefined; },
    close: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      await sampling?.catch(() => undefined);
    },
  };
}
