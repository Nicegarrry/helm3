import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const exec = promisify(execFile);

export type WorktreeOwner = Readonly<{ attemptId: string; generation: number; expiresAt: string }>;
export type WorktreeReservation = Readonly<{ repository: string; root: string; owner: WorktreeOwner; writableRoots: readonly string[] }>;

export class WorkspaceRefusal extends Error {}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/** Canonicalize each extant ancestor so a symlink cannot redirect a later write. */
async function canonicalPath(root: string, requested: string): Promise<string> {
  if (requested.includes('\0')) throw new WorkspaceRefusal('NUL is not a path');
  const absolute = resolve(root, requested);
  if (!inside(root, absolute)) throw new WorkspaceRefusal('path escapes assigned worktree');
  let cursor = absolute;
  const missing: string[] = [];
  while (true) {
    try {
      const details = await lstat(cursor);
      if (details.isSymbolicLink()) throw new WorkspaceRefusal('symlink path component is refused');
      const canonical = await realpath(cursor);
      const canonicalRoot = await realpath(root);
      if (!inside(canonicalRoot, canonical)) throw new WorkspaceRefusal('canonical path escapes assigned worktree');
      return resolve(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(cursor.split(sep).at(-1)!);
      const parent = dirname(cursor);
      if (parent === cursor) throw new WorkspaceRefusal('cannot resolve path');
      cursor = parent;
    }
  }
}

export class WorkspaceManager {
  private readonly reservations = new Map<string, WorktreeReservation>();

  async create(repository: string, destination: string, branch: string, baseSha: string, owner: WorktreeOwner): Promise<WorktreeReservation> {
    const repo = await realpath(repository);
    const root = resolve(destination);
    if (this.reservations.has(root)) throw new WorkspaceRefusal('worktree already has an owner');
    await mkdir(dirname(root), { recursive: true });
    if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new WorkspaceRefusal('base must be an exact commit SHA');
    const { stdout } = await exec('git', ['-C', repo, 'rev-parse', `${baseSha}^{commit}`]);
    if (stdout.trim() !== baseSha) throw new WorkspaceRefusal('base SHA did not resolve exactly');
    await exec('git', ['-C', repo, 'worktree', 'add', '-b', branch, root, baseSha]);
    const canonicalRoot = await realpath(root);
    const reservation = Object.freeze({ repository: repo, root: canonicalRoot, owner: Object.freeze({ ...owner }), writableRoots: Object.freeze(['.']) });
    this.reservations.set(canonicalRoot, reservation);
    return reservation;
  }

  assertOwner(reservation: WorktreeReservation, owner: WorktreeOwner): void {
    const current = this.reservations.get(reservation.root);
    if (!current || current.owner.attemptId !== owner.attemptId || current.owner.generation !== owner.generation) {
      throw new WorkspaceRefusal('worker does not own this worktree generation');
    }
    if (Date.parse(owner.expiresAt) <= Date.now()) throw new WorkspaceRefusal('worktree ownership expired');
  }

  async read(reservation: WorktreeReservation, path: string): Promise<string> {
    const target = await this.safePath(reservation, path, false);
    return (await import('node:fs/promises')).readFile(target, 'utf8');
  }

  async write(reservation: WorktreeReservation, owner: WorktreeOwner, path: string, contents: string): Promise<void> {
    this.assertOwner(reservation, owner);
    const target = await this.safePath(reservation, path, true);
    const existing = await stat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (existing && existing.nlink > 1) throw new WorkspaceRefusal('hard-linked target is refused');
    await mkdir(dirname(target), { recursive: true });
    // Publish a complete replacement, rather than making existing tracked files unwritable.
    // Re-check ownership after every await before the externally visible rename.
    const temporary = `${target}.helm-${owner.attemptId}-${owner.generation}.tmp`;
    try {
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      this.assertOwner(reservation, owner);
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  async changedFiles(reservation: WorktreeReservation): Promise<string[]> {
    const { stdout } = await exec('git', ['-C', reservation.root, 'status', '--porcelain=v1', '-z']);
    return stdout.split('\0').filter(Boolean).map((entry) => entry.slice(3)).sort();
  }

  private async safePath(reservation: WorktreeReservation, path: string, writing: boolean): Promise<string> {
    const lexical = relative(reservation.root, resolve(reservation.root, path)).split(sep).join('/');
    if (lexical === '.git' || lexical.startsWith('.git/')) throw new WorkspaceRefusal('Git metadata is protected');
    if (lexical === '.github' || lexical.startsWith('.github/') || lexical === 'src/core' || lexical.startsWith('src/core/') || lexical === 'docs/protocol.md' || lexical.startsWith('docs/protocol/')) throw new WorkspaceRefusal('control path is protected');
    const target = await canonicalPath(reservation.root, path);
    if (!inside(reservation.root, target)) throw new WorkspaceRefusal('path is outside assigned worktree');
    const relativeTarget = relative(reservation.root, target).split(sep).join('/');
    if (relativeTarget === '.git' || relativeTarget.startsWith('.git/')) throw new WorkspaceRefusal('Git metadata is protected');
    if (relativeTarget === '.github' || relativeTarget.startsWith('.github/') || relativeTarget === 'src/core' || relativeTarget.startsWith('src/core/') || relativeTarget === 'docs/protocol.md' || relativeTarget.startsWith('docs/protocol/')) throw new WorkspaceRefusal('control path is protected');
    if (!writing) return target;
    return target;
  }
}
