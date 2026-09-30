import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const HARDENING_ARGS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=ssh',
  '-c', 'protocol.ext.allow=never',
] as const;

/** Add the daemon-owned git policy to every Helm git invocation. */
export function hardenedGitArgs(args: readonly string[]): string[] {
  const hardened = [...HARDENING_ARGS, ...args];
  const commandIndex = args.findIndex((arg) => arg === 'commit' || arg === 'merge');
  const command = commandIndex < 0 ? undefined : args[commandIndex];
  if (command) {
    hardened.splice(HARDENING_ARGS.length + commandIndex + 1, 0, '--no-verify');
  }
  return hardened;
}

/** Refuse a worker whose linked-worktree git pointer no longer matches Helm's metadata. */
export async function assertWorktreeGitDir(worktree: string, expectedGitDir: string): Promise<void> {
  const gitFile = join(worktree, '.git');
  const pointer = (await readFile(gitFile, 'utf8')).match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!pointer) throw new Error(`worktree .git pointer is missing: ${gitFile}`);
  const actual = await realpath(resolve(dirname(gitFile), pointer));
  const expected = await realpath(expectedGitDir);
  if (actual !== expected) throw new Error(`worktree .git points to ${actual}, expected ${expected}`);
}

/** Find the gitdir recorded by the trusted repository's linked-worktree metadata. */
export async function expectedWorktreeGitDir(
  repo: string,
  worktree: string,
  git: (cwd: string, args: string[]) => Promise<string>,
): Promise<string> {
  const rawCommonDir = (await git(repo, ['rev-parse', '--git-common-dir'])).trim();
  const commonDir = resolve(repo, rawCommonDir);
  const expectedPointer = await realpath(join(worktree, '.git'));
  for (const entry of await readdir(join(commonDir, 'worktrees'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadata = join(commonDir, 'worktrees', entry.name);
    const pointer = await readFile(join(metadata, 'gitdir'), 'utf8').catch(() => '');
    if (pointer.trim() && await realpath(pointer.trim()).catch(() => '') === expectedPointer) return metadata;
  }
  throw new Error(`could not find expected gitdir for worktree ${worktree}`);
}
