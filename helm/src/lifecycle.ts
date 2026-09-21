import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ToolOutcome } from './types.js';

export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const manifest = new URL('../release.json', import.meta.url);
export const REVISION: string = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).revision : 'development';
export const READ_TOOLS = new Set(['worker.inspect', 'worker.list', 'worker.wait', 'pr.status', 'run.status', 'daemon.control']);
export function readMetadata(path: string): Record<string, unknown> | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
export function atomicMetadata(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}

// Never reclaim an ambiguous lock automatically, including a dead owner's lock.
export function ownDaemon(home: string): () => void {
  const path = join(home, 'daemon.lock');
  mkdirSync(path); // atomic across competing processes; acquired before opening SQLite
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return () => rmSync(path, { recursive: true });
}

export class Lifecycle {
  readonly bootId = randomUUID();
  private readonly active = new Map<symbol, string>();
  private draining: boolean;
  private stopping = false;
  private readonly marker: string;
  shutdown?: () => void;
  upgrade?: (timeoutMs: number) => void;
  constructor(readonly home: string, private readonly workers: () => string[]) {
    this.marker = join(home, 'drain.json');
    this.draining = existsSync(this.marker);
  }
  status() {
    const blockers = [...this.workers().map((id) => `worker:${id}`), ...this.active.values()];
    return { protocol: 1, bootId: this.bootId, pid: process.pid, version: VERSION, revision: REVISION,
      phase: this.stopping ? 'stopping' : !this.draining ? 'accepting' : blockers.length ? 'draining' : 'ready',
      blockers, staged: readMetadata(join(this.home, 'staged-release.json')), update: readMetadata(join(this.home, 'upgrade.json')) };
  }
  admit(name: string): () => void {
    if (this.stopping || (this.draining && name !== 'worker.stop')) throw new Error('daemon is draining; retry after maintenance (no work was admitted)');
    const token = Symbol(name);
    this.active.set(token, name);
    return () => { this.active.delete(token); };
  }
  drain(): void {
    atomicMetadata(this.marker, { requestedAt: new Date().toISOString() });
    this.draining = true;
  }
  async control(input: { action: string; timeoutMs?: number; upgradeId?: string; expectedBootId?: string }): Promise<ToolOutcome<ReturnType<Lifecycle['status']>>> {
    try {
      if (input.expectedBootId && input.expectedBootId !== this.bootId) throw new Error('daemon identity changed; request refused');
      if (input.action === 'drain') this.drain();
      if (input.action === 'resume') {
        if (this.stopping || (existsSync(join(this.home, 'upgrade.lock')) && (!input.upgradeId || readMetadata(join(this.home, 'upgrade.lock', 'owner.json'))?.id !== input.upgradeId))) throw new Error('upgrade/shutdown in progress; cannot resume');
        rmSync(this.marker, { force: true });
        this.draining = false;
      }
      if (input.action === 'shutdown' && !this.stopping) {
        this.drain();
        if (this.status().blockers.length) throw new Error(`still draining: ${this.status().blockers.join(', ')}`);
        if (!this.shutdown) throw new Error('shutdown handler unavailable');
        this.stopping = true;
        setImmediate(this.shutdown);
      }
      if (input.action === 'upgrade') {
        if (!this.upgrade || this.stopping) throw new Error('upgrade handler unavailable');
        this.upgrade(input.timeoutMs ?? 600_000);
        this.drain();
      }
      return { ok: true, ...this.status() };
    } catch (err) { return { ok: false, reason: err instanceof Error ? err.message : String(err) }; }
  }
}
