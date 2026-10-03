import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelCatalog, parseCodexModelSlugs } from '../src/routing/catalog.js';
import { createRoutingCheck } from '../src/routing/check.js';
import { createRouter } from '../src/route.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { Jev } from '../src/jev.js';
import type { ModelChoice, SpawnInput } from '../src/helm.js';

const baseSettings = loadSettings('/missing-routing-policy-settings');
const input: SpawnInput = { repo: 'acme/repo', objective: 'task', role: 'builder', contextPaths: [], allowWorkflows: false };
const jev: Jev = { shadow: true, async ask() { return { ok: true, answers: { complexity: { score: 0.2 }, too_big: { noul: false } } }; } };
const choose = async (route: ReturnType<typeof createRouter>, value = input): Promise<ModelChoice> => await route(value) as ModelChoice;
function testCatalog(available: (model: string) => boolean | Promise<boolean> = () => true): ReturnType<typeof createModelCatalog> {
  return createModelCatalog({
    claudeLaneRegistered: false,
    sources: { codexModels: () => [], piModels: () => [], claudeAvailable: () => false },
    probe: {
      codex: (id) => available(`codex/${id}`),
      pi: (provider, id) => available(`${provider}/${id}`),
      claude: () => false,
      models: () => [],
    },
  });
}

function settings(tiers: Record<string, string[]>, policy: { lanes?: ('codex' | 'pi' | 'claude')[]; subscriptionOnly?: boolean }) {
  return { ...baseSettings, routing: { ...baseSettings.routing, tiers, allowed: Object.values(tiers).flat(), policy } };
}

test('codex-only policy maps each Jev tier to its Codex candidate', async () => {
  const store = openStore(':memory:');
  try {
    const tiers = { '1': ['pi/flash', 'codex/gpt-6-luna:medium'], '2': ['pi/gemini', 'codex/gpt-6-luna:high'], '3': ['claude/sonnet:high', 'codex/gpt-5.6-terra:high'], '4': ['codex/gpt-6.1-sol:medium'], '5': ['codex/gpt-6-astra:high', 'codex/gpt-6.1-sol:high'] };
    for (const [tier, score] of [[1, 0.2], [2, 1], [3, 2], [4, 3], [5, 3.5]] as const) {
      const route = createRouter({ settings: settings(tiers, { lanes: ['codex'] }), store, jev: { shadow: true, async ask() { return { ok: true, answers: { complexity: { score }, too_big: { noul: false } } }; } }, catalog: testCatalog() });
      const result = await choose(route, { ...input, objective: `tier ${tier}` });
      assert.equal(result.model, tiers[String(tier) as keyof typeof tiers]!.find((model: string) => model.startsWith('codex/')));
    }
  } finally { store.close(); }
});

test('subscriptionOnly excludes Pi candidates without changing Jev triage', async () => {
  const store = openStore(':memory:'); let calls = 0;
  try {
    const route = createRouter({ settings: settings({ '1': ['pi/paid', 'codex/gpt-6-luna:medium'] }, { subscriptionOnly: true }), store, jev: { shadow: true, async ask() { calls += 1; return { ok: true, answers: { complexity: { score: 0.2 }, too_big: { noul: false } } }; } }, catalog: testCatalog() });
    const result = await choose(route);
    assert.equal(result.model, 'codex/gpt-6-luna:medium');
    assert.equal(calls, 1);
    assert.match(result.skippedCandidates?.[0]?.reason ?? '', /subscriptionOnly/);
  } finally { store.close(); }
});

test('per-spawn lanes can narrow but never widen the configured policy', async () => {
  const store = openStore(':memory:');
  try {
    const tiers = { '1': ['pi/flash', 'codex/luna'] };
    const catalog = testCatalog();
    const route = createRouter({ settings: settings(tiers, { lanes: ['codex'] }), store, jev, catalog });
    const narrowed = await choose(route, { ...input, lanes: ['codex', 'pi'] });
    assert.equal(narrowed.model, 'codex/luna');
    assert.deepEqual(narrowed.policyApplied, { lanes: ['codex'], subscriptionOnly: false });
    const widened = await choose(route, { ...input, lanes: ['pi'] });
    assert.equal(widened.model, undefined);
    assert.match(widened.refusal ?? '', /under lanes \[\]/);
  } finally { store.close(); }
});

test('Codex catalog parses debug models slugs', () => {
  assert.deepEqual(parseCodexModelSlugs({ models: [{ slug: 'gpt-6-astra' }, { slug: 'gpt-5.6-luna' }] }), ['gpt-6-astra', 'gpt-5.6-luna']);
});

test('catalog probes use the resolved Codex and Claude lane binaries', async () => {
  const calls: string[] = [];
  const catalog = createModelCatalog({
    claudeLaneRegistered: true,
    env: { HELM_CODEX_BIN: '/custom/codex', HELM_CLAUDE_BIN: '/custom/claude' },
    exec: async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return { stdout: file.endsWith('codex') ? JSON.stringify({ models: [{ slug: 'gpt-6-luna' }] }) : 'claude 1.0', stderr: '' };
    },
  });
  assert.equal((await catalog.availability('codex/gpt-6-luna:medium')).available, true);
  assert.equal((await catalog.availability('claude/sonnet:high')).available, true);
  assert.deepEqual(calls, ['/custom/codex debug models', '/custom/claude --version']);
});

test('catalog retries a failed refresh while preserving the last known result', async () => {
  let calls = 0;
  const catalog = createModelCatalog({ probe: { codex: () => { calls += 1; if (calls === 2) throw new Error('temporary'); return true; } }, sources: { codexModels: () => [], piModels: () => [], claudeAvailable: () => false } });
  assert.equal((await catalog.availability('codex/luna')).available, true);
  assert.equal((await catalog.availability('codex/luna')).available, true);
  assert.equal(calls, 1);
  await catalog.refresh?.({ ...baseSettings, routing: { ...baseSettings.routing, tiers: { '1': ['codex/luna'] } } });
  assert.equal((await catalog.availability('codex/luna')).available, true);
  assert.equal(calls, 3);
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
    assert.match(String(store.listEvents('project:routing')[0]?.data.summary), /^unavailable: codex\/missing/);
    const before = store.listEvents('project:routing').length;
    await routing.check();
    assert.equal(store.listEvents('project:routing').length, before);
    await routing.tick();
    assert.equal(store.listEvents('project:routing').length, before);
    now = new Date(now.getTime() + 8 * 86_400_000);
    await routing.tick();
    assert.equal(store.listEvents('project:routing').length, before + 1);
  } finally { store.close(); }
});

test('routing check skips lane models listed in routing.ignored', async () => {
  const store = openStore(':memory:');
  const base = settings({ '1': ['codex/routed'] }, {});
  const settingsValue = { ...base, routing: { ...base.routing, ignored: ['codex/gpt-6.2-new'] } };
  const catalog = createModelCatalog({ getSettings: () => settingsValue, probe: { codex: () => true, models: (lane) => lane === 'codex' ? ['codex/routed', 'codex/gpt-6.2-new'] : [] } });
  try {
    const result = await createRoutingCheck({ store, settings: settingsValue, catalog }).check();
    assert.equal(result.report.extraModels, undefined);
    assert.equal(store.listEvents('project:routing').length, 0);
  } finally { store.close(); }
});

test('concurrent startup routing ticks share one check and stale event', async () => {
  const store = openStore(':memory:');
  let checks = 0;
  const settingsValue = settings({ '1': ['codex/missing'] }, {});
  const catalog = {
    async availability() { return { available: false, reason: 'missing' }; },
    async check(_settings: typeof settingsValue, checkedAt = new Date()) {
      checks += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { checkedAt: checkedAt.toISOString(), unavailable: [{ tier: 1, model: 'codex/missing', reason: 'missing' }] };
    },
  };
  try {
    const routing = createRoutingCheck({ store, settings: settingsValue, catalog, now: () => new Date('2026-09-30T00:00:00.000Z') });
    await Promise.all([routing.tick(), routing.tick(), routing.tick(), routing.tick()]);
    assert.equal(checks, 1);
    assert.equal(store.listEvents('project:routing').length, 1);
  } finally { store.close(); }
});

test('startup suppression defers only the initial probe and preserves the weekly tick', async () => {
  const store = openStore(':memory:');
  let now = new Date('2026-09-30T00:00:00.000Z');
  let checks = 0;
  const settingsValue = settings({ '1': ['codex/routed'] }, {});
  const catalog = {
    async availability() { return { available: true }; },
    async check(_settings: typeof settingsValue, checkedAt = new Date()) {
      checks += 1;
      return { checkedAt: checkedAt.toISOString() };
    },
  };
  try {
    const routing = createRoutingCheck({ store, settings: settingsValue, catalog, now: () => now, skipStartup: true });
    await routing.tick();
    assert.equal(checks, 0);
    now = new Date(now.getTime() + 7 * 86_400_000);
    await routing.tick();
    assert.equal(checks, 1);
  } finally { store.close(); }
});
