import assert from 'node:assert/strict';
import test from 'node:test';
import { createEconomy, toCoreModelFact, type DispatchAuthority, type EconomySnapshot } from '../../src/economy/index.js';

const snapshot: EconomySnapshot = {
  pools: [
    { poolId: 'chatgpt', kind: 'subscription', unit: 'requests' },
    { poolId: 'api', kind: 'api', unit: 'usd' },
    { poolId: 'topup', kind: 'topup', unit: 'credits' },
  ],
  models: [
    { modelId: 'terra', provider: 'openai', family: 'openai', poolId: 'chatgpt', enabled: true, availability: 'known_available', roles: ['builder', 'reviewer'], buildCapabilities: ['typescript'], reviewCapabilities: ['security'], dataPolicy: 'restricted-ok', observedAt: '2026-09-15T00:00:00Z' },
    { modelId: 'luna', provider: 'openai', family: 'openai', poolId: 'chatgpt', enabled: false, availability: 'known_available', roles: ['builder'], buildCapabilities: ['typescript'], reviewCapabilities: [], dataPolicy: 'restricted-ok', observedAt: '2026-09-15T00:00:00Z' },
    { modelId: 'public-only', provider: 'example', family: 'example', poolId: 'api', enabled: true, availability: 'known_available', roles: ['reviewer'], buildCapabilities: [], reviewCapabilities: ['security'], dataPolicy: 'public-only', observedAt: '2026-09-15T00:00:00Z' },
  ],
  quota: [
    { poolId: 'chatgpt', state: 'unknown', observedAt: '2026-09-15T00:00:00Z', detail: 'provider does not expose remaining capacity' },
    { poolId: 'api', state: 'known', remaining: 25, resetAt: '2026-09-16T00:00:00Z', observedAt: '2026-09-15T00:00:00Z' },
  ],
};

function authority(): DispatchAuthority {
  return { assertReservation: () => undefined };
}

function refusalCode(result: ReturnType<ReturnType<typeof createEconomy>['eligible']>): string {
  assert.equal(result.eligible, false);
  return result.code;
}

test('keeps pools in native units and reports an absent quota observation as unknown', () => {
  const economy = createEconomy(snapshot, authority());
  assert.deepEqual(economy.snapshot().pools.map((pool) => [pool.poolId, pool.kind, pool.unit]), [['api', 'api', 'usd'], ['chatgpt', 'subscription', 'requests'], ['topup', 'topup', 'credits']]);
  assert.equal(economy.quota('topup').state, 'unknown');
  assert.equal(economy.quota('chatgpt').state, 'unknown');
});

test('refuses disabled, policy, role and capability-ineligible selections', () => {
  const economy = createEconomy(snapshot, authority());
  assert.equal(refusalCode(economy.eligible({ modelId: 'luna', role: 'builder', requiredCapabilities: ['typescript'], dataClassification: 'public' })), 'disabled_model');
  assert.equal(refusalCode(economy.eligible({ modelId: 'public-only', role: 'reviewer', requiredCapabilities: ['security'], dataClassification: 'restricted' })), 'data_policy');
  assert.equal(refusalCode(economy.eligible({ modelId: 'terra', role: 'consultant', requiredCapabilities: [], dataClassification: 'public' })), 'role');
  assert.equal(refusalCode(economy.eligible({ modelId: 'terra', role: 'builder', requiredCapabilities: ['ios'], dataClassification: 'public' })), 'capability');
  assert.equal(refusalCode(economy.eligible({ modelId: 'terra', role: 'reviewer', requiredCapabilities: ['typescript'], dataClassification: 'public' })), 'capability');
  const unknown = createEconomy({ ...snapshot, models: [...snapshot.models, { ...snapshot.models[0]!, modelId: 'unknown-capacity', availability: 'unknown' }] }, authority());
  assert.equal(refusalCode(unknown.eligible({ modelId: 'unknown-capacity', role: 'builder', requiredCapabilities: ['typescript'], dataClassification: 'public' })), 'availability_unknown');
});

test('projects registry facts into the Core admission contract without adding a ledger', () => {
  assert.deepEqual(toCoreModelFact(snapshot.models[0]!, 3), {
    modelId: 'terra', provider: 'openai', poolId: 'chatgpt', enabled: true,
    capabilities: ['security', 'typescript'], roles: ['builder', 'reviewer'], capabilitiesByRole: { builder: ['typescript'], reviewer: ['security'] }, dataPolicy: 'restricted-ok', availability: 'known_available', factVersion: 3, observedAt: '2026-09-15T00:00:00Z',
  });
});

test('retains a deep immutable registry snapshot and rejects malformed observations', () => {
  const economy = createEconomy(snapshot, authority());
  const view = economy.snapshot();
  assert.throws(() => (view.models[0]!.buildCapabilities as string[]).push('forged'), /read only|object is not extensible/i);
  assert.equal(refusalCode(economy.eligible({ modelId: 'terra', role: 'builder', requiredCapabilities: ['forged'], dataClassification: 'public' })), 'capability');
  assert.throws(() => createEconomy({ ...snapshot, quota: [{ poolId: 'chatgpt', state: 'unknown', remaining: 5, observedAt: '2026-09-15T00:00:00Z', detail: 'bad' }] as unknown as EconomySnapshot['quota'] }, authority()), /remaining/);
  assert.throws(() => createEconomy({ ...snapshot, pools: [{ poolId: 'chatgpt', kind: 'subscription', unit: '' }] as unknown as EconomySnapshot['pools'] }, authority()), /at least 1/);
  assert.throws(() => createEconomy({ ...snapshot, quota: [{ poolId: 'chatgpt', state: 'unknown', observedAt: '2026-09-16T00:00:00Z', detail: 'future' }] }, authority(), { now: () => '2026-09-15T00:00:00Z' }), /future/);
  assert.deepEqual(economy.quota('topup'), { poolId: 'topup', state: 'unknown', detail: 'no provider observation' });
});

test('passes a legal selection to the authoritative reservation seam without recreating a ledger', () => {
  const calls: unknown[] = [];
  const economy = createEconomy(snapshot, { assertReservation(request) { calls.push(request); } });
  const result = economy.eligible({ modelId: 'terra', role: 'builder', requiredCapabilities: ['typescript'], dataClassification: 'restricted', resource: { poolId: 'chatgpt', unit: 'requests', upperBound: 3, consumer: 'worker' } });
  assert.deepEqual(result, { eligible: true });
  assert.deepEqual(calls, [{ poolId: 'chatgpt', unit: 'requests', upperBound: 3, consumer: 'worker' }]);
});

test('does not let an orchestrator self-override a protected reserve', () => {
  let called = false;
  const economy = createEconomy(snapshot, { assertReservation() { called = true; } });
  const result = economy.eligible({ modelId: 'terra', role: 'builder', requiredCapabilities: ['typescript'], dataClassification: 'public', resource: { poolId: 'chatgpt', unit: 'requests', upperBound: 3, consumer: 'worker', humanOverrideId: 'forged-by-orchestrator' } });
  assert.deepEqual(result, { eligible: false, code: 'unattested_human_override', detail: 'reserve override must be attested by the privileged host' });
  assert.equal(called, false);
});


test('free is a cost class and grants neither quota certainty nor a capability', () => {
  const economy = createEconomy({ pools: [{ poolId: 'free', kind: 'free', unit: 'usd' }], models: [{ ...snapshot.models[2]!, poolId: 'free', reviewCapabilities: [] }], quota: [] }, authority());
  assert.equal(economy.snapshot().pools[0]!.kind, 'free');
  assert.equal(economy.quota('free').state, 'unknown');
  assert.equal(refusalCode(economy.eligible({ modelId: 'public-only', role: 'reviewer', requiredCapabilities: ['security'], dataClassification: 'public' })), 'capability');
  assert.equal(refusalCode(economy.eligible({ modelId: 'public-only', role: 'reviewer', requiredCapabilities: [], dataClassification: 'restricted' })), 'data_policy');
});
