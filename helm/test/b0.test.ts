import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Helm } from '../src/helm.js';
import { projectOf } from '../src/supervise.js';
import { loadRepoConfig } from '../src/repoconfig.js';
import { openStore } from '../src/store.js';
import { loadSettings } from '../src/settings.js';
import type { GateRunner, GitHub, HelmConfig, PrStatus, WorkerHooks, WorkerRow, WorkerRunner, Workspace } from '../src/types.js';

function deps() {
  const home = mkdtempSync(join(tmpdir(), 'helm-b0-home-'));
  const store = openStore(':memory:');
  const config: HelmConfig = { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 5000 };
  const workspace: Workspace = {
    async resolveSha(_repo, ref) { return ref; }, async defaultBranch() { return 'main'; },
    async create(_repo, path, branch, baseSha) { return { path, branch, baseSha }; }, async remove() {},
    async head() { return 'a'.repeat(40); }, async isClean() { return true; }, async diffStat() { return ''; }, async patchId() { return 'patch'; },
    async commitAll(_path, message) { return message; }, async push() {}, async clone() {}, async fetch() {},
  };
  const gates: GateRunner = { async run() { return { passed: true, checks: [] }; }, async defaultChecks() { return []; } };
  const github: GitHub = {
    async openPr() { return { number: 1, url: 'https://example.invalid/1' }; },
    async prStatus(_repo, number): Promise<PrStatus> { return { number, state: 'open', head: 'a'.repeat(40), mergeable: true, draft: false, checks: [], reviews: [], url: 'https://example.invalid/1' }; },
    async comment() { return { body: '', issueNumber: 1 }; }, async postComment() {}, async merge() {},
  };
  const runner: WorkerRunner = { async run(_input, _message, _hooks) { return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null }; } };
  const helm = new Helm({ config, store, workspace, gates, github, runner, prompts: { builder: () => 'build', reviewer: () => 'review', validator: () => 'validate' }, settings: loadSettings(home) });
  return { helm, store, home };
}

function worker(workerId: string, repo: string): WorkerRow {
  const now = new Date().toISOString();
  return { workerId, repo, repoSlug: 'owner/repo', role: 'builder', model: 'codex/gpt-5.6-luna:high', objective: 'test', acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'a'.repeat(40), branch: 'helm/test', worktree: repo, state: 'succeeded', head: 'a'.repeat(40), sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: now, updatedAt: now };
}

test('registered guard refuses pr.merge with its reason', async () => {
  const d = deps();
  try {
    d.store.insertWorker(worker('w-guard', d.home));
    d.store.insertPr({ number: 1, workerId: 'w-guard', url: 'https://example.invalid/1', head: 'a'.repeat(40), createdAt: new Date().toISOString() });
    d.helm.guard('pr.merge', () => 'merge paused');
    assert.deepEqual(await d.helm.prMerge({ number: 1, expectedHead: 'a'.repeat(40) }), { ok: false, reason: 'merge paused' });
  } finally { d.store.close(); rmSync(d.home, { recursive: true, force: true }); }
});

test('spawn defaults to the Codex normal model before any chooser is registered', async () => {
  const d = deps();
  const repo = mkdtempSync(join(tmpdir(), 'helm-b0-repo-'));
  try {
    const result = await d.helm.spawn({ repo, objective: 'test', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(result.ok, true);
    if (result.ok) {
      await d.helm.settle(result.workerId);
      assert.equal(d.store.getWorker(result.workerId)?.model, 'codex/gpt-5.6-luna:high');
    }
  } finally { d.store.close(); rmSync(d.home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test('a model chooser runs only for an unclassified spawn', async () => {
  const d = deps();
  const repo = mkdtempSync(join(tmpdir(), 'helm-b0-chooser-'));
  let calls = 0;
  try {
    d.helm.chooseModel(() => { calls += 1; return 'codex/gpt-5.6-luna:medium'; });
    const explicit = await d.helm.spawn({ repo, objective: 'explicit', role: 'builder', model: 'acme/model', contextPaths: [], allowWorkflows: false });
    assert.equal(explicit.ok, true);
    if (explicit.ok) await d.helm.settle(explicit.workerId);
    assert.equal(calls, 0);
    const classified = await d.helm.spawn({ repo, objective: 'classified', role: 'builder', difficulty: 'easy', contextPaths: [], allowWorkflows: false });
    assert.equal(classified.ok, true);
    if (classified.ok) await d.helm.settle(classified.workerId);
    assert.equal(calls, 0);
    const unclassified = await d.helm.spawn({ repo, objective: 'unclassified', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(unclassified.ok, true);
    if (unclassified.ok) {
      assert.equal(d.store.getWorker(unclassified.workerId)?.model, 'codex/gpt-5.6-luna:medium');
      await d.helm.settle(unclassified.workerId);
    }
    assert.equal(calls, 1);
  } finally { d.store.close(); rmSync(d.home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test('review.request without a model names review.record', async () => {
  const d = deps();
  try { assert.deepEqual(await d.helm.reviewRequest({ workerId: 'w-missing', allowSameFamily: false }), { ok: false, reason: 'record Claude reviews with review.record' }); }
  finally { d.store.close(); rmSync(d.home, { recursive: true, force: true }); }
});

test('loadRepoConfig at a sha ignores uncommitted worktree edits', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'helm-b0-config-'));
  try {
    const git = (args: string[], encoding?: BufferEncoding) => execFileSync('git', ['--git-dir', join(repo, '.git'), '--work-tree', repo, ...args], { encoding });
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [{ name: 'old', command: 'echo old' }] }));
    git(['add', 'helm.json']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'config']);
    const sha = String(git(['rev-parse', 'HEAD'], 'utf8')).trim();
    writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [{ name: 'new', command: 'echo new' }] }));
    const config = await loadRepoConfig(repo, sha);
    assert.equal(config.gates[0]?.name, 'old');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('worker_meta round-trips and projectOf maps project worker ids', () => {
  const store = openStore(':memory:');
  try {
    store.setMeta('w-meta', { issue: 177, prBase: 'main', baselineId: 'b1', band: 'medium', complexity: 1.25, skills: ['testing'] });
    assert.deepEqual(store.getMeta('w-meta'), { workerId: 'w-meta', issue: 177, prBase: 'main', baselineId: 'b1', band: 'medium', complexity: 1.25, skills: ['testing'] });
    assert.equal(projectOf({ workerId: 'project:owner/name' }), 'owner/name');
  } finally { store.close(); }
});
