import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerContextPacket, observePiContext } from '../../src/context/index.js';

const ref = (name: string) => ({ ref: name, version: 'v1', digest: 'sha256:fixture' });
test('context packet is selected explicitly, immutable, and refuses oversize instead of truncating', () => {
  const value = createWorkerContextPacket({ objective: ref('objective'), acceptance: ref('acceptance'), brief: [ref('brief')], map: [], decisions: [], handoffs: [] });
  assert.equal(value.brief.length, 1); assert.ok(value.digest.startsWith('sha256:'));
  assert.throws(() => createWorkerContextPacket({ objective: ref('objective'), acceptance: ref('acceptance'), brief: [ref('brief')], map: [], decisions: [], handoffs: [] }, 1), /exceeds/);
});
test('Pi context observation distinguishes known occupancy from unavailable usage', () => {
  assert.deepEqual(observePiContext({ getContextUsage: () => ({ tokens: 12, contextWindow: 100, cachedTokens: 4 }) }), { state: 'known', tokens: 12, window: 100, cachedTokens: 4, source: 'pi.session.getContextUsage' });
  assert.equal(observePiContext({}).state, 'unknown');
});
