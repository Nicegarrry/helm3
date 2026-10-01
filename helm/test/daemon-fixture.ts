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
    return value.pid ?? value.helperPid;
  } catch { return undefined; }
}

function processTarget(pid: number): number | undefined {
  if (pid === process.pid) return undefined;
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (!/(?:serve\s+--http|restart\s+--handover|update\.mjs\s+apply(?:\s|$))/.test(command)) return undefined;
    const group = Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim());
    return group === pid ? -pid : pid;
  } catch { return undefined; }
}

function alive(target: number): boolean {
  try { process.kill(target, 0); return true; } catch { return false; }
}

/** Stops only daemons identified by this test's private home, then proves they are gone. */
export async function cleanupTestDaemons(home: string): Promise<void> {
  const known = new Set(tracked.get(home) ?? []);
  tracked.delete(home);
  const metadata = new Set<number>();
  for (const file of ['serve.json', 'upgrade.json']) {
    if (!existsSync(join(home, file))) continue;
    const pid = metadataPid(join(home, file));
    if (pid && !known.has(pid)) metadata.add(pid);
  }
  const targets = [...new Set([
    ...[...known].filter((pid) => pid !== process.pid).map((pid) => -pid),
    ...[...metadata].map(processTarget).filter((target): target is number => target !== undefined),
  ])];
  for (const target of targets) { try { process.kill(target, 'SIGTERM'); } catch { /* already exited */ } }
  const deadline = Date.now() + 2_000;
  while (targets.some(alive) && Date.now() < deadline) await delay(20);
  for (const target of targets.filter(alive)) { try { process.kill(target, 'SIGKILL'); } catch { /* already exited */ } }
  const killDeadline = Date.now() + 2_000;
  while (targets.some(alive) && Date.now() < killDeadline) await delay(20);
  assert.deepEqual(targets.filter(alive), [], `test daemons survived cleanup for ${home}`);
}
