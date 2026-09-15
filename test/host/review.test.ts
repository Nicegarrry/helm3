import assert from 'node:assert/strict';
import test from 'node:test';
import { IndependentReviewService, type DurableReviewRecord } from '../../src/host/review.js';
import { createHostReviewToolRegistry } from '../../src/host/review-tools.js';
import { AstraLoopbackMcpTransport, FableDriver, type OrchestratorArtifacts } from '../../src/runtime/orchestrator/index.js';

const head = 'a'.repeat(40);
function fixture(overrides: Partial<ConstructorParameters<typeof IndependentReviewService>[0]> = {}) {
  let spawns = 0;
  const records = new Map<string, DurableReviewRecord>();
  const source = { workerId: 'builder-1', attemptId: 'attempt-builder', sessionId: 'session-builder', modelId: 'builder', family: 'fable', provider: 'faux', api: 'responses', repository: 'fixture/repo', workspace: '/fixture/workspace', runId: 'run-1', head, clean: true, contextRefs: ['builder-transcript-forbidden'] };
  const service = new IndependentReviewService({
    assertReviewContext: async () => undefined,
    source: async () => source,
    readArtifact: async (ref) => `immutable:${ref}`,
    inspectSource: async () => ({ head, clean: true }),
    authorize: async (actual, model) => { assert.equal(actual.family, 'fable'); assert.equal(model, 'reviewer'); },
    spawn: async input => { spawns++; assert.equal(input.role, 'reviewer'); assert.equal(input.modelId, 'reviewer'); assert.match(input.label ?? '', /^independent-review:review-[0-9a-f]+:sha256:/); return { workerId: 'reviewer-1', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer' }; },
    durability: { reopen: async key => records.get(key), prepare: async record => { const existing = records.get(record.idempotencyKey); if (existing) return { record: existing, created: false }; records.set(record.idempotencyKey, record); return { record, created: true }; }, append: async record => { records.set(record.idempotencyKey, record); } },
    ...overrides,
  });
  return { service, count: () => spawns, records, durability: {
    reopen: async (key: string) => records.get(key),
    prepare: async (record: DurableReviewRecord) => {
      const existing = records.get(record.idempotencyKey);
      if (existing) return { record: existing, created: false };
      records.set(record.idempotencyKey, record);
      return { record, created: true };
    },
    append: async (record: DurableReviewRecord) => { records.set(record.idempotencyKey, record); },
  } };
}

test('independent review freezes only caller-authorized context before a distinct reviewer launch', async () => {
  const { service, count } = fixture();
  const launch = await service.request({ sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: ['brief', 'code'], reviewerModelId: 'reviewer' });
  assert.equal(count(), 1); assert.equal(launch.source.sessionId, 'session-builder'); assert.equal(launch.reviewer.sessionId, 'session-reviewer');
  assert.equal(launch.manifest.entries.length, 4); assert.ok(launch.manifest.entries.every(entry => entry.hash.startsWith('sha256:')));
  assert.ok(!launch.manifest.entries.some(entry => entry.ref.includes('transcript')));
});

test('unapproved, purpose-swapped, and model-supplied review context refuse before spawn', async () => {
  const approved = new Map([['objective:objective', 'immutable:objective'], ['acceptance:acceptance', 'immutable:acceptance'], ['code:factual-context', 'immutable:code']]);
  for (const input of [
    { objectiveRef: 'generic-primary-conclusion', acceptanceRef: 'acceptance', contextRefs: ['code'] },
    { objectiveRef: 'code', acceptanceRef: 'acceptance', contextRefs: [] },
    { objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: ['builder-transcript'] },
  ]) {
    const { service, count } = fixture({ assertReviewContext: async (ref, purpose, text) => { if (approved.get(`${ref}:${purpose}`) !== text) throw new Error('unapproved host review context'); } });
    await assert.rejects(service.request({ sourceWorkerId: 'builder-1', expectedHead: head, reviewerModelId: 'reviewer', ...input }));
    assert.equal(count(), 0);
  }
});

test('review persists a stable pre-spawn intent and reopens it without a duplicate model request', async () => {
  const { service, count, records } = fixture();
  const input = { sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: ['brief'], reviewerModelId: 'reviewer' };
  const first = await service.request(input); const second = await service.request(input);
  assert.equal(count(), 1); assert.equal(first.reviewId, second.reviewId); assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(records.get(first.idempotencyKey)?.state, 'launched');
  assert.equal(first.manifest.entries[0]?.ref, 'objective');
});

test('reconcile reopens a durable launch after restart without source authority or a new native effect', async () => {
  const initial = fixture();
  const input = { sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: [], reviewerModelId: 'reviewer' };
  const launched = await initial.service.request(input);
  let sourceCalls = 0;
  let observed = 0;
  const recovered = fixture({
    durability: initial.durability,
    source: async () => { sourceCalls++; throw new Error('reconciliation must not re-authorize source'); },
    observeTerminal: async () => {
      observed++;
      return { resultRef: 'actual-result', rawEventRefs: ['actual-event'], readonlyObservation: { beforeRef: 'actual-before', afterRef: 'actual-after' } };
    },
  });
  const [first, second] = await Promise.all([
    recovered.service.reconcile(launched.reviewId, launched.idempotencyKey),
    recovered.service.reconcile(launched.reviewId, launched.idempotencyKey),
  ]);
  assert.equal(first.state, 'terminal'); assert.equal(second.state, 'terminal');
  assert.equal(observed, 1); assert.equal(sourceCalls, 0); assert.equal(recovered.count(), 0);
  assert.equal(initial.records.get(launched.idempotencyKey)?.outcome?.resultRef, 'actual-result');
});

test('an existing launch waits for the same reconciliation and incomplete evidence never retries', async () => {
  let release!: () => void;
  const observedGate = new Promise<void>(resolve => { release = resolve; });
  let observationStarted!: () => void;
  const started = new Promise<void>(resolve => { observationStarted = resolve; });
  let observed = 0;
  const { service, count } = fixture({
    observeTerminal: async () => {
      observed++;
      observationStarted();
      await observedGate;
      return undefined;
    },
  });
  const input = { sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: [], reviewerModelId: 'reviewer' };
  const launched = await service.request(input);
  await started;
  const repeated = service.request(input);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(observed, 1);
  release();
  const reopened = await repeated;
  assert.equal(launched.state, 'launched'); assert.equal(reopened.state, 'launched');
  assert.equal(observed, 1); assert.equal(count(), 1);
});

test('review snapshots caller input before artifact reads can mutate it', async () => {
  let requestedModel = '';
  const input = { sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: ['brief'], reviewerModelId: 'reviewer' };
  const { service } = fixture({
    readArtifact: async () => { input.reviewerModelId = 'mutated-model'; input.contextRefs.push('mutated-ref'); return 'immutable'; },
    spawn: async value => { requestedModel = value.modelId; return { workerId: 'reviewer-1', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer' }; },
  });
  const launch = await service.request(input);
  assert.equal(requestedModel, 'reviewer');
  assert.equal(launch.reviewer.requestedModelId, 'reviewer');
  assert.deepEqual(launch.manifest.entries.map(entry => entry.ref), ['objective', 'acceptance', 'brief']);
});

test('review records a preflight refusal when source head drifts after the durable claim', async () => {
  const live = { head, clean: true };
  const { service, count, records } = fixture({
    readArtifact: async () => { live.head = 'b'.repeat(40); return 'immutable'; },
    inspectSource: async () => live,
  });
  await assert.rejects(service.request({ sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: [], reviewerModelId: 'reviewer' }), /changed before review effect/);
  assert.equal(count(), 0);
  assert.equal([...records.values()][0]?.state, 'unknown');
  assert.equal([...records.values()][0]?.failure?.reason, 'preflight-refused');
});

test('review keeps a reconciliation identity after a post-spawn uncertainty and never blind-retries', async () => {
  const { service, count, records } = fixture({ spawn: async () => { throw new Error('transport stopped after native effect'); } });
  const input = { sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: [], reviewerModelId: 'reviewer' };
  await assert.rejects(service.request(input), /reconcile review-/); const reopened = await service.request(input);
  assert.equal(count(), 0); assert.equal([...records.values()][0]?.state, 'unknown');
  assert.equal(reopened.state, 'unknown');
});

test('only a trusted runtime completion can attach result, raw, and readonly observation refs', async () => {
  const { service } = fixture();
  const launch = await service.request({ sourceWorkerId: 'builder-1', expectedHead: head, objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: [], reviewerModelId: 'reviewer' });
  const terminal = await service.recordTerminal(launch.reviewId, launch.idempotencyKey, { resultRef: 'host-result', rawEventRefs: ['raw-event'], readonlyObservation: { beforeRef: 'git-before', afterRef: 'git-after' } });
  assert.equal(terminal.state, 'terminal'); assert.equal(terminal.outcome?.readonlyObservation.afterRef, 'git-after');
  await assert.rejects(service.recordTerminal(launch.reviewId, launch.idempotencyKey, { rawEventRefs: [], readonlyObservation: {} }));
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
