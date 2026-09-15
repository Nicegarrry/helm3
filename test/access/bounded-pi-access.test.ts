import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedPiAccess } from '../../src/access/index.js';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };

const model = { id: 'kimi-k2.7-code', provider: 'opencode-go', contextWindow: 262144 } as Model<Api>;
const message = (total: number): AssistantMessage => ({
  role: 'assistant', content: [], api: 'openai-completions', provider: 'opencode-go', model: 'kimi-k2.7-code', stopReason: 'stop', timestamp: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total } },
});

function access() {
  return new BoundedPiAccess({ poolId: 'overnight-api-usd', inputUsdPerMillion: 0.95, outputUsdPerMillion: 4,
    maxInputTokens: 1000, maxOutputTokens: 100, maxContextTokens: 2000, maxToolCalls: 1, timeoutMs: 1000 });
}

test('declares a conservative byte input cap, fixes output/retries, and settles observed usage', () => {
  const gate = access();
  const prepared = gate.prepare('effect-1', model, { systemPrompt: 'do work', messages: [], tools: [{ name: 'helm_write', parameters: { type: 'object' } }] }, { maxRetries: 9, maxTokens: 999 });
  assert.equal(prepared.options.maxRetries, 0);
  assert.equal(prepared.options.maxTokens, 100);
  assert.equal(prepared.reservation.poolId, 'overnight-api-usd');
  assert.equal(prepared.reservation.unit, 'usd');
  assert.ok(prepared.reservation.upperBound > 0);
  gate.settle('effect-1', message(prepared.reservation.upperBound / 2));
  assert.deepEqual(gate.settlement('effect-1'), { state: 'known', amount: prepared.reservation.upperBound / 2 });
});

test('refuses oversized input/context and retains a reservation when final usage is unknown', () => {
  const gate = access();
  assert.throws(() => gate.prepare('too-large', model, { systemPrompt: 'x'.repeat(1001), messages: [] }, undefined), /input cap/);
  const prepared = gate.prepare('effect-2', model, { systemPrompt: 'small', messages: [] }, undefined);
  gate.unknown('effect-2', 'timeout');
  assert.deepEqual(gate.settlement('effect-2'), { state: 'unknown', reason: 'timeout' });
  assert.throws(() => gate.prepare('effect-3', { ...model, contextWindow: 110 } as Model<Api>, { systemPrompt: 'small', messages: [] }, undefined), /context cap/);
  assert.equal(prepared.reservation.outputTokens, 100);
});

test('limits tool effects and does not enable repair follow-ups by default', () => {
  const gate = access();
  gate.noteToolCall();
  assert.throws(() => gate.noteToolCall(), /tool-call cap/);
  assert.equal(gate.correctionAllowed, false);
});
