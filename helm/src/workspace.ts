/** Git worktree add/remove, commit, push, diff stat. See DESIGN.md. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Workspace, WorktreeInfo } from './types.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await git(repo, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

export function gitWorkspace(): Workspace {
  return {
    async resolveSha(repo: string, ref: string): Promise<string> {
      const out = await git(repo, ['rev-parse', ref]);
      return out.trim();
    },

    async defaultBranch(repo: string): Promise<string> {
      try {
        const out = await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
        const branch = out.trim().replace(/^refs\/remotes\/origin\//, '');
        if (branch) return branch;
      } catch {
        // fall through
      }
      if (await refExists(repo, 'refs/heads/main')) return 'main';
      if (await refExists(repo, 'refs/heads/master')) return 'master';
      const current = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
      return current.trim();
    },

    async create(repo: string, root: string, branch: string, baseSha: string): Promise<WorktreeInfo> {
      const resolved = await git(repo, ['rev-parse', `${baseSha}^{commit}`]);
      if (resolved.trim() !== baseSha) throw new Error(`base SHA did not resolve exactly: ${baseSha}`);
      await git(repo, ['worktree', 'add', '-b', branch, root, baseSha]);
      return { path: root, branch, baseSha };
    },

    async remove(repo: string, path: string): Promise<void> {
      await git(repo, ['worktree', 'remove', '--force', path]);
    },

    async head(path: string): Promise<string> {
      const out = await git(path, ['rev-parse', 'HEAD']);
      return out.trim();
    },

    async isClean(path: string): Promise<boolean> {
      const out = await git(path, ['status', '--porcelain', '--untracked-files=all']);
      return out.trim() === '';
    },

    async diffStat(path: string, baseSha: string): Promise<string> {
      return git(path, ['diff', '--stat', baseSha]);
    },

    async commitAll(path: string, message: string): Promise<string> {
      await git(path, ['add', '-A']);
      const staged = await git(path, ['diff', '--cached', '--name-only']);
      if (staged.trim() === '') return (await git(path, ['rev-parse', 'HEAD'])).trim();
      const identityArgs: string[] = [];
      try { await git(path, ['config', 'user.name']); } catch { identityArgs.push('-c', 'user.name=helm'); }
      try { await git(path, ['config', 'user.email']); } catch { identityArgs.push('-c', 'user.email=helm@local'); }
      await git(path, [...identityArgs, 'commit', '-m', message]);
      return (await git(path, ['rev-parse', 'HEAD'])).trim();
    },

    async push(path: string, branch: string): Promise<void> {
      await git(path, ['push', '-u', 'origin', branch]);
    },
  };
}
