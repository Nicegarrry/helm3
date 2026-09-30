import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { expandInstallChecks, gateRunner, sandboxEnabled } from '../src/gate.js';
import { disableGitMaintenance, removeTempDir } from './git-fixture.js';

test('run: passing and failing checks capture output to files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-'));
  const logDir = join(dir, 'logs');
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    const result = await runner.run(dir, [
      { name: 'ok', command: 'echo hello-out; echo hello-err 1>&2; exit 0' },
      { name: 'bad', command: 'echo failing; exit 3' },
    ], logDir);

    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 2);

    const ok = result.checks.find((c) => c.name === 'ok');
    const bad = result.checks.find((c) => c.name === 'bad');
    assert.equal(ok?.exitCode, 0);
    assert.equal(bad?.exitCode, 3);
    assert.ok(ok && ok.durationMs >= 0);

    const okLog = readFileSync(ok!.outputPath, 'utf8');
    assert.match(okLog, /hello-out/);
    assert.match(okLog, /hello-err/);

    const badLog = readFileSync(bad!.outputPath, 'utf8');
    assert.match(badLog, /failing/);
  } finally {
    removeTempDir(dir);
  }
});

test('run: all passing checks means passed=true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-'));
  const logDir = join(dir, 'logs');
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    const result = await runner.run(dir, [{ name: 'a', command: 'exit 0' }, { name: 'b', command: 'exit 0' }], logDir);
    assert.equal(result.passed, true);
    assert.deepEqual(result.checks.map((c) => c.exitCode), [0, 0]);
  } finally {
    removeTempDir(dir);
  }
});

test('run: a timeout produces a null exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-'));
  const logDir = join(dir, 'logs');
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    const result = await runner.run(dir, [{ name: 'slow', command: 'sleep 5' }], logDir, { timeoutMs: 200 });
    assert.equal(result.passed, false);
    assert.equal(result.checks[0]?.exitCode, null);
  } finally {
    removeTempDir(dir);
  }
});

test('run: removes all package node_modules on pass and fail, but preserves opted-in modules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-hygiene-'));
    const logDir = join(dir, 'logs');
  try {
    mkdirSync(join(dir, 'helm'), { recursive: true });
    writeFileSync(join(dir, 'helm', 'package.json'), '{}');
    const createsModules = 'mkdir -p node_modules helm/node_modules; exit 3';
    const removed = await gateRunner({ allowUnsandboxed: true }).run(dir, [{ name: 'fail', command: createsModules }], logDir);
    assert.equal(removed.passed, false);
    assert.equal(existsSync(join(dir, 'node_modules')), false);
    assert.equal(existsSync(join(dir, 'helm', 'node_modules')), false);

    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'helm', 'node_modules'), { recursive: true });
    await gateRunner({ allowUnsandboxed: true }).run(dir, [{ name: 'pass', command: 'exit 0' }], logDir);
    assert.equal(existsSync(join(dir, 'node_modules')), false);
    assert.equal(existsSync(join(dir, 'helm', 'node_modules')), false);

    mkdirSync(join(dir, 'app', 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'app', 'package.json'), '{}');
    await gateRunner({ allowUnsandboxed: true }).run(dir, [{ name: 'package', command: 'exit 0' }], logDir);
    assert.equal(existsSync(join(dir, 'app', 'node_modules')), false);
    mkdirSync(join(dir, 'app', 'node_modules'), { recursive: true });
    await gateRunner({ keepNodeModules: true, allowUnsandboxed: true }).run(dir, [{ name: 'keep', command: 'mkdir -p node_modules helm/node_modules; exit 0' }], logDir, { sandbox: false });
    assert.equal(existsSync(join(dir, 'node_modules')), true);
    assert.equal(existsSync(join(dir, 'helm', 'node_modules')), true);
    assert.equal(existsSync(join(dir, 'app', 'node_modules')), true);
  } finally {
    removeTempDir(dir);
  }
});

test('defaultChecks: reads gates from helm.json when present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-repo-'));
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    writeFileSync(join(dir, 'helm.json'), JSON.stringify({ gates: [{ name: 'custom', command: 'echo hi' }] }));
    const checks = await runner.defaultChecks(dir);
    assert.deepEqual(checks, [{ name: 'custom', command: 'echo hi' }]);
  } finally {
    removeTempDir(dir);
  }
});

test('install checks ignore scripts online and run lifecycle scripts in a separate offline step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-install-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { prepare: 'node prepare.js' } }));
    assert.deepEqual(await expandInstallChecks(dir, [{ name: 'install', command: 'npm ci --no-audit --no-fund' }]), [
      { name: 'install', command: 'npm ci --ignore-scripts --no-audit --no-fund', allowNetwork: true },
      { name: 'install (offline scripts)', command: 'npm rebuild --offline && npm run prepare --if-present --offline' },
    ]);
    assert.deepEqual(await expandInstallChecks(dir, [{ name: 'combined', command: 'npm ci && npm test' }]), [
      { name: 'combined', command: 'npm ci && npm test' },
    ]);
  } finally {
    removeTempDir(dir);
  }
});

test('defaultChecks: a worker helm.json change cannot remove base gates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-repo-'));
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    disableGitMaintenance(dir);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'helm.json'), JSON.stringify({ gates: [{ name: 'base', command: 'echo base' }] }));
    execFileSync('git', ['add', 'helm.json'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'helm.json'), JSON.stringify({ gates: [] }));

    assert.deepEqual(await runner.defaultChecks(dir, baseSha), [{ name: 'base', command: 'echo base' }]);
  } finally {
    removeTempDir(dir);
  }
});

test('sandbox opt-out is read from the base helm.json, never the worker copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-policy-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    disableGitMaintenance(dir);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'helm.json'), JSON.stringify({ gates: [], gate: { sandbox: false } }));
    execFileSync('git', ['add', 'helm.json'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'helm.json'), JSON.stringify({ gates: [], gate: { sandbox: true } }));
    assert.equal(await sandboxEnabled(dir, baseSha), false);
  } finally {
    removeTempDir(dir);
  }
});

test('defaultChecks: an untracked operator helm.json is used when absent at the base sha', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-repo-'));
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    disableGitMaintenance(dir);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'base', '--allow-empty'], { cwd: dir });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(dir, 'helm.json'), JSON.stringify({ gates: [{ name: 'local', command: 'echo local' }] }));
    assert.deepEqual(await runner.defaultChecks(dir, baseSha), [{ name: 'local', command: 'echo local' }]);
  } finally {
    removeTempDir(dir);
  }
});

test('defaultChecks: a helm.json in a separate worker worktree is not used', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-repo-'));
  const worker = mkdtempSync(join(tmpdir(), 'helm-gate-worker-'));
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    disableGitMaintenance(dir);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'base', '--allow-empty'], { cwd: dir });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    writeFileSync(join(worker, 'helm.json'), JSON.stringify({ gates: [{ name: 'worker', command: 'echo worker' }] }));
    assert.deepEqual(await runner.defaultChecks(dir, baseSha), []);
  } finally {
    removeTempDir(dir);
    removeTempDir(worker);
  }
});

test('defaultChecks: falls back to package.json scripts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-repo-'));
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit', build: 'tsc' } }));
    const checks = await runner.defaultChecks(dir);
    assert.deepEqual(checks, [
      { name: 'test', command: 'npm test' },
      { name: 'typecheck', command: 'npm run typecheck' },
    ]);
  } finally {
    removeTempDir(dir);
  }
});

test('F8: a check name with path traversal characters is slugified and its log stays inside logDir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-'));
  const logDir = join(dir, 'logs');
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    const result = await runner.run(dir, [{ name: 'unit/../x', command: 'echo hi' }], logDir);
    const check = result.checks[0]!;
    assert.equal(check.name, 'unit/../x'); // display name is preserved as-is
    assert.ok(check.outputPath.startsWith(logDir + sep), `outputPath ${check.outputPath} should live inside ${logDir}`);
    assert.ok(existsSync(check.outputPath));
    assert.equal(readFileSync(check.outputPath, 'utf8').includes('hi'), true);
  } finally {
    removeTempDir(dir);
  }
});

test('F8: two checks that slugify to the same name get distinct, index-suffixed logs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-'));
  const logDir = join(dir, 'logs');
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    const result = await runner.run(
      dir,
      [
        { name: 'a/b', command: 'echo one' },
        { name: 'a:b', command: 'echo two' },
      ],
      logDir,
    );
    const [first, second] = result.checks;
    assert.notEqual(first!.outputPath, second!.outputPath);
    assert.ok(readFileSync(first!.outputPath, 'utf8').includes('one'));
    assert.ok(readFileSync(second!.outputPath, 'utf8').includes('two'));
  } finally {
    removeTempDir(dir);
  }
});

test('defaultChecks: no helm.json and no package.json means no checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-repo-'));
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    const checks = await runner.defaultChecks(dir);
    assert.deepEqual(checks, []);
  } finally {
    removeTempDir(dir);
  }
});
