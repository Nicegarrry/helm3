import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Helm } from '../src/helm.js';
import { listBaselines } from '../src/baseline.js';
import { openStore } from '../src/store.js';
import { validatorPrompt } from '../src/prompt.js';
import type { GateRunner, GitHub, HelmConfig, PrStatus, Store, WorkerRow, WorkerRunner, Workspace } from '../src/types.js';

const SHA = 'a'.repeat(40);

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function makeRepo(files: Record<string, string>): { repo: string; baseSha: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), 'helm-baseline-repo-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [], acceptance: { testGlobs: ['test/**/*.test.ts'] } }));
  for (const [file, content] of Object.entries(files)) { mkdirSync(join(repo, file, '..'), { recursive: true }); writeFileSync(join(repo, file), content); }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), `${content}\nchanged`);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'validator']);
  return { repo, baseSha, head: git(repo, ['rev-parse', 'HEAD']) };
}

function worker(repo: string, baseSha: string, head: string, role: WorkerRow['role'] = 'validator', state: WorkerRow['state'] = 'succeeded'): WorkerRow {
  const now = new Date().toISOString();
  return {
    workerId: 'w-validator', repo, repoSlug: 'owner/repo', role, model: 'codex/test', objective: 'validate', acceptance: null,
    contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha, branch: 'helm/w-validator', worktree: repo,
    state, head, sessionFile: null, result: { status: 'succeeded', summary: 'red test', changedFiles: ['test/feature.test.ts'], commandsRun: [], acceptance: { command: 'npm test', files: ['test/feature.test.ts'] } },
    rawResultText: null, idempotencyKey: null, createdAt: now, updatedAt: now,
  };
}

function deps(store: Store, gates: GateRunner): Helm {
  const home = mkdtempSync(join(tmpdir(), 'helm-baseline-home-'));
  const workspace: Workspace = {
    async resolveSha(_repo, ref) { return ref; }, async defaultBranch() { return 'main'; },
    async create(_repo, path, branch, baseSha) { return { path, branch, baseSha }; }, async remove() {},
    async head() { return SHA; }, async isClean() { return true; }, async diffStat() { return ''; },
    async commitAll(path) { return path; }, async push() {}, async clone() {}, async fetch() {},
  };
  const github: GitHub = {
    async openPr() { return { number: 1, url: 'https://example.invalid/1' }; },
    async prStatus(_repo, number): Promise<PrStatus> { return { number, state: 'open', head: SHA, mergeable: true, draft: false, checks: [], reviews: [], url: 'https://example.invalid/1' }; },
    async comment() {}, async merge() {},
  };
  const runner: WorkerRunner = { async run() { return { result: null, rawText: '', sessionFile: null }; } };
  return new Helm({ config: { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 5000 }, store, workspace, gates, github, runner, prompts: { builder: () => 'build', reviewer: () => 'review', validator: validatorPrompt } });
}

test('gate.baseline records a red row at the validator head', async () => {
  const { repo, baseSha, head } = makeRepo({ 'test/feature.test.ts': 'assert.fail()' });
  const store = openStore(':memory:');
  const gates: GateRunner = { async run() { return { passed: false, checks: [{ name: 'acceptance', command: 'npm test', exitCode: 1, outputPath: '/tmp/red.log', durationMs: 1 }] }; }, async defaultChecks() { return []; } };
  const helm = deps(store, gates);
  try {
    store.insertWorker(worker(repo, baseSha, head));
    store.setMeta('w-validator', { issue: 183 });
    const result = await helm.baseline({ workerId: 'w-validator' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(listBaselines(store)[0]?.red, 1);
    assert.equal(listBaselines(store)[0]?.testCommit, head);
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }); }
});

test('gate.baseline refuses a passing validator command', async () => {
  const { repo, baseSha, head } = makeRepo({ 'test/feature.test.ts': 'assert.ok(true)' });
  const store = openStore(':memory:');
  const gates: GateRunner = { async run() { return { passed: true, checks: [{ name: 'acceptance', command: 'npm test', exitCode: 0, outputPath: '/tmp/green.log', durationMs: 1 }] }; }, async defaultChecks() { return []; } };
  const helm = deps(store, gates);
  try {
    store.insertWorker(worker(repo, baseSha, head)); store.setMeta('w-validator', { issue: 183 });
    assert.deepEqual(await helm.baseline({ workerId: 'w-validator' }), { ok: false, reason: 'test already passes' });
    assert.deepEqual(listBaselines(store), []);
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }); }
});

test('gate.baseline names non-test files and rejects non-validator workers', async () => {
  const { repo, baseSha, head } = makeRepo({ 'test/feature.test.ts': 'assert.fail()', 'src/feature.ts': 'export const x = 1;' });
  const store = openStore(':memory:');
  const gates: GateRunner = { async run() { throw new Error('must not run'); }, async defaultChecks() { return []; } };
  const helm = deps(store, gates);
  try {
    store.insertWorker(worker(repo, baseSha, head)); store.setMeta('w-validator', { issue: 183 });
    const refused = await helm.baseline({ workerId: 'w-validator' });
    assert.equal(refused.ok, false); if (!refused.ok) assert.match(refused.reason, /src\/feature\.ts/);
    store.insertWorker({ ...worker(repo, baseSha, head, 'builder'), workerId: 'w-builder' });
    assert.deepEqual(await helm.baseline({ workerId: 'w-builder' }), { ok: false, reason: 'worker is not a succeeded validator' });
    store.insertWorker({ ...worker(repo, baseSha, head, 'validator', 'failed'), workerId: 'w-failed' });
    assert.deepEqual(await helm.baseline({ workerId: 'w-failed' }), { ok: false, reason: 'worker is not a succeeded validator' });
  } finally { store.close(); rmSync(repo, { recursive: true, force: true }); }
});

test('validatorPrompt forbids non-test edits', () => {
  const prompt = validatorPrompt({ objective: 'add behaviour', acceptance: 'the test fails first', contextPaths: [] });
  assert.match(prompt, /only test files/i); assert.match(prompt, /Do not edit production code/i); assert.match(prompt, /acceptance/);
});
