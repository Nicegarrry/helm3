import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { Helm } from '../src/helm.js';
import { ensureBaselineTable } from '../src/baseline.js';
import { openStore } from '../src/store.js';
import type { GateRunner, GitHub, HelmConfig, PrStatus, Store, WorkerHooks, WorkerRunner, Workspace } from '../src/types.js';
import { disableGitMaintenance, removeTempDir } from './git-fixture.js';

const TEST_COMMIT = 'test-commit';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repoFixture(): { repo: string; baseSha: string; testCommit: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), 'helm-b5b-repo-'));
  git(repo, ['init', '-q']); git(repo, ['config', 'user.name', 'Test']); git(repo, ['config', 'user.email', 'test@example.invalid']);
  disableGitMaintenance(repo);
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [], acceptance: { testGlobs: ['test/**/*.test.ts'], command: 'npm run acceptance-from-base' } }));
  writeFileSync(join(repo, 'test', 'feature.test.ts'), 'assert.fail()'); writeFileSync(join(repo, 'src.ts'), 'export const base = true;');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base']); const baseSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'test', 'feature.test.ts'), 'assert.fail();\n// validator');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'validator']); const testCommit = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'src.ts'), 'export const implemented = true;');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'builder']); const head = git(repo, ['rev-parse', 'HEAD']);
  return { repo, baseSha, testCommit, head };
}

function baseline(store: Store, repoSlug: string, baseSha: string, testCommit: string, command = 'npm run validator-acceptance'): void {
  ensureBaselineTable(store);
  store.sql.prepare('INSERT INTO baselines (id, repoSlug, issue, validatorId, baseRef, baseSha, testCommit, command, files, red, outputPath, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('b-test', repoSlug, 184, 'w-validator', 'main', baseSha, testCommit, command, JSON.stringify(['test/feature.test.ts']), 1, '/tmp/red.log', new Date().toISOString());
}

function harness(fixture: ReturnType<typeof repoFixture>, gateOutcome = { passed: true, checks: [] as Array<{ name: string; command: string; exitCode: number | null; outputPath: string; durationMs: number }> }) {
  const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-b5b-home-')); const created: string[] = [];
  let opened: { base: string; body: string } | undefined; let recordedChecks: Array<{ name: string; command: string }> = [];
  const workspace: Workspace = {
    async resolveSha(_repo, ref) { return ref === TEST_COMMIT ? fixture.testCommit : ref; }, async defaultBranch() { return 'main'; },
    async create(_repo, path, branch, baseSha) { created.push(`${branch}:${baseSha}`); execFileSync('ln', ['-s', fixture.repo, path]); return { path, branch, baseSha }; }, async remove() {},
    async head() { return git(fixture.repo, ['rev-parse', 'HEAD']); }, async isClean() { return true; }, async diffStat() { return ''; }, async commitAll() { return fixture.head; }, async push() {}, async clone() {}, async fetch() {}, async patchId() { return 'patch'; },
  };
  const gates: GateRunner = { async run(_cwd, checks) { recordedChecks = [...checks]; return gateOutcome.checks.length > 0 ? gateOutcome : { passed: true, checks: checks.map((check) => ({ ...check, exitCode: 0, outputPath: '/tmp/check', durationMs: 1 })) }; }, async defaultChecks() { return [{ name: 'typecheck', command: 'npm run typecheck' }]; } };
  const github: GitHub = { async openPr(input) { opened = { base: input.base, body: input.body }; return { number: 1, url: 'https://example.invalid/1' }; }, async prStatus(_repo, number): Promise<PrStatus> { return { number, state: 'open', head: fixture.head, mergeable: true, draft: false, checks: [], reviews: [], url: 'https://example.invalid/1' }; }, async comment() { return { body: '' }; }, async postComment() {}, async merge() {} };
  const runner: WorkerRunner = { async run(_input, _message, _hooks: WorkerHooks) { return { result: { status: 'succeeded', summary: 'built', changedFiles: ['src.ts'], commandsRun: [] }, rawText: '', sessionFile: null }; } };
  const config: HelmConfig = { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 5000 };
  const helm = new Helm({ config, store, workspace, gates, github, runner, prompts: { builder: () => 'build', reviewer: () => 'review', validator: () => 'validate' } });
  return { helm, store, created, get opened() { return opened; }, get recordedChecks() { return recordedChecks; }, close() { store.close(); removeTempDir(home); removeTempDir(fixture.repo); } };
}

test('B5b binds spawn base, gate acceptance, PR base, and red/green body', async () => {
  const fixture = repoFixture(); const d = harness(fixture); baseline(d.store, basename(fixture.repo), fixture.baseSha, fixture.testCommit);
  try {
    const spawned = await d.helm.spawn({ repo: fixture.repo, objective: 'build', model: 'test/model', baselineId: 'b-test', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(spawned.ok, true); if (!spawned.ok) return; await d.helm.settle(spawned.workerId);
    assert.deepEqual(d.created, [`${spawned.branch}:${fixture.testCommit}`]);
    assert.equal(d.store.getMeta(spawned.workerId)?.prBase, 'main');
    const gate = await d.helm.gate({ workerId: spawned.workerId, checks: [{ name: 'typecheck', command: 'listed' }] });
    assert.equal(gate.ok, true); assert.deepEqual(d.recordedChecks, [{ name: 'typecheck', command: 'listed' }, { name: 'acceptance', command: 'npm run acceptance-from-base' }]);
    const pr = await d.helm.prOpen({ workerId: spawned.workerId, draft: true }); assert.equal(pr.ok, true);
    assert.equal(d.opened?.base, 'main'); assert.match(d.opened?.body ?? '', new RegExp(`red at ${fixture.baseSha}, green at ${fixture.head}`));
  } finally { d.close(); }
});

test('B5b refuses edited baseline tests and a failed acceptance check', async () => {
  const fixture = repoFixture(); const failing = { passed: false, checks: [{ name: 'acceptance', command: 'validator', exitCode: 1, outputPath: '/tmp/a', durationMs: 1 }] }; const d = harness(fixture, failing); baseline(d.store, basename(fixture.repo), fixture.baseSha, fixture.testCommit);
  try {
    const row = { workerId: 'w-builder', repo: fixture.repo, repoSlug: basename(fixture.repo), role: 'builder' as const, model: 'test/model', objective: 'build', acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: fixture.testCommit, baseSha: fixture.testCommit, branch: 'helm/w-builder', worktree: fixture.repo, state: 'succeeded' as const, head: fixture.head, sessionFile: null, result: { status: 'succeeded' as const, summary: 'built', changedFiles: ['src.ts'], commandsRun: [] }, rawResultText: null, idempotencyKey: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    d.store.insertWorker(row); d.store.setMeta(row.workerId, { baselineId: 'b-test', prBase: 'main' });
    const failed = await d.helm.prOpen({ workerId: row.workerId, draft: true }); assert.equal(failed.ok, false); if (!failed.ok) assert.match(failed.reason, /acceptance check did not pass/);
    writeFileSync(join(fixture.repo, 'test', 'feature.test.ts'), 'assert.fail();\n// edited'); git(fixture.repo, ['add', '.']); git(fixture.repo, ['commit', '-qm', 'edit test']);
    d.store.insertGate({ gateId: 'g-pass', workerId: row.workerId, head: git(fixture.repo, ['rev-parse', 'HEAD']), passed: true, checks: [{ name: 'acceptance', command: 'validator', exitCode: 0, outputPath: '/tmp/a', durationMs: 1 }], at: new Date().toISOString() });
    const edited = await d.helm.prOpen({ workerId: row.workerId, draft: true }); assert.equal(edited.ok, false); if (!edited.ok) assert.match(edited.reason, /test\/feature\.test\.ts/);
  } finally { d.close(); }
});
