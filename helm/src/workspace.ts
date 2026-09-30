/** Git worktree add/remove, commit, push, diff stat. See DESIGN.md. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { assertWorktreeGitDir, expectedWorktreeGitDir, hardenedGitArgs } from './git.js';
import type { Workspace, WorktreeInfo } from './types.js';

const realExec = promisify(execFile);

export type WorkspaceExec = (file: string, args: string[], options: { cwd?: string; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>;

export function gitWorkspace(options: Readonly<{ exec?: WorkspaceExec }> = {}): Workspace {
  const execute: WorkspaceExec = options.exec ?? (async (file, args, execOptions) => {
    const result = await realExec(file, args, execOptions);
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  });
  const expectedGitDirs = new Map<string, string>();
  const git = async (cwd: string, args: string[]): Promise<string> => {
    const { stdout } = await execute('git', hardenedGitArgs(args), { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };

  async function patchId(repo: string, baseSha: string, head: string): Promise<string> {
    const diff = await git(repo, ['diff', `${baseSha}...${head}`]);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile('git', hardenedGitArgs(['patch-id', '--stable']), { cwd: repo, maxBuffer: 16 * 1024 * 1024 }, (error, output, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(output);
      });
      child.stdin?.end(diff);
    });
    const id = stdout.trim().split(/\s+/)[0];
    if (!id) throw new Error(`empty patch id for ${baseSha}...${head}`);
    return id;
  }

  async function refExists(repo: string, ref: string): Promise<boolean> {
    try {
      await git(repo, ['show-ref', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  }

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
      expectedGitDirs.set(root, (await git(root, ['rev-parse', '--absolute-git-dir'])).trim());
      return { path: root, branch, baseSha };
    },

    async remove(repo: string, path: string): Promise<void> {
      await git(repo, ['worktree', 'remove', '--force', path]);
      expectedGitDirs.delete(path);
    },

    async prune(repo: string): Promise<void> {
      await git(repo, ['worktree', 'prune']);
    },

    async deleteBranch(repo: string, branch: string): Promise<void> {
      await git(repo, ['branch', '-D', branch]);
    },

    async isTrackedClean(path: string): Promise<boolean> {
      const out = await git(path, ['status', '--porcelain']);
      return out.trim() === '';
    },

    async contains(repo: string, head: string, excludeBranch?: string): Promise<boolean> {
      try {
        const out = await git(repo, ['branch', '-r', '--contains', head]);
        const excluded = excludeBranch ? `origin/${excludeBranch}` : undefined;
        return out.split(/\r?\n/).map((line) => line.replace(/^\s*\*?\s*/, '').trim()).filter(Boolean).some((ref) => ref !== excluded && ref !== `refs/remotes/${excluded}`);
      } catch {
        return false;
      }
    },

    async reachableFromOrigin(repo: string, head: string): Promise<boolean> {
      try {
        return (await git(repo, ['branch', '-r', '--contains', head])).split(/\r?\n/)
          .map((line) => line.replace(/^\s*\*?\s*/, '').trim())
          .some((ref) => ref.startsWith('origin/') || ref.startsWith('refs/remotes/origin/'));
      } catch {
        return false;
      }
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

    patchId,

    async commitAll(path: string, message: string, repo?: string): Promise<string> {
      const expected = expectedGitDirs.get(path) ?? (repo ? await expectedWorktreeGitDir(repo, path, git) : undefined);
      if (!expected) throw new Error(`cannot verify gitdir for worktree ${path}`);
      await assertWorktreeGitDir(path, expected);
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

    async clone(slug: string, dest: string): Promise<void> {
      if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error('clone expects owner/name');
      try {
        await execute('gh', ['repo', 'clone', slug, dest], { maxBuffer: 16 * 1024 * 1024 });
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        // gh missing or not authenticated: fall back to anonymous https.
        if (code !== 'ENOENT' && typeof code === 'number' && existsSync(dest)) throw err;
        await execute('git', hardenedGitArgs(['clone', `https://github.com/${slug}.git`, dest]), { maxBuffer: 16 * 1024 * 1024 });
      }
    },

    async fetch(repo: string): Promise<void> {
      await git(repo, ['fetch', '--prune', 'origin']);
    },
  };
}
