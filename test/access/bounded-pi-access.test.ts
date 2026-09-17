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

test('requires and reapplies the pinned OpenRouter route after caller payload hooks', async () => {
  const route = { only: ['baseten'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true, max_price: { prompt: 0.3, completion: 1.2 } };
  const openRouter = { id: 'deepseek/deepseek-v4.1-flash', provider: 'openrouter', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 1048576, maxTokens: 32768 } as Model<Api>;
  assert.throws(() => new BoundedPiAccess({ ...access().policy, provider: 'openrouter', model: openRouter.id, baseUrl: openRouter.baseUrl } as never), /routing policy is required/);
  const gate = new BoundedPiAccess({ ...access().policy, provider: 'openrouter', model: openRouter.id, api: openRouter.api, baseUrl: openRouter.baseUrl, contextWindow: openRouter.contextWindow, maxOutputTokens: 512, maxBilledOutputTokens: 32768, openRouterRouting: route });
  const prepared = gate.prepare('route-effect', openRouter, { messages: [] }, { maxTokens: 999, onPayload: () => ({ model: 'attacker/model', max_tokens: 1, provider: { only: ['fireworks'], allow_fallbacks: true } }) });
  const payload = await prepared.options.onPayload?.({ model: openRouter.id, max_completion_tokens: 512 }, openRouter);
  assert.deepEqual(payload, { model: openRouter.id, max_completion_tokens: 512, provider: route });
});


test('OpenRouter pins nested route values and refuses unpriced or auxiliary routing', async () => {
  const route = { only: ['baseten'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true, max_price: { prompt: 0.3, completion: 1.2 } };
  const policy = { ...access().policy, provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', baseUrl: 'https://openrouter.ai/api/v1', openRouterRouting: route };
  assert.throws(() => new BoundedPiAccess({ ...policy, openRouterRouting: { ...route, max_price: undefined } }), /price caps/);
  assert.throws(() => new BoundedPiAccess({ ...policy, openRouterRouting: { ...route, max_price: { prompt: 999, completion: 1.2 } } }), /price caps/);
  const gate = new BoundedPiAccess(policy);
  route.only.push('deepseek'); route.max_price.prompt = 999;
  const selected = { ...model, provider: 'openrouter', id: policy.model, baseUrl: policy.baseUrl } as Model<Api>;
  const prepared = gate.prepare('mutated-route', selected, { messages: [] }, { onPayload: () => undefined });
  const payload = await prepared.options.onPayload!({ model: selected.id, messages: [] }, selected) as any;
  assert.deepEqual(payload.provider.only, ['baseten']);
  assert.equal(payload.provider.max_price.prompt, 0.3);
  for (const key of ['models', 'route', 'plugins', 'service_tier']) {
    await assert.rejects(async () => prepared.options.onPayload!({ [key]: [] }, selected), /not authorised/);
  }
  await assert.rejects(async () => prepared.options.onPayload!({ messages: ['x'.repeat(2000)] }, selected), /packet cap/);
});

test('actual Pi OpenRouter HTTP payload preserves bounded routing after sampling overrides', async () => {
  const { streamSimple } = await import('@earendil-works/pi-ai/api/openai-completions');
  const originalFetch = globalThis.fetch;
  let observed: any;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    observed = JSON.parse(String(init?.body));
    return new Response('data: {"id":"synthetic-openrouter","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const route = { only: ['baseten'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true, max_price: { prompt: 0.3, completion: 1.2 } };
    const selected = { ...model, name: 'probe', provider: 'openrouter', id: 'deepseek/deepseek-v4.1-flash', baseUrl: 'https://openrouter.ai/api/v1', reasoning: false, input: ['text'], cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 }, compat: { openRouterRouting: route } } as Model<Api>;
    const gate = new BoundedPiAccess({ ...access().policy, provider: selected.provider, model: selected.id, baseUrl: selected.baseUrl, openRouterRouting: route, maxPacketBytes: 8192 });
    const context = { messages: [{ role: 'user' as const, content: 'Synthetic test', timestamp: 0 }] };
    const prepared = gate.prepare('wire', selected, context, { apiKey: 'synthetic-no-account', samplingParams: { model: 'wrong/model', provider: { only: ['deepseek'], allow_fallbacks: true }, max_tokens: 999999, max_completion_tokens: 999999 } } as any);
    const result = await streamSimple(selected as Model<'openai-completions'>, context, prepared.options).result();
    assert.equal(result.stopReason, 'stop');
    assert.equal(observed.model, selected.id);
    assert.deepEqual(observed.provider, route);
    assert.equal(observed.max_completion_tokens, 100);
    assert.equal(observed.max_tokens, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('public-training-allowed is an explicit zero-cost NVIDIA Nemotron route with no file context', async () => {
  const route = { only: ['nvidia'], allow_fallbacks: false, require_parameters: true, data_collection: 'allow', zdr: false, max_price: { prompt: 0, completion: 0 } };
  const selected = { ...model, provider: 'openrouter', id: 'nvidia/nemotron-3-ultra-550b-a55b:free', baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 1048576, maxTokens: 32768 } as Model<Api>;
  const gate = new BoundedPiAccess({ poolId: 'free', provider: 'openrouter', model: selected.id, api: 'openai-completions', baseUrl: selected.baseUrl, authEnvironment: 'OPENROUTER_API_KEY', contextWindow: selected.contextWindow, maxOutputTokens: 512, maxBilledOutputTokens: 32768, maxPacketBytes: 8192, maxRequests: 1, inputUsdPerMillion: 0, outputUsdPerMillion: 0, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, maxToolCalls: 0, timeoutMs: 1000, openRouterDataPolicy: 'public-training-allowed', dataClassification: 'public', contextRefs: [], readableRoots: [], openRouterRouting: route });
  assert.equal(gate.policy.openRouterDataPolicy, 'public-training-allowed');
  const prepared = gate.prepare('public-free', selected, { messages: [{ role: 'user', content: 'public objective' }] }, { samplingParams: { provider: { only: ['fireworks'], allow_fallbacks: true }, max_tokens: 9999 } } as any);
  const payload = await prepared.options.onPayload!({ model: 'attacker', max_tokens: 9999, messages: [{ role: 'system', content: '/private/host/path' }, { role: 'developer', content: 'generated metadata' }, { role: 'user', content: 'public objective' }, { role: 'assistant', content: 'prior' }, { role: 'tool', content: 'result' }] }, selected) as any;
  assert.equal(payload.model, selected.id);
  assert.deepEqual(payload.provider, route);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content.includes('/private/host/path'), false);
  assert.deepEqual(payload.messages.slice(1).map((message: any) => message.role), ['user', 'assistant', 'tool']);
  assert.equal(prepared.reservation.upperBound, 0);
  assert.equal(prepared.reservation.openRouterDataPolicy, 'public-training-allowed');
  for (const malformed of [{}, { messages: 'private prompt' }, { messages: [null] }, { messages: [{ role: 'function', content: 'unclassified' }] }, { messages: [{ content: 'missing role' }] }]) {
    await assert.rejects(async () => prepared.options.onPayload!(malformed, selected), /public OpenRouter/);
  }
});

test('public-training-allowed refuses missing attestation, paid rates, or widened provider', () => {
  const route = { only: ['nvidia'], allow_fallbacks: false, require_parameters: true, data_collection: 'allow', zdr: false, max_price: { prompt: 0, completion: 0 } };
  const base = { ...access().policy, poolId: 'free', provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 1048576, maxOutputTokens: 512, maxBilledOutputTokens: 32768, openRouterDataPolicy: 'public-training-allowed' as const, dataClassification: 'public' as const, contextRefs: [] as string[], readableRoots: [] as string[], openRouterRouting: route };
  assert.throws(() => new BoundedPiAccess({ ...base, readableRoots: ['.'] }), /attestation/);
  assert.throws(() => new BoundedPiAccess({ ...base, inputUsdPerMillion: 0.01 }), /zero declared costs/);
  assert.throws(() => new BoundedPiAccess({ ...base, openRouterRouting: { ...route, only: ['fireworks'] } }), /route is unsafe/);
  assert.throws(() => new BoundedPiAccess({ ...base, model: 'nvidia/other:free' }), /Nemotron/);
});
