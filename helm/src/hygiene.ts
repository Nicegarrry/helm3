/** Conservative cleanup for worker, deploy, and low-disk state. */
import { execFile } from 'node:child_process';
import { readdir, rm, stat, statfs as fsStatfs } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Settings } from './settings.js';
import type { GitHub, Store, Workspace, WorkerRow } from './types.js';

export type StatfsResult = Readonly<{ bavail: number; bsize: number }>;
export type HygieneExec = (file: string, args: string[], options: { cwd?: string }) => Promise<{ stdout: string; stderr?: string; code?: number }>;
type HygieneFs = Readonly<{
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; isDirectory(): boolean }>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}>;
type Options = Readonly<{
  home: string;
  store: Store;
  settings: Pick<Settings, 'hygiene'>;
  workspace: Workspace;
  github: Pick<GitHub, 'prStatus'>;
  isRunning?: (workerId: string) => boolean;
  now?: () => Date;
  exec?: HygieneExec;
  fs?: HygieneFs;
  statfs?: (path: string) => Promise<StatfsResult>;
  withWorkerLock?: <T>(workerId: string, fn: () => Promise<T>) => Promise<T>;
  deployInProgress?: (project: string, target: string) => boolean;
}>;

const realExec = promisify(execFile);
const defaultExec: HygieneExec = async (file, args, options) => {
  try {
    const result = await realExec(file, args, { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { stdout: String(value.stdout ?? ''), stderr: String(value.stderr ?? value.message ?? ''), code: typeof value.code === 'number' ? value.code : 1 };
  }
};

const defaultFs: HygieneFs = { readdir, stat, rm };

/** Remove dependencies from the root and each first-level package in a worktree. */
export async function cleanupNodeModules(worktree: string, keepNodeModules = false): Promise<void> {
  if (keepNodeModules) return;
  const packageRoots = [worktree, join(worktree, 'helm')];
  try {
    for (const entry of await readdir(worktree, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await stat(join(worktree, entry.name, 'package.json'));
        packageRoots.push(join(worktree, entry.name));
      } catch { /* not a top-level package */ }
    }
  } catch { /* a removed worktree is already clean */ }
  await Promise.all([...new Set(packageRoots)].map((root) => rm(join(root, 'node_modules'), { recursive: true, force: true }).catch(() => {})));
}

export async function freeSpaceGb(path: string, statfs: (path: string) => Promise<StatfsResult> = fsStatfs): Promise<number | null> {
  try {
    const value = await statfs(path);
    return (value.bavail * value.bsize) / (1024 ** 3);
  } catch {
    return null;
  }
}

function inside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child.length > 0 && !child.startsWith('..') && !child.startsWith('/');
}

function settled(worker: WorkerRow): boolean {
  return worker.state === 'succeeded' || worker.state === 'failed' || worker.state === 'stopped' || worker.state === 'idle';
}

export type HygieneService = Readonly<{ tick(): Promise<void>; gc(): Promise<void> }>;

export function createHygiene(options: Options): HygieneService {
  const now = options.now ?? (() => new Date());
  const exec = options.exec ?? defaultExec;
  const fs = options.fs ?? defaultFs;
  const worktreeRoot = join(options.home, 'worktrees');
  const deployRoot = join(options.home, 'deploys');
  const workerLocks = new Map<string, Promise<void>>();

  async function withWorkerLock<T>(workerId: string, fn: () => Promise<T>): Promise<T> {
    if (options.withWorkerLock) return options.withWorkerLock(workerId, fn);
    const previous = workerLocks.get(workerId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    workerLocks.set(workerId, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (workerLocks.get(workerId) === current) workerLocks.delete(workerId);
    }
  }

  async function git(repo: string, args: string[]): Promise<string> {
    const result = await exec('git', args, { cwd: repo });
    if ((result.code ?? 0) !== 0) throw new Error(result.stderr || `git ${args[0] ?? 'command'} failed`);
    return result.stdout;
  }

  async function trackedClean(worker: WorkerRow): Promise<boolean> {
    try {
      if (options.workspace.isTrackedClean) return await options.workspace.isTrackedClean(worker.worktree);
      return (await git(worker.worktree, ['status', '--porcelain'])).trim() === '';
    } catch {
      return false;
    }
  }

  async function contained(worker: WorkerRow): Promise<boolean> {
    const head = worker.head ?? await options.workspace.head(worker.worktree).catch(() => '');
    if (!head) return false;
    try {
      if (options.workspace.contains) return await options.workspace.contains(worker.repo, head, worker.branch);
      const own = `origin/${worker.branch}`;
      return (await git(worker.repo, ['branch', '-r', '--contains', head])).split(/\r?\n/).map((line) => line.replace(/^\s*\*?\s*/, '').trim()).filter(Boolean).some((ref) => ref !== own && ref !== `refs/remotes/${own}`);
    } catch {
      return false;
    }
  }

  async function reachableFromOrigin(worker: WorkerRow): Promise<boolean> {
    const head = worker.head ?? await options.workspace.head(worker.worktree).catch(() => '');
    if (!head) return false;
    try {
      if (options.workspace.reachableFromOrigin) return await options.workspace.reachableFromOrigin(worker.repo, head);
      return (await git(worker.repo, ['branch', '-r', '--contains', head])).split(/\r?\n/)
        .map((line) => line.replace(/^\s*\*?\s*/, '').trim())
        .some((ref) => ref.startsWith('origin/') || ref.startsWith('refs/remotes/origin/'));
    } catch {
      return false;
    }
  }

  async function dispositionAllows(worker: WorkerRow): Promise<boolean> {
    const pr = options.store.getPrByWorker(worker.workerId);
    if (pr) {
      try {
        const status = await options.github.prStatus(worker.repoSlug, pr.number);
        return status.state === 'merged' || status.state === 'closed';
      } catch {
        return false;
      }
    }
    if (await contained(worker)) return true;
    const settledAt = Date.parse(worker.updatedAt);
    return Number.isFinite(settledAt) && now().getTime() - settledAt > options.settings.hygiene.worktreeTtlHours * 60 * 60_000;
  }

  function removed(workerId: string): boolean {
    return options.store.listEvents(workerId, { limit: 1_000_000 }).some((event) => event.kind === 'worktree.removed');
  }

  async function removeWorkerWorktree(worker: WorkerRow): Promise<void> {
    await options.workspace.remove(worker.repo, worker.worktree);
    if (options.workspace.prune) await options.workspace.prune(worker.repo);
    else await git(worker.repo, ['worktree', 'prune']);
    if (options.workspace.deleteBranch) await options.workspace.deleteBranch(worker.repo, worker.branch);
    else await git(worker.repo, ['branch', '-D', worker.branch]);
    options.store.appendEvent(worker.workerId, 'worktree.removed', { worktree: worker.worktree, branch: worker.branch });
  }

  function sameWorker(before: WorkerRow, after: WorkerRow): boolean {
    return before.state === after.state && before.updatedAt === after.updatedAt && before.worktree === after.worktree && before.branch === after.branch && before.head === after.head;
  }

  function keptForState(workerId: string, state: string): boolean {
    return options.store.listEvents(workerId, { limit: 1_000_000 })
      .some((event) => event.kind === 'worktree.kept' && event.data.state === state);
  }

  async function gcWorker(candidate: WorkerRow): Promise<void> {
    if (!inside(worktreeRoot, candidate.worktree)) return;
    await withWorkerLock(candidate.workerId, async () => {
      const worker = options.store.getWorker(candidate.workerId);
      if (!worker || removed(worker.workerId) || !settled(worker) || options.isRunning?.(worker.workerId)) return;
      if (!inside(worktreeRoot, worker.worktree) || !await trackedClean(worker) || !await dispositionAllows(worker)) return;
      const pushed = await reachableFromOrigin(worker);
      const latest = options.store.getWorker(worker.workerId);
      if (!latest || !sameWorker(worker, latest) || !settled(latest) || options.isRunning?.(latest.workerId)) return;
      if (!pushed) {
        if (!keptForState(worker.workerId, worker.state)) {
          options.store.appendEvent(worker.workerId, 'worktree.kept', { reason: 'unpushed commits', state: worker.state, worktree: worker.worktree, branch: worker.branch });
        }
        return;
      }
      try { await removeWorkerWorktree(latest); } catch { /* leave the row for a later conservative retry */ }
    });
  }

  async function gc(): Promise<void> {
    for (const worker of options.store.listWorkers()) await gcWorker(worker);
    await gcDeploys();
  }

  async function gcDeploys(): Promise<void> {
    const cutoff = now().getTime() - 60 * 60_000;
    const orphanCutoff = now().getTime() - 24 * 60 * 60_000;
    let projects: string[];
    try { projects = await fs.readdir(deployRoot); } catch { return; }
    for (const project of projects) {
      const projectPath = join(deployRoot, project);
      let projectStat;
      try { projectStat = await fs.stat(projectPath); } catch { continue; }
      if (!projectStat.isDirectory()) continue;
      let deploys: string[];
      try { deploys = await fs.readdir(projectPath); } catch { continue; }
      for (const deploy of deploys) {
        const deployPath = join(projectPath, deploy);
        try {
          const deployStat = await fs.stat(deployPath);
          if (!deployStat.isDirectory()) continue;
          let row: { project: string; target: string; state: string; at: string } | undefined;
          try {
            row = options.store.sql.prepare('SELECT project, target, state, at FROM deploys WHERE id = ?').get(deploy) as typeof row;
          } catch {
            // A store without the optional deploy table has no durable deploy rows.
          }
          if (row) {
            const state = row.state.toLowerCase().replaceAll(' ', '_');
            if (state === 'deploying' || state === 'running' || state === 'in_progress' || options.deployInProgress?.(row.project, row.target)) continue;
            const at = Date.parse(row.at);
            if ((Number.isFinite(at) ? at : deployStat.mtimeMs) < cutoff) await fs.rm(deployPath, { recursive: true, force: true });
          } else if (deployStat.mtimeMs < orphanCutoff) {
            await fs.rm(deployPath, { recursive: true, force: true });
          }
        } catch { /* best effort cleanup; the next tick can retry */ }
      }
      try {
        const remaining = await fs.readdir(projectPath);
        if (!remaining.length && projectStat.mtimeMs < orphanCutoff) await fs.rm(projectPath, { recursive: true, force: true });
      } catch { /* best effort cleanup */ }
    }
  }

  function diskProjects(): string[] {
    const projects = new Set(options.store.listWorkers().map((worker) => worker.repoSlug));
    try {
      const rows = options.store.sql.prepare('SELECT project FROM supervisors').all() as Array<{ project?: unknown }>;
      for (const row of rows) if (typeof row.project === 'string' && row.project) projects.add(row.project);
    } catch { /* supervisors table is created by the optional supervisor service */ }
    return [...projects];
  }

  async function alertDiskLow(freeGb: number): Promise<void> {
    const at = now();
    for (const project of diskProjects()) {
      const workerId = `project:${project}`;
      const previous = options.store.listEvents(workerId, { limit: 1_000_000 }).reverse().find((event) => event.kind === 'watch.alert' && event.data.rule === 'disk.low');
      if (previous && at.getTime() - Date.parse(previous.at) < 60 * 60_000) continue;
      options.store.appendEvent(workerId, 'watch.alert', {
        rule: 'disk.low',
        detail: { freeGb, minFreeGb: options.settings.hygiene.minFreeGb },
        project,
      }, at.toISOString());
    }
  }

  return {
    async tick(): Promise<void> {
      const freeGb = await freeSpaceGb(options.home, options.statfs);
      await gc();
      if (freeGb !== null && freeGb < options.settings.hygiene.minFreeGb) await alertDiskLow(freeGb);
    },
    gc,
  };
}
