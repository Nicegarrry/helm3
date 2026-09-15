import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedPiAccess } from '../../src/access/index.js';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };

const model = { id: 'kimi-k2.7-code', provider: 'opencode-go', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', contextWindow: 262144, maxTokens: 262144 } as Model<Api>;
const message = (total: number): AssistantMessage => ({
  role: 'assistant', content: [], api: 'openai-completions', provider: 'opencode-go', model: 'kimi-k2.7-code', stopReason: 'stop', timestamp: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total } },
});

function access() {
  return new BoundedPiAccess({ poolId: 'overnight-api-usd', inputUsdPerMillion: 0.95, outputUsdPerMillion: 4,
    cacheReadUsdPerMillion: 0.19, cacheWriteUsdPerMillion: 0,
    provider: 'opencode-go', model: 'kimi-k2.7-code', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', authEnvironment: 'OPENCODE_API_KEY', contextWindow: 262144,
    maxPacketBytes: 1000, maxOutputTokens: 100, maxBilledOutputTokens: 262144, maxRequests: 2, maxToolCalls: 1, timeoutMs: 1000 });
}

test('declares a conservative byte input cap, fixes output/retries, and settles observed usage', () => {
  const gate = access();
  const prepared = gate.prepare('effect-1', model, { systemPrompt: 'do work', messages: [], tools: [{ name: 'helm_write', parameters: { type: 'object' } }] }, { maxRetries: 9, maxTokens: 999 });
  assert.equal(prepared.options.maxRetries, 0);
  assert.equal(prepared.options.maxTokens, 100);
  assert.equal(prepared.reservation.poolId, 'overnight-api-usd');
  assert.equal(prepared.reservation.unit, 'usd');
  assert.ok(prepared.reservation.upperBound > 0);
  gate.settle('effect-1', message(0));
  assert.deepEqual(gate.settlement('effect-1'), { state: 'known', amount: 0.00000495 });
});

test('refuses oversized input/context and retains a reservation when final usage is unknown', () => {
  const gate = access();
  assert.throws(() => gate.prepare('too-large', model, { systemPrompt: 'x'.repeat(1001), messages: [] }, undefined), /packet cap/);
  const prepared = gate.prepare('effect-2', model, { systemPrompt: 'small', messages: [] }, undefined);
  gate.unknown('effect-2', 'timeout');
  assert.deepEqual(gate.settlement('effect-2'), { state: 'unknown', reason: 'timeout' });
  assert.throws(() => gate.prepare('effect-3', { ...model, contextWindow: 110 } as Model<Api>, { systemPrompt: 'small', messages: [] }, undefined), /frozen provider facts/);
  assert.equal(prepared.reservation.billedOutputTokens, 262144);
});

test('limits tool effects and does not enable repair follow-ups by default', () => {
  const gate = access();
  gate.noteToolCall();
  assert.throws(() => gate.noteToolCall(), /tool-call cap/);
  assert.equal(gate.correctionAllowed, false);
});

test('refuses a changed provider fact and a third request even before provider dispatch', () => {
  const gate = access();
  assert.throws(() => gate.prepare('wrong-model', { ...model, baseUrl: 'https://elsewhere.invalid' } as Model<Api>, { messages: [] }, undefined), /frozen provider facts/);
  gate.prepare('one', model, { messages: [] }, undefined);
  gate.prepare('two', model, { messages: [] }, undefined);
  assert.throws(() => gate.prepare('three', model, { messages: [] }, undefined), /count cap/);
});

test('takes an immutable strict policy snapshot and retains zero or inconsistent usage', () => {
  const original = { ...access().policy };
  const gate = new BoundedPiAccess(original);
  original.provider = 'opencode';
  original.maxOutputTokens = 1;
  const prepared = gate.prepare('immutable', model, { messages: [] }, undefined);
  assert.equal(prepared.options.maxTokens, 100);
  assert.equal(prepared.reservation.provider, 'opencode-go');
  gate.settle('immutable', { ...message(0), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  assert.deepEqual(gate.settlement('immutable'), { state: 'unknown', reason: 'provider token telemetry is zero, inconsistent, or exceeds a frozen cap' });
  assert.throws(() => new BoundedPiAccess({ ...access().policy, untrusted: true } as unknown as typeof original), /unknown fields/);
});
