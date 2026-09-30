import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJevCheck } from '../src/jevcheck.js';
import { createRouter } from '../src/route.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { Jev, JevAnswers } from '../src/jev.js';
import type { SpawnInput, ModelChoice } from '../src/helm.js';
import type { WorkerRow } from '../src/types.js';

const HIGH = 'codex/gpt-6-luna:high';
const now = () => new Date('2026-09-30T00:00:00.000Z');
function input(repo = 'acme/repo'): SpawnInput { return { repo, objective: 'task', role: 'builder', contextPaths: [], allowWorkflows: false }; }
function answers(score: number, noul: boolean | number = false): JevAnswers { return { complexity: { score }, too_big: { noul } }; }
function settings(tiers: Record<string, string[]>, allowed = Object.values(tiers).flat(), minN = 8) {
  return { ...loadSettings('/missing-route-settings'), routing: { tiers, allowed, minClean: 0.5, minN } };
}
function worker(id: string, model: string, state: WorkerRow['state'] = 'failed'): WorkerRow {
  return { workerId: id, repo: '/repo', repoSlug: 'acme/repo', role: 'builder', model, objective: id, acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'a'.repeat(40), branch: id, worktree: `/repo/${id}`, state, head: 'b'.repeat(40), sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: now().toISOString(), updatedAt: now().toISOString() };
}
async function choose(route: ReturnType<typeof createRouter>, value = input()): Promise<ModelChoice> { return await route(value) as ModelChoice; }

test('each Jev tier selects its first available candidate', async () => {
  const tiers = { '1': ['codex/tier-1'], '2': ['codex/tier-2'], '3': ['codex/tier-3'], '4': ['codex/tier-4'], '5': ['codex/tier-5'] };
  const scores = [0.2, 1, 2, 3, 3.5];
  const store = openStore(':memory:');
  try {
    for (const [index, score] of scores.entries()) {
      const jev: Jev = { shadow: true, async ask() { return { ok: true, answers: answers(score) }; } };
      const result = await choose(createRouter({ settings: settings(tiers), store, jev, now, isAvailable: () => true }));
    assert.deepEqual(result, { model: `codex/tier-${index + 1}`, tier: index + 1, score, policyApplied: { lanes: ['codex', 'pi', 'claude'], subscriptionOnly: false } });
    }
  } finally { store.close(); }
});

test('claude candidates are skipped as unavailable with a reason', async () => {
  const store = openStore(':memory:');
  try {
    const result = await choose(createRouter({ settings: settings({ '1': ['claude/sonnet:high'], '2': ['codex/fallback'] }), store, jev: { shadow: true, async ask() { return { ok: true, answers: answers(0.2) }; } }, now, isAvailable: () => true }));
    assert.equal(result.model, 'codex/fallback');
    assert.deepEqual(result.skippedCandidates, [{ model: 'claude/sonnet:high', reason: 'unavailable: no worker lane for claude', tier: 1 }]);
  } finally { store.close(); }
});

test('a tier without an available candidate escalates to the next tier', async () => {
  const store = openStore(':memory:');
  try {
    const result = await choose(createRouter({ settings: settings({ '1': ['pi/missing'], '2': ['codex/next'] }), store, jev: { shadow: true, async ask() { return { ok: true, answers: answers(0.2) }; } }, now, isAvailable: (model) => model === 'codex/next' }));
    assert.equal(result.model, 'codex/next');
    assert.deepEqual(result.skippedCandidates, [{ model: 'pi/missing', reason: 'unavailable: model is unavailable', tier: 1 }]);
  } finally { store.close(); }
});

test('scorecard step-up skips a poor candidate', async () => {
  const store = openStore(':memory:');
  try {
    for (const index of [1, 2]) {
      const row = worker(`poor-${index}`, 'codex/poor');
      store.insertWorker(row); store.setMeta(row.workerId, { issue: index, tier: 1, score: 0.2, chosenModel: row.model });
    }
    const result = await choose(createRouter({ settings: settings({ '1': ['codex/poor', 'codex/good'] }, ['codex/poor', 'codex/good'], 2), store, jev: { shadow: true, async ask() { return { ok: true, answers: answers(0.2) }; } }, now, isAvailable: () => true }));
    assert.equal(result.model, 'codex/good');
    assert.match(result.skippedCandidates?.[0]?.reason ?? '', /clean rate below minClean/);
  } finally { store.close(); }
});

function seedRoutingRow(store: ReturnType<typeof openStore>, id: string, model: string, tier: number, overrides: Partial<WorkerRow> = {}) {
  const row = worker(id, model, 'failed');
  store.insertWorker({ ...row, ...overrides });
  store.setMeta(id, { issue: Number(id.replace(/\D/g, '')) || 1, tier, chosenModel: model });
}

test('step-up evidence is isolated by tier, model, role, age, and project', async () => {
  const store = openStore(':memory:');
  try {
    const settingsValue = settings({ '1': ['codex/poor', 'codex/good'], '2': ['codex/next'] }, ['codex/poor', 'codex/good', 'codex/next'], 2);
    seedRoutingRow(store, 'tier-1', 'codex/poor', 2);
    seedRoutingRow(store, 'model-2', 'codex/other', 1);
    seedRoutingRow(store, 'review-3', 'codex/poor', 1, { role: 'reviewer' });
    seedRoutingRow(store, 'old-4', 'codex/poor', 1, { createdAt: '2026-08-01T00:00:00.000Z' });
    seedRoutingRow(store, 'repo-5', 'codex/poor', 1, { repoSlug: 'other/repo' });
    const result = await choose(createRouter({ settings: settingsValue, store, jev: { shadow: true, async ask() { return { ok: true, answers: answers(0.2) }; } }, now, isAvailable: () => true }));
    assert.equal(result.model, 'codex/poor');
  } finally { store.close(); }
});

test('step-up fires only with enough recent matching builder rows', async () => {
  const store = openStore(':memory:');
  try {
    for (const id of ['match-1', 'match-2']) seedRoutingRow(store, id, 'codex/poor', 1);
    const result = await choose(createRouter({ settings: settings({ '1': ['codex/poor', 'codex/good'] }, ['codex/poor', 'codex/good'], 2), store, jev: { shadow: true, async ask() { return { ok: true, answers: answers(0.2) }; } }, now, isAvailable: () => true }));
    assert.equal(result.model, 'codex/good');
    assert.match(result.skippedCandidates?.[0]?.reason ?? '', /clean rate below minClean/);
  } finally { store.close(); }
});

test('routing hot-reloads a changed tier table', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-route-settings-')); const store = openStore(':memory:');
  const jev: Jev = { shadow: true, async ask() { return { ok: true, answers: answers(0.2) }; } };
  try {
    writeFileSync(join(home, 'helm.json'), JSON.stringify({ routing: { tiers: { '1': ['codex/one'] } } }));
    const route = createRouter({ settings: loadSettings('/missing-route-settings'), settingsHome: home, store, jev, now, isAvailable: () => true });
    assert.equal((await choose(route)).model, 'codex/one');
    writeFileSync(join(home, 'helm.json'), JSON.stringify({ routing: { tiers: { '1': ['codex/two'] } } }));
    assert.equal((await choose(route)).model, 'codex/two');
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('issue preset reports the five-tier label and score', async () => {
  const store = openStore(':memory:');
  try {
    const jev: Jev = { shadow: true, async ask() { return { ok: true, answers: { testable: { noul: true }, too_big: { noul: false }, complexity: { probabilities: { '0': 0, '1': 0, '2': 0.3, '3': 0.2, '4': 0.5 } } } }; } };
    const result = await createJevCheck({ jev, store }).check({ preset: 'issue', input: 'ticket' });
    assert.deepEqual(result.ok && result.complexity, { score: 3.2, tier: 5, label: 'challenging' });
  } finally { store.close(); }
});

test('explicit model skips Jev', async () => {
  const store = openStore(':memory:'); let calls = 0;
  try {
    const result = await choose(createRouter({ settings: loadSettings('/missing-route-settings'), store, jev: { shadow: true, async ask() { calls += 1; return { ok: true, answers: answers(0) }; } } }), { ...input(), model: 'custom/model' });
    assert.deepEqual(result, { model: 'custom/model' }); assert.equal(calls, 0);
  } finally { store.close(); }
});

test('difficulty maps to a tier through policy and availability selection', async () => {
  const store = openStore(':memory:');
  try {
    let calls = 0;
    const route = createRouter({ settings: settings({ '1': ['codex/one'], '2': ['codex/two'], '3': ['claude/sonnet:high', 'codex/three'] }, ['codex/one', 'codex/two', 'claude/sonnet:high', 'codex/three']), store, jev: { shadow: true, async ask() { calls += 1; return { ok: true, answers: answers(4) }; } }, now, isAvailable: () => true });
    const result = await choose(route, { ...input(), difficulty: 'easy' });
    assert.equal(result.model, 'codex/two');
    assert.equal(result.tier, 2);
    assert.equal(calls, 0);
  } finally { store.close(); }
});

test('Jev failure uses tier 3 selection and applies policy', async () => {
  const store = openStore(':memory:');
  try {
    const route = createRouter({ settings: { ...loadSettings('/missing-route-settings'), routing: { ...loadSettings('/missing-route-settings').routing, tiers: { '3': ['pi/paid', 'codex/terra'] }, allowed: ['pi/paid', 'codex/terra'], policy: { lanes: ['codex'], subscriptionOnly: false } } }, store, jev: { shadow: true, async ask() { throw new Error('timeout'); } }, now, isAvailable: () => true });
    const result = await choose(route);
    assert.equal(result.model, 'codex/terra');
    assert.equal(result.tier, 3);
    assert.match(result.warning ?? '', /tier 3 fallback/);
    assert.match(result.skippedCandidates?.[0]?.reason ?? '', /lane 'pi'/);
  } finally { store.close(); }
});

test('no-key Jev result uses the same tier 3 policy fallback', async () => {
  const store = openStore(':memory:');
  try {
    const defaults = loadSettings('/missing-route-settings');
    const settingsValue = { ...defaults, routing: { ...defaults.routing, tiers: { '3': ['codex/terra'] }, allowed: ['codex/terra'], policy: { lanes: ['codex'] as ('codex' | 'pi' | 'claude')[], subscriptionOnly: false } } };
    const result = await choose(createRouter({ settings: settingsValue, store, jev: { shadow: true, async ask() { return { ok: false, reason: 'no key' }; } }, now, isAvailable: () => true }));
    assert.deepEqual(result, { model: 'codex/terra', tier: 3, policyApplied: { lanes: ['codex'], subscriptionOnly: false }, warning: 'Jev routing failed; used tier 3 fallback' });
  } finally { store.close(); }
});
