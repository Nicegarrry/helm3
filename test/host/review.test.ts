import assert from 'node:assert/strict';
import test from 'node:test';
import { IndependentReviewService } from '../../src/host/review.js';
import { createHostReviewToolRegistry } from '../../src/host/review-tools.js';
import { AstraLoopbackMcpTransport, FableDriver, type OrchestratorArtifacts } from '../../src/runtime/orchestrator/index.js';

const head = 'a'.repeat(40);
function fixture(overrides: Partial<ConstructorParameters<typeof IndependentReviewService>[0]> = {}) {
  let spawns = 0;
  const source = { workerId: 'builder-1', attemptId: 'attempt-builder', sessionId: 'session-builder', modelId: 'builder', family: 'fable', provider: 'faux', api: 'responses', repository: 'fixture/repo', workspace: '/fixture/workspace', runId: 'run-1', head, clean: true, contextRefs: ['builder-transcript-forbidden'] };
  const service = new IndependentReviewService({
    source: async () => source,
    readArtifact: async (ref) => `immutable:${ref}`,
    inspectSource: async () => ({ head, clean: true }),
    authorize: async (actual, model) => { assert.equal(actual.family, 'fable'); assert.equal(model, 'reviewer'); },
    spawn: async input => { spawns++; assert.equal(input.role, 'reviewer'); assert.equal(input.modelId, 'reviewer'); return { workerId: 'reviewer-1', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer' }; },
    ...overrides,
  });
  return { service, count: () => spawns };
}

test('independent review freezes only caller-authorized context before a distinct reviewer launch', async () => {
  const { service, count } = fixture();
  const launch = await service.request({ sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: ['brief', 'code'], reviewerModelId: 'reviewer' });
  assert.equal(count(), 1); assert.equal(launch.source.sessionId, 'session-builder'); assert.equal(launch.sessionId, 'session-reviewer');
  assert.equal(launch.manifest.entries.length, 4); assert.ok(launch.manifest.entries.every(entry => entry.hash.startsWith('sha256:')));
  assert.ok(!launch.manifest.entries.some(entry => entry.ref.includes('transcript')));
});

test('common review registry never exposes approval or controller mutation tools', async () => {
  const { service } = fixture();
  const context = { runId: 'run-1', sessionId: 'controller-1', mode: 'primary' as const };
  const registry = createHostReviewToolRegistry({ context, authorize: async () => undefined,
    host: { snapshot: async () => ({}) as never, readRunEvents: () => [] },
    brief: { read: async () => ({ text: 'brief', source: 'test', observedAt: '2026-09-16T00:00:00.000Z' }) },
    map: { snapshot: async () => ({ source: { repository: 'fixture/repo', parentIssue: 1 }, observedAt: '2026-09-16T00:00:00.000Z', completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }) },
    economy: { snapshot: () => ({ pools: [], models: [], quota: [] }) },
  }, service);
  assert.deepEqual(registry.all().map(tool => tool.name).sort(), ['brief.get', 'budget.get', 'log.query', 'map.get', 'models.get', 'review.request']);
  const result = await registry.invoke('review.request', { sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: [], reviewerModelId: 'reviewer' }, context);
  assert.equal(result.state, 'succeeded');
  assert.equal((await registry.invoke('integration.approve', {}, context)).state, 'unsupported');
});

test('Fable and Astra expose the same trusted review.request registry entry', async () => {
  const { service } = fixture(); const context = { runId: 'run-1', sessionId: 'controller-1', mode: 'primary' as const };
  const registry = createHostReviewToolRegistry({ context, authorize: async () => undefined,
    host: { snapshot: async () => ({}) as never, readRunEvents: () => [] },
    brief: { read: async () => ({ text: 'brief', source: 'test', observedAt: '2026-09-16T00:00:00.000Z' }) },
    map: { snapshot: async () => ({ source: { repository: 'fixture/repo', parentIssue: 1 }, observedAt: '2026-09-16T00:00:00.000Z', completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }) }, economy: { snapshot: () => ({ pools: [], models: [], quota: [] }) },
  }, service);
  let definitions: Array<{ name: string; handler(input: Record<string, unknown>, extra: unknown): Promise<unknown> }> = [];
  const artifacts: OrchestratorArtifacts = { readText: async () => 'objective', saveInvocation: async () => 'invocation', saveRecoveryBundle: async () => 'bundle', loadRecoveryBundle: async () => { throw new Error('unused'); } };
  const fable = new FableDriver(artifacts, registry, { assertCurrent: async () => undefined }, { capture: async () => ({ recoveryStateRef: 'recovery' }), restore: async () => 'recovery' }, { env: { PATH: process.env.PATH ?? '' } }, {
    tool: ((name: string, _description: string, _input: unknown, handler: (input: Record<string, unknown>) => Promise<unknown>) => ({ name, handler })) as never,
    createSdkMcpServer(input: { tools?: unknown }) { definitions = input.tools as typeof definitions; return {} as never; },
    query: (() => (async function* () { yield { type: 'result', subtype: 'success', is_error: false }; })()) as never,
  });
  const started = await fable.start({ runId: context.runId, contextRefs: [], mode: 'primary' }); await fable.invoke({ sessionId: started.sessionId, objectiveRef: 'objective', contextRefs: [] });
  assert.deepEqual(definitions.map(tool => tool.name), registry.all().map(tool => tool.name)); assert.ok(definitions.some(tool => tool.name === 'review.request'));
  const bridge = await AstraLoopbackMcpTransport.open({ registry, guard: { assertCurrent: async () => undefined }, session: context });
  try {
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js')]);
    const [, token] = Object.entries(bridge.env)[0]!; const transport = new StreamableHTTPClientTransport(new URL(bridge.config.mcp_servers.helm.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }); const client = new Client({ name: 'review-tools', version: '1' }); await client.connect(transport);
    try { assert.ok((await client.listTools()).tools.some(tool => tool.name === 'review.request')); } finally { await transport.close(); }
  } finally { await bridge.close(); }
});

for (const failure of ['dirty', 'stale', 'authorization', 'session-reuse'] as const) test(`review refuses ${failure} before a new model request`, async () => {
  const { service, count } = fixture(failure === 'dirty' ? { inspectSource: async () => ({ head, clean: false }) }
    : failure === 'stale' ? { inspectSource: async () => ({ head: 'b'.repeat(40), clean: true }) }
      : failure === 'authorization' ? { authorize: async () => { throw new Error('cross-family policy required'); } }
        : { spawn: async () => ({ workerId: 'reviewer', attemptId: 'attempt-builder', sessionId: 'session-builder' }) });
  await assert.rejects(service.request({ sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: [], reviewerModelId: 'reviewer' }));
  assert.equal(count(), 0);
});
