import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessIdentity = Readonly<{
  hostId: string;
  bootId: string;
  pid: number;
  startedAt: string;
}>;

export type ProcessObservation = Readonly<{
  state: 'same-process' | 'not-running' | 'unknown';
  observedAt: string;
  reason: string;
}>;

export type ProcessProbe = Readonly<{
  capture(): Promise<ProcessIdentity | undefined>;
  observe(identity: ProcessIdentity): Promise<ProcessObservation>;
}>;

const MAX_STRING_LEN = 256;
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function isNonEmptyBoundedString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING_LEN;
}

function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

export function validProcessIdentity(v: unknown): v is ProcessIdentity {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return isNonEmptyBoundedString(o.hostId) && isNonEmptyBoundedString(o.bootId) &&
    isPositiveSafeInt(o.pid) && isNonEmptyBoundedString(o.startedAt);
}

export interface ReadSnapshot {
  readFile(path: string): Promise<string>;
  execFile(file: string, args: string[], opts: { timeout: number; maxBuffer?: number; env: Record<string, string> }): Promise<string>;
  killSignal(pid: number, signal: number): 'ok' | 'esrch' | 'eperm' | 'unknown';
  platform(): string;
  ownPid(): number;
}

const defaultSnapshot: ReadSnapshot = {
  readFile(p: string) { return readFile(p, 'utf8'); },
  async execFile(file, args, opts) {
    const { stdout } = await execFileAsync(file, args, {
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer ?? 64 * 1024,
      env: opts.env,
    });
    return stdout;
  },
  killSignal(pid, signal) {
    try {
      process.kill(pid, signal);
      return 'ok';
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return 'esrch';
      if (code === 'EPERM') return 'eperm';
      return 'unknown';
    }
  },
  platform() { return process.platform; },
  ownPid() { return process.pid; },
};

export type ProbeErrorKind = 'esrch' | 'eperm' | 'ok' | 'unknown';

export function parseProcStat(content: string): { processState: string; starttime: string } | undefined {
  const match = content.match(/^(\d+)\s+\((.+)\)\s+(\S+)(?:\s+(\S+)){19,}/);
  if (!match || !isPositiveSafeInt(Number(match[1]))) return undefined;
  const lastParen = content.lastIndexOf(')');
  if (lastParen === -1) return undefined;
  const after = content.slice(lastParen + 1).trimStart().split(/\s+/);
  if (after.length < 20) return undefined;
  const processState = after[0];
  const starttime = after[19];
  if (!/^[RSDZTtWXKPI]$/.test(processState) || !/^\d+$/.test(starttime)) return undefined;
  return { processState, starttime };
}

export function parsePsOutput(output: string): { startedAt: string; processState: string } | undefined {
  const line = output.trim().split(/\r?\n/).pop()?.trim() ?? '';
  const match = line.match(/^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)$/);
  if (!match) return undefined;
  const [, rawDate, state] = match;
  if (!/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) /.test(rawDate) || !/^[IRSTUXZ][A-Za-z0-9+<>=-]*$/.test(state)) return undefined;
  const parts = rawDate.split(/\s+/);
  if (parts.length !== 5 || !(parts[1] in MONTHS)) return undefined;
  const [, mon, dayStr, timeStr, yearStr] = parts;
  const [hh, mm, ss] = timeStr.split(':').map(Number);
  const year = Number(yearStr);
  const day = Number(dayStr);
  const dt = new Date(Date.UTC(year, MONTHS[mon], day, hh, mm, ss));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== MONTHS[mon] || dt.getUTCDate() !== day ||
      dt.getUTCHours() !== hh || dt.getUTCMinutes() !== mm || dt.getUTCSeconds() !== ss) {
    return undefined;
  }
  return { startedAt: dt.toISOString(), processState: state };
}

export function parseBoottime(output: string): string | undefined {
  const sec = output.match(/\bsec\s*=\s*(\d+)/)?.[1];
  const usec = output.match(/usec\s*=\s*(\d+)/)?.[1];
  return (sec && usec && Number.isSafeInteger(Number(sec)) && Number(usec) < 1_000_000) ? `${Number(sec)}.${usec.padStart(6, '0')}` : undefined;
}

async function readBoot(snap: ReadSnapshot): Promise<string | undefined> {
  const p = snap.platform();
  try {
    if (p === 'linux') {
      const raw = (await snap.readFile('/proc/sys/kernel/random/boot_id')).trim();
      return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw) ? raw : undefined;
    }
    if (p === 'darwin') {
      const raw = await snap.execFile('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        timeout: 2000,
        maxBuffer: 4096,
        env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/sbin:/usr/bin:/bin:/sbin' },
      });
      return parseBoottime(raw);
    }
  } catch { /* empty */ }
  return undefined;
}

interface ProcessSample { startedAt: string; processState: string }

async function readProcess(pid: number, snap: ReadSnapshot): Promise<ProcessSample | undefined> {
  const p = snap.platform();
  try {
    if (p === 'linux') {
      const stat = await snap.readFile(`/proc/${pid}/stat`);
      const parsed = parseProcStat(stat);
      return parsed ? { startedAt: parsed.starttime, processState: parsed.processState } : undefined;
    }
    if (p === 'darwin') {
      const out = await snap.execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], {
        timeout: 2000,
        maxBuffer: 4096,
        env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/bin:/usr/bin' },
      });
      return parsePsOutput(out);
    }
  } catch { /* empty */ }
  return undefined;
}

function result(state: ProcessObservation['state'], reason: string): ProcessObservation {
  return Object.freeze({ state, observedAt: new Date().toISOString(), reason });
}

export function classifyObservation(params: {
  hostMatch: boolean;
  bootBefore: string | undefined;
  bootAfter: string | undefined;
  expectedBootId: string;
  signalResult: ProbeErrorKind;
  processSample?: ProcessSample;
  expectedStartToken: string;
}): ProcessObservation['state'] {
  const { hostMatch, bootBefore, bootAfter, expectedBootId, signalResult, processSample, expectedStartToken } = params;
  if (!hostMatch) return 'unknown';
  if (!bootBefore || !bootAfter || bootBefore !== bootAfter) return 'unknown';
  if (signalResult === 'eperm' || signalResult === 'unknown') return 'unknown';
  if (bootBefore !== expectedBootId) return 'not-running';
  if (signalResult === 'esrch') {
    if (processSample) return 'unknown';
    return 'not-running';
  }
  if (!processSample) return 'unknown';
  if (processSample.processState.startsWith('Z') || processSample.processState.startsWith('X')) return 'not-running';
  if (processSample.startedAt !== expectedStartToken) return 'not-running';
  return 'same-process';
}

export class LocalProcessProbe implements ProcessProbe {
  private readonly hostId: string;
  private readonly snap: ReadSnapshot;

  constructor(hostId: string, snapshot?: ReadSnapshot) {
    if (!isNonEmptyBoundedString(hostId)) throw new TypeError('hostId must be a non-empty bounded string');
    this.hostId = hostId;
    this.snap = snapshot ?? defaultSnapshot;
  }

  async capture(): Promise<ProcessIdentity | undefined> {
    try {
      const pid = this.snap.ownPid();
      if (!isPositiveSafeInt(pid) || this.snap.killSignal(pid, 0) !== 'ok') return undefined;
      const b1 = await readBoot(this.snap);
      if (!b1) return undefined;
      const proc = await readProcess(pid, this.snap);
      if (!proc || /^[ZX]/.test(proc.processState)) return undefined;
      const b2 = await readBoot(this.snap);
      if (!b2 || b1 !== b2) return undefined;
      return Object.freeze({ hostId: this.hostId, bootId: b1, pid, startedAt: proc.startedAt });
    } catch {
      return undefined;
    }
  }

  async observe(identity: ProcessIdentity): Promise<ProcessObservation> {
    if (!validProcessIdentity(identity)) return result('unknown', 'invalid identity');
    if (identity.hostId !== this.hostId) return result('unknown', 'foreign host');
    const plat = this.snap.platform();
    if (plat !== 'linux' && plat !== 'darwin') return result('unknown', 'unsupported platform');

    const bootBefore = await readBoot(this.snap);
    const sig = this.snap.killSignal(identity.pid, 0);
    const proc = await readProcess(identity.pid, this.snap);
    const bootAfter = await readBoot(this.snap);

    const state = classifyObservation({
      hostMatch: true,
      bootBefore,
      bootAfter,
      expectedBootId: identity.bootId,
      signalResult: sig,
      processSample: proc,
      expectedStartToken: identity.startedAt,
    });

    let reason = 'state determined';
    if (state === 'same-process') reason = 'identity confirmed';
    else if (state === 'not-running') {
      if (bootBefore !== identity.bootId) reason = 'boot changed';
      else if (sig === 'esrch') reason = 'process does not exist';
      else if (proc && proc.startedAt !== identity.startedAt) reason = 'PID reused';
      else reason = 'zombie or defunct process';
    } else {
      if (!bootBefore || !bootAfter || bootBefore !== bootAfter) reason = 'unstable or unreadable boot scope';
      else if (sig === 'eperm') reason = 'permission denied';
      else if (sig === 'esrch' && proc) reason = 'contradictory process state';
      else reason = 'probe inspection inconclusive';
    }
    return result(state, reason);
  }
}
