import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gateRunner } from '../src/gate.js';

test('run: passing and failing checks capture output to files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-'));
  const logDir = join(dir, 'logs');
  const runner = gateRunner();
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
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run: all passing checks means passed=true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-'));
  const logDir = join(dir, 'logs');
  const runner = gateRunner();
  try {
    const result = await runner.run(dir, [{ name: 'a', command: 'exit 0' }, { name: 'b', command: 'exit 0' }], logDir);
    assert.equal(result.passed, true);
    assert.deepEqual(result.checks.map((c) => c.exitCode), [0, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a timeout produces a null exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-'));
  const logDir = join(dir, 'logs');
  const runner = gateRunner();
  try {
    const result = await runner.run(dir, [{ name: 'slow', command: 'sleep 5' }], logDir, { timeoutMs: 200 });
    assert.equal(result.passed, false);
    assert.equal(result.checks[0]?.exitCode, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultChecks: reads gates from helm.json when present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-repo-'));
  const runner = gateRunner();
  try {
    writeFileSync(join(dir, 'helm.json'), JSON.stringify({ gates: [{ name: 'custom', command: 'echo hi' }] }));
    const checks = await runner.defaultChecks(dir);
    assert.deepEqual(checks, [{ name: 'custom', command: 'echo hi' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultChecks: falls back to package.json scripts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-repo-'));
  const runner = gateRunner();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit', build: 'tsc' } }));
    const checks = await runner.defaultChecks(dir);
    assert.deepEqual(checks, [
      { name: 'test', command: 'npm test' },
      { name: 'typecheck', command: 'npm run typecheck' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultChecks: no helm.json and no package.json means no checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-gate-repo-'));
  const runner = gateRunner();
  try {
    const checks = await runner.defaultChecks(dir);
    assert.deepEqual(checks, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
