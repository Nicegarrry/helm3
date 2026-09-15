import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { WorkspaceManager, WorkspaceRefusal } from '../../src/workspace/index.js';

const exec = promisify(execFile);
const owner = { attemptId: 'attempt-1', generation: 1, expiresAt: '2099-01-01T00:00:00Z' };

test('creates an exact-base worktree with one writer and refuses metadata and symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-workspace-'));
  try {
    const repository = join(root, 'repository');
    await mkdir(repository);
    await exec('git', ['init', repository]);
    await exec('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']);
    await exec('git', ['-C', repository, 'config', 'user.name', 'Test']);
    await writeFile(join(repository, 'README.md'), 'base\n');
    await exec('git', ['-C', repository, 'add', 'README.md']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
    const { stdout } = await exec('git', ['-C', repository, 'rev-parse', 'HEAD']);
    const manager = new WorkspaceManager();
    const worktree = await manager.create(repository, join(root, 'worker'), 'worker-attempt-1', stdout.trim(), owner);
    await manager.write(worktree, owner, 'result.txt', 'owned write\n');
    assert.equal(await readFile(join(worktree.root, 'result.txt'), 'utf8'), 'owned write\n');
    assert.deepEqual(await manager.changedFiles(worktree), ['result.txt']);
    await assert.rejects(manager.write(worktree, owner, '.git/config', 'bad'), WorkspaceRefusal);
    await mkdir(join(worktree.root, 'safe'));
    await symlink(root, join(worktree.root, 'safe', 'escape'));
    await assert.rejects(manager.write(worktree, owner, 'safe/escape/outside.txt', 'bad'), WorkspaceRefusal);
    assert.throws(() => manager.assertOwner(worktree, { ...owner, generation: 2 }), WorkspaceRefusal);
  } finally { await rm(root, { recursive: true, force: true }); }
});
