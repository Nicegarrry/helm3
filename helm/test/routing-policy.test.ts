import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelCatalog } from '../src/routing/catalog.js';
import { createRoutingCheck } from '../src/routing/check.js';
import { createRouter } from '../src/route.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { Jev } from '../src/jev.js';
import type { ModelChoice } from '../src/helm.js';

const baseSettings = loadSettings('/missing-routing-policy-settings');
const input = { repo: 'acme/repo', objective: 'task', role: 'builder' as const, contextPaths: [], allowWorkflows: false };
const jev: Jev = { shadow: true, async ask() { return { ok: true, answers: { complexity: { score: 0.2 }, too_big: { noul: false } } }; } };
const choose = async (route: ReturnType<typeof createRouter>, value = input): Promise<ModelChoice> => await route(value) as ModelChoice;

function settings(tiers: Record<string, string[]>, policy: { lanes?: ('codex' | 'pi' | 'claude')[]; subscriptionOnly?: boolean }) {
  return { ...baseSettings, routing: { ...baseSettings.routing, tiers, allowed: Object.values(tiers).flat(), policy } };
}

test('codex-only policy maps each Jev tier to its Codex candidate', async () => {
  const store = openStore(':memory:');
  try {
    const tiers = { '1': ['pi/flash', 'codex/gpt-6-luna:medium'], '2': ['pi/gemini', 'codex/gpt-6-luna:high'], '3': ['claude/sonnet:high', 'codex/gpt-5.6-terra:high'], '4': ['codex/gpt-6.1-sol:medium'], '5': ['codex/gpt-6-astra:high', 'codex/gpt-6.1-sol:high'] };
    for (const [tier, score] of [[1, 0.2], [2, 1], [3, 2], [4, 3], [5, 3.5]] as const) {
      const route = createRouter({ settings: settings(tiers, { lanes: ['codex'] }), store, jev: { shadow: true, async ask() { return { ok: true, answers: { complexity: { score }, too_big: { noul: false } } }; } }, catalog: createModelCatalog({ getSettings: () => baseSettings, probe: { codex: () => true } }) });
      const result = await choose(route, { ...input, objective: `tier ${tier}` });
      assert.equal(result.model, tiers[String(tier) as keyof typeof tiers]!.find((model: string) => model.startsWith('codex/')));
    }
  } finally { store.close(); }
});

test('subscriptionOnly excludes Pi candidates without changing Jev triage', async () => {
  const store = openStore(':memory:'); let calls = 0;
  try {
    const route = createRouter({ settings: settings({ '1': ['pi/paid', 'codex/gpt-6-luna:medium'] }, { subscriptionOnly: true }), store, jev: { shadow: true, async ask() { calls += 1; return { ok: true, answers: { complexity: { score: 0.2 }, too_big: { noul: false } } }; } }, isAvailable: () => true });
    const result = await choose(route);
    assert.equal(result.model, 'codex/gpt-6-luna:medium');
    assert.equal(calls, 1);
    assert.match(result.skippedCandidates?.[0]?.reason ?? '', /subscriptionOnly/);
  } finally { store.close(); }
});

test('catalog probes are cached and routing checks report stale entries', async () => {
  const store = openStore(':memory:'); let codexCalls = 0; let now = new Date('2026-09-30T00:00:00.000Z');
  const settingsValue = settings({ '1': ['codex/missing'], '2': ['codex/routed'] }, {});
  const catalog = createModelCatalog({ getSettings: () => settingsValue, probe: { codex: (id) => { codexCalls += 1; return id === 'routed'; }, models: (lane) => lane === 'codex' ? ['codex/routed', 'codex/gpt-6.2-new'] : [] } });
  try {
    assert.equal((await catalog.availability('codex/missing')).available, false);
    assert.equal((await catalog.availability('codex/missing')).available, false);
    assert.equal(codexCalls, 1);
    const routing = createRoutingCheck({ store, settings: settingsValue, catalog, now: () => now });
    const first = await routing.check();
    assert.equal(first.report.unavailable?.[0]?.model, 'codex/missing');
    assert.deepEqual(first.report.extraModels, [{ lane: 'codex', model: 'codex/gpt-6.2-new' }]);
    assert.equal(store.listEvents('project:routing')[0]?.kind, 'routing.stale');
    const before = store.listEvents('project:routing').length;
    await routing.tick();
    assert.equal(store.listEvents('project:routing').length, before);
    now = new Date(now.getTime() + 8 * 86_400_000);
    await routing.tick();
    assert.equal(store.listEvents('project:routing').length, before + 1);
  } finally { store.close(); }
});
