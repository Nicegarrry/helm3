import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import test from 'node:test';
import { gateRunner } from '../src/gate.js';
import { buildSandboxProfile, operatorHomePaths, sandboxExecutable, worktreeGitDirs } from '../src/sandbox.js';

const sandboxUsable = process.platform === 'darwin' && Boolean(sandboxExecutable()) && (() => {
  try { execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true']); return true; } catch { return false; }
})();
const macOnly = !sandboxUsable ? { skip: 'a usable macOS sandbox-exec is required' } : undefined;

function fixture(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('generated profile denies credentials and writes outside the worktree', () => {
  const home = '/Users/tester';
  const cwd = '/Users/tester/.helm/worktrees/project/w-123';
  const tempDir = '/private/tmp/helm-gate-123';
  const tempHome = join(tempDir, 'home');
  const profile = buildSandboxProfile({ cwd, tempDir, operatorHomes: [home], gateHome: tempHome, toolchainPaths: [join(home, '.nvm', 'versions', 'node', 'v22', 'bin')], npmCachePaths: [join(home, '.npm')], gitDir: '/Users/tester/.helm/worktrees/project/.git/worktrees/w-123', allowNetwork: false });

  assert.match(profile, new RegExp(`\\(deny file-read\\* \\(subpath "${home.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"\\)\\)`));
  assert.match(profile, /\(deny file-read\* \(subpath ".*\/\.config"\)\)/);
  assert.match(profile, /\(allow file-read\* \(subpath ".*\/\.config\/git"\)\)/);
  assert.match(profile, /\(allow file-read\* \(subpath ".*\/\.nvm\/versions\/node\/v22\/bin"\)\)/);
  assert.match(profile, /\(allow file-read\* \(subpath ".*\/\.npm"\)\)/);
  assert.match(profile, /\(deny file-read\* \(subpath ".*\/\.ssh"\)\)/);
  assert.match(profile, /\(deny file-read\* \(subpath ".*\/\.helm"\)\)/);
  assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${cwd.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"\\)\\)`));
  assert.match(profile, new RegExp(`\\(deny file-write\\* \\(subpath "${cwd.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}/\\.git"\\)\\)`));
  assert.match(profile, /\(deny network\*\)/);
  assert.doesNotMatch(profile, /allow network/);
  const tempRead = profile.indexOf(`(allow file-read* (subpath "${tempDir}"))`);
  const homeDeny = profile.indexOf(`(deny file-read* (subpath "${home}"))`);
  assert.ok(tempRead >= 0 && homeDeny >= 0 && homeDeny < tempRead, 'HOME deny must precede disposable temp HOME re-allow');
});

test('operatorHome adds a fixture to the real operator HOME deny list', () => {
  const fixtureHome = '/private/tmp/helm-gate-fixture-home';
  assert.deepEqual(operatorHomePaths(fixtureHome), [homedir(), fixtureHome]);
  assert.deepEqual(operatorHomePaths(), [homedir()]);
});

test('git sandbox directories come from git rev-parse', async () => {
  const root = fixture('helm-gate-git-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const expected = [...new Set(
      execFileSync('git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'], { cwd: root, encoding: 'utf8' })
        .trim().split(/\r?\n/).map((path) => realpathSync(path.startsWith('/') ? path : join(root, path))),
    )].sort();
    assert.deepEqual((await worktreeGitDirs(root)).sort(), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate cannot read the temporary HOME credential fixture or write outside the worktree', macOnly, async () => {
  const root = fixture('helm-gate-sandbox-');
  const operatorHome = join(root, 'operator-home');
  const worktree = join(root, 'worktree');
  const logDir = join(root, 'logs');
  const secret = join(operatorHome, 'code', 'other', '.env.local');
  const outside = join(root, 'outside.txt');
  mkdirSync(join(operatorHome, 'code', 'other'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(secret, 'HELM_SECRET=must-not-escape');
  try {
    const runner = gateRunner({ operatorHome });
    const result = await runner.run(worktree, [
      { name: 'credential-read', command: `cat ${JSON.stringify(secret)}` },
      { name: 'outside-write', command: `node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(outside)}, 'nope')`)}` },
    ], logDir);
    assert.equal(result.passed, false);
    assert.notEqual(result.checks[0]?.exitCode, 0);
    assert.match(readFileSync(result.checks[0]!.outputPath, 'utf8'), /Operation not permitted|operation not permitted|Permission denied|permission denied/);
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test steps have no network, while npm ci steps are profiled for network', macOnly, async () => {
  const root = fixture('helm-gate-network-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  try {
    const result = await gateRunner().run(worktree, [
      { name: 'test', command: 'curl --max-time 2 https://example.com' },
      { name: 'install', command: 'npm ci --ignore-scripts --no-audit --no-fund' },
    ], join(root, 'logs'), { timeoutMs: 10_000 });
    assert.equal(result.passed, false);
    assert.notEqual(result.checks[0]?.exitCode, 0);
    assert.notEqual(result.checks[1]?.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real macOS smoke applies the profile to cat, curl, and an in-worktree node write', macOnly, async () => {
  const root = fixture('helm-gate-smoke-');
  const worktree = join(root, 'worktree');
  const secret = join(root, '.config', 'helm', 'env');
  const output = join(worktree, 'ok.txt');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(root, '.config', 'helm'), { recursive: true });
  writeFileSync(secret, 'smoke-secret');
  try {
    const result = await gateRunner({ operatorHome: root }).run(worktree, [
      { name: 'cat-secret', command: `cat ${JSON.stringify(secret)}` },
      { name: 'curl-network', command: 'curl --max-time 2 https://example.com' },
      { name: 'worktree-write', command: `node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(output)}, 'ok')`)}` },
    ], join(root, 'logs'), { timeoutMs: 10_000 });
    assert.equal(result.passed, false);
    assert.notEqual(result.checks[0]?.exitCode, 0);
    assert.notEqual(result.checks[1]?.exitCode, 0);
    assert.equal(result.checks[2]?.exitCode, 0);
    assert.equal(readFileSync(output, 'utf8'), 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
