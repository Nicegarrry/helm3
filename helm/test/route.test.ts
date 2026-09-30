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

const HIGH = 'codex/gpt-5.6-luna:high';
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
      assert.deepEqual(result, { model: `codex/tier-${index + 1}`, tier: index + 1, score });
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
