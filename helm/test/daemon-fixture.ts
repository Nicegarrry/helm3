import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const tracked = new Map<string, Set<number>>();

function trackTestDaemon(home: string, child: ChildProcess): ChildProcess {
  if (child.pid) {
    const pids = tracked.get(home) ?? new Set<number>();
    pids.add(child.pid);
    tracked.set(home, pids);
  }
  return child;
}

export function spawnTestDaemon(home: string, file: string, args: string[], options: SpawnOptions): ChildProcess {
  return trackTestDaemon(home, spawn(file, args, { ...options, detached: true }));
}

function metadataPid(path: string): number | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; helperPid?: number };
    const pid = value.pid ?? value.helperPid;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

type ProcessTarget = { pid: number; group?: number };
type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => boolean;
type MetadataSource = 'daemon' | 'detached-helper';

function processTarget(pid: number, source: MetadataSource): ProcessTarget | undefined {
  if (pid === process.pid) return undefined;
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (!/(?:serve\s+--http|restart\s+--handover|update\.mjs\s+apply(?:\s|$))/.test(command)) return undefined;
    const group = Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
    return { pid, group: group === pid ? group : undefined };
  } catch { return source === 'detached-helper' ? { pid, group: pid } : undefined; }
}

function alive(target: ProcessTarget, kill: KillProcess): boolean {
  try { kill(target.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function signal(target: ProcessTarget, value: NodeJS.Signals, kill: KillProcess): void {
  if (target.group) {
    try { kill(-target.group, value); return; } catch { /* fall back to the leader PID */ }
  }
  try { kill(target.pid, value); } catch { /* already exited */ }
}

/** Stops daemon and upgrade-helper process trees identified by this test's private home. */
export async function cleanupTestDaemons(home: string, kill: KillProcess = process.kill): Promise<void> {
  const known = new Set(tracked.get(home) ?? []);
  tracked.delete(home);
  const targets = new Map<number, ProcessTarget>();
  for (const pid of known) if (pid !== process.pid) targets.set(pid, { pid, group: pid });
  for (const file of ['serve.json', 'upgrade.json']) {
    if (!existsSync(join(home, file))) continue;
    const pid = metadataPid(join(home, file));
    if (!pid || targets.has(pid)) continue;
    const source: MetadataSource = file === 'upgrade.json' ? 'detached-helper' : 'daemon';
    const target = processTarget(pid, source);
    if (target) targets.set(pid, target);
  }
  const processes = [...targets.values()];
  for (const target of processes) signal(target, 'SIGTERM', kill);
  const deadline = Date.now() + 2_000;
  while (processes.some((target) => alive(target, kill)) && Date.now() < deadline) await delay(20);
  // Always signal the original groups: a leader may have exited while descendants remain.
  for (const target of processes) signal(target, 'SIGKILL', kill);
  const killDeadline = Date.now() + 2_000;
  while (processes.some((target) => alive(target, kill)) && Date.now() < killDeadline) await delay(20);
  assert.deepEqual(processes.filter((target) => alive(target, kill)).map(({ pid }) => pid), [], `test daemons survived cleanup for ${home}`);
}
