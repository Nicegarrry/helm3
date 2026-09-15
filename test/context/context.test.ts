import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerContextPacket, observePiContext } from '../../src/context/index.js';

const ref = (name: string) => ({ ref: name, version: 'v1', digest: 'sha256:fixture' });
test('context packet is selected explicitly, immutable, and refuses oversize instead of truncating', () => {
  const host = { maxBytes: 1024 } as const;
  const value = createWorkerContextPacket({ objective: ref('objective'), acceptance: ref('acceptance'), brief: [ref('brief')], map: [], decisions: [], handoffs: [] }, host);
  assert.equal(value.brief.length, 1); assert.ok(value.digest.startsWith('sha256:'));
  assert.throws(() => createWorkerContextPacket({ objective: ref('objective'), acceptance: ref('acceptance'), brief: [ref('brief')], map: [], decisions: [], handoffs: [] }, { maxBytes: 1 }), /exceeds/);
  assert.throws(() => createWorkerContextPacket({ objective: ref('objective'), acceptance: ref('acceptance'), brief: [], map: [], decisions: [], handoffs: [], maxBytes: Number.MAX_SAFE_INTEGER } as never, host), /Unrecognized key/);
  assert.throws(() => createWorkerContextPacket({ objective: ref('objective'), acceptance: ref('acceptance'), brief: [], map: [], decisions: [], handoffs: [] }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }), /Number must be less than or equal/);
});
test('Pi context observation uses only actual estimated ContextUsage fields', () => {
  assert.deepEqual(observePiContext({ getContextUsage: () => ({ tokens: 12, contextWindow: 100, percent: 12 }) }), { state: 'known', tokens: 12, window: 100, percent: 12, estimate: true, source: 'pi.session.getContextUsage' });
  assert.equal(observePiContext({ getContextUsage: () => ({ tokens: null, contextWindow: 100, percent: null }), getSessionStats: () => ({ tokens: 999_999 }) } as never).state, 'unknown', 'post-compaction null stays unknown despite tempting cumulative statistics');
  assert.equal(observePiContext({ getContextUsage: () => undefined }).state, 'unknown');
  assert.equal(observePiContext({} as never).state, 'unknown', 'a session without the SDK getter is unknown');
});
