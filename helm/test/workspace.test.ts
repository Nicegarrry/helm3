import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gitWorkspace } from '../src/workspace.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function makeRepo(): Promise<{ dir: string; repo: string; sha: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'helm-ws-'));
  const repo = join(dir, 'repo');
  await exec('git', ['init', '-b', 'main', repo]);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Test'], {});
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.com'], {});
  writeFileSync(join(repo, 'file.txt'), 'hello\n');
  await exec('git', ['-C', repo, 'add', 'file.txt']);
  await exec('git', ['-C', repo, 'commit', '-m', 'initial commit']);
  const sha = await git(repo, ['rev-parse', 'HEAD']);
  return { dir, repo, sha };
}

test('resolveSha, defaultBranch, create worktree, commitAll, diffStat, isClean, remove', async () => {
  const { dir, repo, sha } = await makeRepo();
  const workspace = gitWorkspace();
  try {
    const resolved = await workspace.resolveSha(repo, 'HEAD');
    assert.equal(resolved, sha);

    const branchName = await workspace.defaultBranch(repo);
    assert.equal(branchName, 'main');

    const worktreeRoot = join(dir, 'worktrees', 'w-1');
    const info = await workspace.create(repo, worktreeRoot, 'helm/w-1', sha);
    assert.equal(info.path, worktreeRoot);
    assert.equal(info.branch, 'helm/w-1');
    assert.equal(info.baseSha, sha);

    assert.equal(await workspace.isClean(worktreeRoot), true);
    assert.equal(await workspace.head(worktreeRoot), sha);

    writeFileSync(join(worktreeRoot, 'new.txt'), 'added content\n');
    assert.equal(await workspace.isClean(worktreeRoot), false);

    const newHead = await workspace.commitAll(worktreeRoot, 'add new file');
    assert.notEqual(newHead, sha);
    assert.equal(await workspace.isClean(worktreeRoot), true);

    const stat = await workspace.diffStat(worktreeRoot, sha);
    assert.match(stat, /new\.txt/);
    assert.match(stat, /1 \+/);

    // No-op commit: nothing changed, head must stay the same.
    const unchanged = await workspace.commitAll(worktreeRoot, 'nothing to commit');
    assert.equal(unchanged, newHead);

    await workspace.remove(repo, worktreeRoot);
    const list = await git(repo, ['worktree', 'list']);
    assert.doesNotMatch(list, /w-1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create rejects a base SHA that does not resolve exactly', async () => {
  const { dir, repo } = await makeRepo();
  const workspace = gitWorkspace();
  try {
    const worktreeRoot = join(dir, 'worktrees', 'w-bad');
    await assert.rejects(() => workspace.create(repo, worktreeRoot, 'helm/w-bad', 'f'.repeat(40)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitAll sets a commit identity when the repo has none configured', async () => {
  const { dir, repo, sha } = await makeRepo();
  const workspace = gitWorkspace();
  try {
    const worktreeRoot = join(dir, 'worktrees', 'w-noident');
    await workspace.create(repo, worktreeRoot, 'helm/w-noident', sha);
    // Strip identity from the worktree's local config so global/system config (if any) is the
    // only source; then force "none configured" by pointing HOME/GIT config env at an empty dir.
    writeFileSync(join(worktreeRoot, 'more.txt'), 'x\n');
    const originalHome = process.env.HOME;
    const originalNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    // Point HOME at an empty dir with no ~/.gitconfig, so only the worktree's own
    // (unconfigured) local config is visible and `git config user.name` reports nothing.
    process.env.HOME = dir;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      const head = await workspace.commitAll(worktreeRoot, 'no identity commit');
      assert.notEqual(head, sha);
    } finally {
      if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
      if (originalNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = originalNoSystem;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
