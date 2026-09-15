import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const exec = promisify(execFile);
type DB = { exec(sql: string): void; prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown }; close(): void };
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: new (path: string) => DB };
export type WorktreeOwner = Readonly<{ attemptId: string; generation: number; expiresAt: string }>;
export type WorktreeReservation = Readonly<{ repository: string; root: string; owner: WorktreeOwner; writableRoots: readonly string[]; readableRoots: readonly string[]; protectedRoots: readonly string[] }>;
export class WorkspaceRefusal extends Error {}
type OwnershipRow = { bytes: string; status: string };

/**
 * Records written before bounded read scopes did not contain readableRoots.
 * Decode that accepted shape as its original writable scope without changing
 * the durable bytes; an explicit empty read scope remains an explicit denial.
 */
function reservationFromBytes(bytes: string): WorktreeReservation {
  const stored = JSON.parse(bytes) as Omit<WorktreeReservation, 'readableRoots'> & Partial<Pick<WorktreeReservation, 'readableRoots'>>;
  const readableRoots = Object.hasOwn(stored, 'readableRoots') ? stored.readableRoots : stored.writableRoots;
  return Object.freeze({ ...stored, owner: Object.freeze({ ...stored.owner }), writableRoots: Object.freeze([...stored.writableRoots]), readableRoots: Object.freeze([...(readableRoots ?? [])]), protectedRoots: Object.freeze([...stored.protectedRoots]) });
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/** One trusted host store, outside writable worktrees, shared across managers. */
export class WorkspaceManager {
  private readonly db: DB;
  private readonly stateRoot: string;
  private readonly now: () => number;
  constructor(options: { stateRoot: string; now?: () => number }) {
    mkdirSync(options.stateRoot, { recursive: true, mode: 0o700 });
    this.stateRoot = realpathSync(options.stateRoot);
    this.now = options.now ?? Date.now;
    const path = join(this.stateRoot, 'ownership.sqlite');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspace_ownership(root TEXT PRIMARY KEY, bytes TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_writes(root TEXT NOT NULL, path TEXT NOT NULL, baseline_hash TEXT NOT NULL, PRIMARY KEY(root,path));`);
  }
  close(): void { this.db.close(); }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private validOwner(owner: WorktreeOwner): void {
    if (!owner.attemptId || !Number.isSafeInteger(owner.generation) || owner.generation < 1
      || !Number.isFinite(Date.parse(owner.expiresAt)) || Date.parse(owner.expiresAt) <= this.now()) {
      throw new WorkspaceRefusal('invalid or expired ownership');
    }
  }
  async create(repository: string, destination: string, branch: string, baseSha: string, owner: WorktreeOwner, policy: { writableRoots: readonly string[]; readableRoots?: readonly string[]; protectedRoots?: readonly string[] } = { writableRoots: ['.'] }): Promise<WorktreeReservation> {
    this.validOwner(owner);
    const repo = await realpath(repository);
    await mkdir(dirname(resolve(destination)), { recursive: true });
    const root = join(await realpath(dirname(resolve(destination))), resolve(destination).split(sep).at(-1)!);
    if (inside(root, this.stateRoot)) throw new WorkspaceRefusal('ownership store must be outside the worktree');
    if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new WorkspaceRefusal('base must be an exact commit SHA');
    const { stdout } = await exec('git', ['-C', repo, 'rev-parse', `${baseSha}^{commit}`]);
    if (stdout.trim() !== baseSha) throw new WorkspaceRefusal('base SHA did not resolve exactly');
    await exec('git', ['check-ref-format', '--branch', branch]);
    if (branch.startsWith('-')) throw new WorkspaceRefusal('invalid branch');
    const normalizePolicyPath = (path: string) => {
      if (isAbsolute(path) || path.includes('\0') || !inside(root, resolve(root, path))) throw new WorkspaceRefusal('invalid policy path');
      return relative(root, resolve(root, path)).split(sep).join('/') || '.';
    };
    const writableRoots = policy.writableRoots.map(normalizePolicyPath);
    const readableRoots = (policy.readableRoots ?? policy.writableRoots).map(normalizePolicyPath);
    const protectedRoots = ['.git', '.github', '.pi', 'src/core', 'src/runtime', 'test', 'scripts', 'docs/protocol.md', 'docs/brief.md', 'docs/design-original.md', 'docs/design-addendum.md', 'docs/design-source.md', 'AGENTS.md', ...(policy.protectedRoots ?? []).map(normalizePolicyPath)];
    const reservation = Object.freeze({ repository: repo, root, owner: Object.freeze({ ...owner }), writableRoots: Object.freeze(writableRoots), readableRoots: Object.freeze(readableRoots), protectedRoots: Object.freeze(protectedRoots) });
    this.transaction(() => {
      this.validOwner(owner);
      if (this.db.prepare('SELECT root FROM workspace_ownership WHERE root=?').get(root)) throw new WorkspaceRefusal('worktree already has a durable owner');
      this.db.prepare('INSERT INTO workspace_ownership VALUES(?,?,?)').run(root, JSON.stringify(reservation), 'creating');
    });
    try {
      await exec('git', ['-C', repo, 'worktree', 'add', '-b', branch, root, baseSha]);
      this.db.prepare('UPDATE workspace_ownership SET status=? WHERE root=?').run('active', root);
      this.assertOwner(reservation, owner);
      return reservation;
    } catch (error) {
      this.db.prepare('UPDATE workspace_ownership SET status=? WHERE root=?').run('failed', root);
      throw error; // Preserve both the record and any created worktree for inspection.
    }
  }
  assertOwner(reservation: WorktreeReservation, owner: WorktreeOwner): void {
    const row = this.db.prepare('SELECT bytes,status FROM workspace_ownership WHERE root=?').get(reservation.root) as OwnershipRow | undefined;
    if (!row || row.status !== 'active') throw new WorkspaceRefusal('no active durable worktree ownership');
    const current = reservationFromBytes(row.bytes);
    if (current.repository !== reservation.repository || current.owner.attemptId !== owner.attemptId
      || current.owner.generation !== owner.generation || current.owner.expiresAt !== owner.expiresAt
      || JSON.stringify(current.writableRoots) !== JSON.stringify(reservation.writableRoots)
      || JSON.stringify(current.readableRoots) !== JSON.stringify(reservation.readableRoots)
      || JSON.stringify(current.protectedRoots) !== JSON.stringify(reservation.protectedRoots)) {
      throw new WorkspaceRefusal('worker does not own this worktree generation');
    }
    this.validOwner(current.owner);
  }
  /** Host-only recovery lookup; it does not grant ownership. */
  reservation(root: string): WorktreeReservation {
    const row = this.db.prepare('SELECT bytes,status FROM workspace_ownership WHERE root=?').get(root) as OwnershipRow | undefined;
    if (!row || row.status !== 'active') throw new WorkspaceRefusal('no active durable worktree ownership');
    return reservationFromBytes(row.bytes);
  }
  /** Re-read exact Git reality immediately before a continuation changes ownership. */
  async assertExactHead(reservation: WorktreeReservation, expectedHead: string): Promise<void> {
    this.assertOwner(reservation, reservation.owner);
    if (!/^[0-9a-f]{40}$/.test(expectedHead)) throw new WorkspaceRefusal('expected worktree head must be an exact commit SHA');
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      exec('git', ['-C', reservation.root, 'rev-parse', 'HEAD']),
      exec('git', ['-C', reservation.root, 'status', '--porcelain', '--untracked-files=all']),
    ]);
    if (head.trim() !== expectedHead || status !== '') throw new WorkspaceRefusal('worktree does not match the expected clean head');
  }
  /** Trusted host observation for a completed worker handoff; it grants no ownership or write capability. */
  async inspectGit(reservation: WorktreeReservation): Promise<Readonly<{ head: string; clean: boolean }>> {
    this.assertOwner(reservation, reservation.owner);
    return this.inspectGitReadonly(reservation);
  }
  /**
   * Host observation only. Unlike `inspectGit`, this deliberately does not
   * renew or require a live lease: a terminal evidence reader must still be
   * able to inspect an owned checkout after its worker lease expires or is
   * transferred. The reservation is reloaded from durable ownership first,
   * so a caller cannot substitute a path or repository.
   */
  async inspectGitReadonly(reservation: WorktreeReservation): Promise<Readonly<{ head: string; clean: boolean; status: string; owner: WorktreeOwner }>> {
    const current = this.reservation(reservation.root);
    if (current.repository !== reservation.repository || current.root !== reservation.root) throw new WorkspaceRefusal('workspace identity changed before readonly observation');
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      exec('git', ['-C', current.root, 'rev-parse', 'HEAD']),
      exec('git', ['-C', current.root, 'status', '--porcelain', '--untracked-files=all']),
    ]);
    return Object.freeze({ head: head.trim(), clean: status === '', status, owner: Object.freeze({ ...current.owner }) });
  }
  /** Trusted host takeover; the old generation is fenced across all managers. */
  transfer(reservation: WorktreeReservation, expectedGeneration: number, owner: WorktreeOwner): WorktreeReservation {
    return this.transaction(() => {
      this.validOwner(owner);
      const row = this.db.prepare('SELECT bytes,status FROM workspace_ownership WHERE root=?').get(reservation.root) as OwnershipRow | undefined;
      if (!row || row.status !== 'active') throw new WorkspaceRefusal('worktree is not available for transfer');
      const current = reservationFromBytes(row.bytes);
      if (current.owner.attemptId !== reservation.owner.attemptId || current.owner.generation !== reservation.owner.generation || current.owner.expiresAt !== reservation.owner.expiresAt
        || current.owner.generation !== expectedGeneration || owner.generation !== expectedGeneration + 1) throw new WorkspaceRefusal('stale worktree ownership generation');
      const next = Object.freeze({ ...current, owner: Object.freeze({ ...owner }) });
      this.db.prepare('UPDATE workspace_ownership SET bytes=? WHERE root=?').run(JSON.stringify(next), current.root);
      return next;
    });
  }
  private relativePath(reservation: WorktreeReservation, requested: string, operation: 'read' | 'write'): string {
    if (requested.includes('\0')) throw new WorkspaceRefusal('NUL is not a path');
    const target = resolve(reservation.root, requested);
    if (!inside(reservation.root, target)) throw new WorkspaceRefusal('path escapes assigned worktree');
    const path = relative(reservation.root, target).split(sep).join('/');
    const roots = operation === 'read' ? reservation.readableRoots : reservation.writableRoots;
    if (!roots.some((entry) => entry === '.' || path === entry || path.startsWith(`${entry}/`))) throw new WorkspaceRefusal(`path is outside assigned ${operation} scope`);
    // Control paths remain unavailable to writers.  They must still be
    // reviewable when the trusted host deliberately grants a readonly whole
    // repository scope: review-readonly Pi has no mutation tool, and hiding
    // the code under review would make that scope useless.  This does not
    // claim an OS sandbox; it is the narrow tool policy enforced here.
    if (!path || (operation === 'write' && reservation.protectedRoots.some((entry) => path === entry || path.startsWith(`${entry}/`)))) throw new WorkspaceRefusal('control path is protected');
    return path;
  }
  private async safePath(reservation: WorktreeReservation, requested: string, operation: 'read' | 'write' = 'write'): Promise<string> {
    const path = this.relativePath(reservation, requested, operation);
    if (await realpath(reservation.root) !== reservation.root) throw new WorkspaceRefusal('worktree root changed');
    let cursor = reservation.root;
    for (const part of path.split('/')) {
      cursor = join(cursor, part);
      const entry = await lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (entry?.isSymbolicLink()) throw new WorkspaceRefusal('symlink path component is refused');
      if (entry?.isFile() && entry.nlink > 1) throw new WorkspaceRefusal('hard-linked target is refused');
    }
    return cursor;
  }
  async read(reservation: WorktreeReservation, path: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
    this.assertOwner(reservation, reservation.owner);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new WorkspaceRefusal('invalid read size bound');
    const target = await this.safePath(reservation, path, 'read');
    if ((await stat(target)).size > maxBytes) throw new WorkspaceRefusal('read exceeds size bound');
    return readFile(target, 'utf8');
  }
  async write(reservation: WorktreeReservation, owner: WorktreeOwner, path: string, contents: string): Promise<void> {
    this.assertOwner(reservation, owner);
    const target = await this.safePath(reservation, path);
    await mkdir(dirname(target), { recursive: true });
    await this.safePath(reservation, path);
    const staged = join(dirname(target), `.helm-write-${randomUUID()}`);
    try {
      await writeFile(staged, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await this.safePath(reservation, path);
      const normalized = this.relativePath(reservation, path, 'write');
      this.transaction(() => {
        this.assertOwner(reservation, owner);
        let baseline = 'absent';
        try { baseline = createHash('sha256').update(readFileSync(target)).digest('hex'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.db.prepare('INSERT OR IGNORE INTO workspace_writes VALUES(?,?,?)').run(reservation.root, normalized, baseline);
      });
      // The attempted path survives a crash; synchronous owner check encloses the final local effect.
      this.transaction(() => {
        this.assertOwner(reservation, owner);
        // Same-host trusted tools are the only writers; no shell is exposed.
        renameSync(staged, target);
      });
    } finally { await rm(staged, { force: true }); }
  }
  async changedFiles(reservation: WorktreeReservation): Promise<string[]> {
    const { stdout } = await exec('git', ['-C', reservation.root, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const records = stdout.split('\0').filter(Boolean);
    const paths = new Set<string>();
    for (let index = 0; index < records.length; index++) {
      const entry = records[index]; paths.add(entry.slice(3));
      if (/[RC]/.test(entry.slice(0, 2)) && records[index + 1]) paths.add(records[++index]);
    }
    for (const row of this.db.prepare('SELECT path,baseline_hash FROM workspace_writes WHERE root=?').all(reservation.root) as { path: string; baseline_hash: string }[]) {
      const target = await this.safePath(reservation, row.path);
      let current = 'absent';
      try { current = createHash('sha256').update(await readFile(target)).digest('hex'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (current !== row.baseline_hash) paths.add(row.path);
    }
    for (const path of paths) this.relativePath(reservation, path, 'write'); // Detective scope check includes ignored tool writes.
    return [...paths].sort();
  }
}
