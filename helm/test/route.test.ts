import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Helm, type ModelChoice, type PromptInput, type SpawnInput } from '../src/helm.js';
import { createRouter } from '../src/route.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { Jev, JevAnswers } from '../src/jev.js';
import type { GateRunner, GitHub, HelmConfig, PrStatus, WorkerRunner, Workspace, WorkerRow } from '../src/types.js';

const MEDIUM = 'codex/gpt-5.6-luna:medium';
const HIGH = 'codex/gpt-5.6-luna:high';

function answers(score: number, noul: boolean | number = false): JevAnswers {
  return { complexity: { score }, too_big: { noul } };
}

function input(repo: string, objective: string): SpawnInput {
  return { repo, objective, role: 'builder', contextPaths: [], allowWorkflows: false };
}

async function choose(route: ReturnType<typeof createRouter>, value: SpawnInput): Promise<ModelChoice> {
  const result = await route(value);
  assert.equal(typeof result, 'object');
  return result as ModelChoice;
}

function worker(id: string, model = MEDIUM, state: WorkerRow['state'] = 'succeeded'): WorkerRow {
  const now = '2026-09-30T00:00:00.000Z';
  return { workerId: id, repo: '/repo', repoSlug: 'acme/repo', role: 'builder', model, objective: id, acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'a'.repeat(40), branch: id, worktree: `/repo/${id}`, state, head: 'b'.repeat(40), sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: now, updatedAt: now };
}

function routeFixture(reply: JevAnswers, routing = loadSettings('/missing-route-settings').routing) {
  const store = openStore(':memory:'); const calls: string[] = [];
  const jev: Jev = { shadow: true, async ask(purpose) { calls.push(purpose); return { ok: true, answers: reply }; } };
  const settings = { ...loadSettings('/missing-route-settings'), routing };
  return { store, calls, route: createRouter({ settings, store, jev, now: () => new Date('2026-09-30T00:00:00.000Z') }) };
}

test('large score routes high and records one shared Jev question set', async () => {
  const fixture = routeFixture(answers(2.4));
  try {
    const result = await choose(fixture.route, input('acme/repo', 'large task'));
    assert.deepEqual(result, { model: HIGH, band: 'large', complexity: 2.4 });
    assert.deepEqual(fixture.calls, ['route']);
  } finally { fixture.store.close(); }
});

test('score probabilities use the indexed 0 through 3 shape', async () => {
  const fixture = routeFixture({ complexity: { probabilities: { '0': 0, '1': 0, '2': 0.6, '3': 0.4 } }, too_big: { probabilities: { true: 0.6, false: 0.4 } } });
  try { assert.deepEqual(await choose(fixture.route, input('acme/repo', 'large task')), { model: HIGH, band: 'large', complexity: 2.4, warning: 'split recommended' }); } finally { fixture.store.close(); }
});

test('Jev failures fall back to high without throwing', async () => {
  const store = openStore(':memory:'); const settings = loadSettings('/missing-route-settings');
  try {
    const failingJeves: Jev[] = [{ shadow: true, async ask() { throw new Error('timeout'); } }, { shadow: true, async ask() { return Promise.reject(new Error('timeout')); } }];
    for (const jev of failingJeves) {
      assert.deepEqual(await choose(createRouter({ settings, store, jev }), input('acme/repo', 'task')), { model: HIGH });
    }
  } finally { store.close(); }
});

test('a low medium-band clean rate steps up to high', async () => {
  const fixture = routeFixture(answers(1.7));
  try {
    for (let index = 0; index < 4; index += 1) { const row = worker(`clean-${index}`); fixture.store.insertWorker(row); fixture.store.setMeta(row.workerId, { issue: index + 1, band: 'medium' }); }
    for (let index = 4; index < 9; index += 1) { const row = worker(`failed-${index}`, MEDIUM, 'failed'); fixture.store.insertWorker(row); fixture.store.setMeta(row.workerId, { issue: index + 1, band: 'medium' }); }
    const result = await choose(fixture.route, input('acme/repo', 'medium task'));
    assert.equal(result.model, HIGH);
  } finally { fixture.store.close(); }
});

test('a configured model outside allowed is clamped to high', async () => {
  const defaults = loadSettings('/missing-route-settings');
  const fixture = routeFixture(answers(1.7), { ...defaults.routing, table: { ...defaults.routing.table, medium: 'other/model' } });
  try { assert.equal((await choose(fixture.route, input('acme/repo', 'medium task'))).model, HIGH); } finally { fixture.store.close(); }
});

test('routing clamps to the strongest configured allowed model', async () => {
  const defaults = loadSettings('/missing-route-settings');
  const fixture = routeFixture(answers(1.7), { ...defaults.routing, allowed: [MEDIUM], table: { ...defaults.routing.table, medium: 'other/model' } });
  try { assert.equal((await choose(fixture.route, input('acme/repo', 'medium task'))).model, MEDIUM); } finally { fixture.store.close(); }
});

test('no Jev key and too_big are safe fallback and warning cases', async () => {
  const store = openStore(':memory:');
  try {
    const noKey: Jev = { shadow: true, async ask() { return { ok: false, reason: 'no key' }; } };
    const settings = loadSettings('/missing-route-settings');
    assert.deepEqual(await choose(createRouter({ settings, store, jev: noKey }), input('acme/repo', 'task')), { model: HIGH });
    const warning = routeFixture(answers(1.7, 0.5));
    try { assert.equal((await choose(warning.route, input('acme/repo', 'task'))).warning, 'split recommended'); } finally { warning.store.close(); }
  } finally { store.close(); }
});

function helmFixture(reply: JevAnswers) {
  const home = mkdtempSync(join(tmpdir(), 'helm-route-home-')); const repo = mkdtempSync(join(tmpdir(), 'helm-route-repo-')); const store = openStore(':memory:');
  const calls: string[] = []; const jev: Jev = { shadow: true, async ask(purpose) { calls.push(purpose); return { ok: true, answers: reply }; } };
  const workspace: Workspace = { async resolveSha(_repo, ref) { return ref; }, async defaultBranch() { return 'main'; }, async create(_repo, path, branch, baseSha) { return { path, branch, baseSha }; }, async remove() {}, async head() { return 'a'.repeat(40); }, async isClean() { return true; }, async diffStat() { return ''; }, async patchId() { return 'patch'; }, async commitAll() { return 'commit'; }, async push() {}, async clone() {}, async fetch() {} };
  const gates: GateRunner = { async run() { return { passed: true, checks: [] }; }, async defaultChecks() { return []; } };
  const github: GitHub = { async openPr() { return { number: 1, url: 'https://example.invalid/1' }; }, async prStatus(_repo, number): Promise<PrStatus> { return { number, state: 'open', head: 'a'.repeat(40), mergeable: true, draft: false, checks: [], reviews: [], url: 'https://example.invalid/1' }; }, async comment() { return { body: '' }; }, async postComment() {}, async merge() {} };
  const runner: WorkerRunner = { async run() { return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null }; } };
  const config: HelmConfig = { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 5000 };
  const helm = new Helm({ config, store, workspace, gates, github, runner, jev, settings: loadSettings(home), prompts: { builder: (_input: PromptInput) => 'build', reviewer: () => 'review', validator: () => 'validate' } });
  return { helm, repo, store, home, calls };
}

test('route warning and worker metadata reach spawn, while explicit classification skips Jev', async () => {
  const fixture = helmFixture(answers(1.7, true));
  try {
    const warning = await fixture.helm.spawn({ repo: fixture.repo, objective: 'task', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(warning.ok, true); if (!warning.ok) return;
    assert.match(warning.warning ?? '', /split recommended/);
    assert.deepEqual(fixture.store.getMeta(warning.workerId), { workerId: warning.workerId, issue: null, prBase: null, baselineId: null, band: 'medium', complexity: 1.7, skills: [] });
    await fixture.helm.settle(warning.workerId);
    const explicit = await fixture.helm.spawn({ repo: fixture.repo, objective: 'explicit', model: 'other/model', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(explicit.ok, true); if (explicit.ok) await fixture.helm.settle(explicit.workerId);
    const difficulty = await fixture.helm.spawn({ repo: fixture.repo, objective: 'difficulty', difficulty: 'easy', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(difficulty.ok, true);
    assert.deepEqual(fixture.calls, ['route']);
  } finally { fixture.store.close(); rmSync(fixture.home, { recursive: true, force: true }); rmSync(fixture.repo, { recursive: true, force: true }); }
});
