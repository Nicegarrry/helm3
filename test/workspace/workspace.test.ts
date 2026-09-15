import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { WorkspaceManager, WorkspaceRefusal } from '../../src/workspace/index.js';

const exec = promisify(execFile);
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as { DatabaseSync: new (path: string) => { prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): unknown }; close(): void } };
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
    const manager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
    const worktree = await manager.create(repository, join(root, 'worker'), 'worker-attempt-1', stdout.trim(), owner);
    await manager.write(worktree, owner, 'result.txt', 'owned write\n');
    assert.equal(await readFile(join(worktree.root, 'result.txt'), 'utf8'), 'owned write\n');
    assert.deepEqual(await manager.changedFiles(worktree), ['result.txt']);
    await assert.rejects(manager.write(worktree, owner, '.git/config', 'bad'), WorkspaceRefusal);
    await mkdir(join(worktree.root, 'safe'));
    await symlink(root, join(worktree.root, 'safe', 'escape'));
    await assert.rejects(manager.write(worktree, owner, 'safe/escape/outside.txt', 'bad'), WorkspaceRefusal);
    assert.throws(() => manager.assertOwner(worktree, { ...owner, generation: 2 }), WorkspaceRefusal);
    await assert.rejects(manager.write(worktree, owner, './src/core/backdoor.ts', 'bad'), WorkspaceRefusal);
    await assert.rejects(manager.write(worktree, owner, join(worktree.root, '.github/workflows/bad.yml'), 'bad'), WorkspaceRefusal);
    await manager.write(worktree, owner, 'README.md', 'edited');
    await manager.write(worktree, owner, 'README.md', 'base\n');
    assert.equal((await manager.changedFiles(worktree)).includes('README.md'), false, 'reverted bytes are not a changed-file claim');
    await manager.write(worktree, owner, 'nested/new.txt', 'nested');
    assert.ok((await manager.changedFiles(worktree)).includes('nested/new.txt'));
    await writeFile(join(root, 'outside'), 'outside');
    await link(join(root, 'outside'), join(worktree.root, 'hardlink'));
    await assert.rejects(manager.write(worktree, owner, 'hardlink', 'bad'), WorkspaceRefusal);
    assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'outside');
    const second = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
    second.assertOwner(worktree, owner);
    await assert.rejects(second.create(repository, worktree.root, 'other-branch', stdout.trim(), owner), /durable owner/);
    const nextOwner = { ...owner, attemptId: 'replacement', generation: 2 };
    const next = second.transfer(worktree, 1, nextOwner);
    assert.throws(() => manager.assertOwner(worktree, owner), /generation/);
    assert.throws(() => manager.transfer(worktree, 1, { ...nextOwner, generation: 2 }), /generation/);
    second.close(); manager.close();
    const restarted = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
    restarted.assertOwner(next, nextOwner);
    assert.throws(() => restarted.assertOwner(next, { ...nextOwner, expiresAt: '2100-01-01T00:00:00Z' }), /generation/);
    restarted.close();
    const expired = new WorkspaceManager({ stateRoot: join(root, 'workspace-state'), now: () => Date.parse('2100-01-01T00:00:00Z') });
    assert.throws(() => expired.assertOwner(next, nextOwner), /expired/);
    assert.equal((await expired.inspectGitReadonly(next)).head, stdout.trim(), 'historical Git observation remains available after the former owner lease expires');
    expired.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('review worktree grants bounded reads with no writable roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-review-workspace-')); const manager = new WorkspaceManager({ stateRoot: join(root, 'state') });
  try {
    const repository = join(root, 'repository'); await mkdir(repository); await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repository, 'config', 'user.name', 'Test']);
    await mkdir(join(repository, 'src', 'core'), { recursive: true }); await writeFile(join(repository, 'src', 'reviewed.ts'), 'export const reviewed = true;\n'); await writeFile(join(repository, 'src', 'core', 'authority.ts'), 'export const authority = true;\n'); await writeFile(join(repository, 'large.txt'), 'x'.repeat(16)); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
    const head = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim(); const review = await manager.create(repository, join(root, 'review'), 'review-attempt', head, owner, { writableRoots: [], readableRoots: ['src', 'large.txt'] });
    assert.match(await manager.read(review, 'src/reviewed.ts', 1024), /reviewed/); assert.match(await manager.read(review, 'src/core/authority.ts', 1024), /authority/, 'reviewers may inspect explicitly granted control code'); await assert.rejects(manager.write(review, owner, 'src/reviewed.ts', 'bad'), WorkspaceRefusal); await assert.rejects(manager.write(review, owner, 'src/core/authority.ts', 'bad'), WorkspaceRefusal); await assert.rejects(manager.read(review, 'large.txt', 8), WorkspaceRefusal); await assert.rejects(manager.read(review, '../outside', 1024), WorkspaceRefusal);
  } finally { manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('restart normalizes legacy reservation bytes without readableRoots while preserving explicit read denial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-legacy-readable-roots-'));
  let manager: WorkspaceManager | undefined;
  try {
    const repository = join(root, 'repository'); await mkdir(repository); await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repository, 'config', 'user.name', 'Test']);
    await writeFile(join(repository, 'README.md'), 'base\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
    const head = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim(); const stateRoot = join(root, 'state'); const destination = join(root, 'legacy-worker');
    manager = new WorkspaceManager({ stateRoot }); const created = await manager.create(repository, destination, 'legacy-worker', head, owner, { writableRoots: ['.'] }); manager.close(); manager = undefined;
    const database = new DatabaseSync(join(stateRoot, 'ownership.sqlite'));
    const row = database.prepare('SELECT bytes FROM workspace_ownership WHERE root=?').get(created.root) as { bytes: string };
    const legacy = JSON.parse(row.bytes) as Record<string, unknown>; delete legacy.readableRoots;
    database.prepare('UPDATE workspace_ownership SET bytes=? WHERE root=?').run(JSON.stringify(legacy), created.root); database.close();
    const recovered = new WorkspaceManager({ stateRoot }); manager = recovered; const restored = recovered.reservation(created.root);
    assert.deepEqual(restored.readableRoots, ['.']); assert.ok(Object.isFrozen(restored.readableRoots)); recovered.assertOwner(restored, owner);
    assert.equal(await recovered.read(restored, 'README.md'), 'base\n'); await recovered.write(restored, owner, 'result.txt', 'owned\n');
    const nextOwner = { ...owner, attemptId: 'successor', generation: 2 }; const transferred = recovered.transfer(restored, 1, nextOwner); recovered.assertOwner(transferred, nextOwner);
    const readonly = await recovered.create(repository, join(root, 'explicit-none'), 'explicit-none', head, { ...owner, attemptId: 'attempt-readonly' }, { writableRoots: [], readableRoots: [] });
    assert.deepEqual(recovered.reservation(readonly.root).readableRoots, []); await assert.rejects(recovered.read(readonly, 'README.md'), WorkspaceRefusal);
    const tamper = new DatabaseSync(join(stateRoot, 'ownership.sqlite')); const readonlyRow = tamper.prepare('SELECT bytes FROM workspace_ownership WHERE root=?').get(readonly.root) as { bytes: string }; const altered = JSON.parse(readonlyRow.bytes) as { readableRoots: string[] }; altered.readableRoots = ['.']; tamper.prepare('UPDATE workspace_ownership SET bytes=? WHERE root=?').run(JSON.stringify(altered), readonly.root); tamper.close();
    assert.throws(() => recovered.assertOwner(readonly, readonly.owner), WorkspaceRefusal);
  } finally { manager?.close(); await rm(root, { recursive: true, force: true }); }
});
