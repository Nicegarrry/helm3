import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function resources(createExtensionRuntime: () => unknown) {
  return { getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => undefined, reload: async () => undefined };
}
function completion(): Response {
  return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

test('pinned Pi SDK forwards explicit thinking levels through provider-free fetch without treating off as provider-effective', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-thinking-policy-'));
  const originalFetch = globalThis.fetch; const requests: Array<Record<string, unknown>> = [];
  let first: { dispose(): void } | undefined; let second: { dispose(): void } | undefined;
  globalThis.fetch = async (_input, init) => { requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return completion(); };
  try {
    const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
    const { InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new InMemoryCredentialStore() });
    await runtime.setRuntimeApiKey('opencode-go', 'provider-free-fixture');
    const create = async (modelId: string, level: 'off' | 'low', name: string) => createAgentSession({ cwd: root, agentDir: join(root, name), modelRuntime: runtime, model: runtime.getModel('opencode-go', modelId)!, thinkingLevel: level, sessionManager: SessionManager.create(root, join(root, `${name}-sessions`)), settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), noTools: 'all', resourceLoader: resources(createExtensionRuntime) as never });
    const low = await create('qwen3.8-max', 'low', 'low'); first = low.session;
    assert.equal(low.session.thinkingLevel, 'low'); await low.session.prompt('fixture');
    const off = await create('kimi-k2.7-code', 'off', 'off'); second = off.session;
    assert.equal(off.session.thinkingLevel, 'off'); await off.session.prompt('fixture');
    assert.equal(requests[0]?.reasoning_effort, 'low', 'Pi forwarded the selected level to the compatible route');
    assert.equal('reasoning_effort' in requests[1]!, false, 'Kimi off only omits the generic field; it does not prove provider reasoning is disabled');
  } finally { first?.dispose(); second?.dispose(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
