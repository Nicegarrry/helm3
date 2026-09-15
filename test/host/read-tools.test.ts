import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod/v3';
import { createHostReadToolRegistry } from '../../src/host/tools.js';
import { AstraLoopbackMcpTransport, FableDriver, type HelmToolExecutionContext, type OrchestratorArtifacts } from '../../src/runtime/orchestrator/index.js';
import { createOperatorServer, listenOperatorServer } from '../../src/operator/server.js';
import { operatorCli, readOperatorToolApi } from '../../src/operator/cli.js';

const now = '2026-09-16T00:00:00.000Z';
const context = { runId: 'run-read', sessionId: 'session-read', mode: 'primary' as const };
const host = {
  async snapshot(runId: string) { return { runId, commands: [], attempts: [], attemptLifecycles: [], autonomyLeases: [], artifacts: [], recoveryRefs: [], reservations: [{ commandId: 'c', leaseId: 'l', poolId: 'requests', unit: 'requests', reserved: 2, state: 'reserved' as const }] }; },
  readRunEvents(runId: string, limit: number) { return [{ eventId: 'event-1', kind: 'worker.observed', source: 'fixture', sourceEventId: 'private-provider-id', occurredAt: now, recordedAt: now, sessionId: context.sessionId }].slice(0, limit); },
};
const economy = { snapshot: () => ({ pools: [{ poolId: 'requests', kind: 'subscription' as const, unit: 'requests' }], models: [{ modelId: 'fixture-model', provider: 'fixture', family: 'fixture', poolId: 'requests', enabled: true, availability: 'unknown' as const, roles: ['builder' as const], buildCapabilities: [], reviewCapabilities: [], dataPolicy: 'public-only' as const, observedAt: now }], quota: [{ poolId: 'requests', state: 'unknown' as const, observedAt: now, detail: 'provider capacity is unobserved' }] }) };
const registry = (authorize?: (actual: HelmToolExecutionContext) => Promise<void>) => createHostReadToolRegistry({ context, authorize, host, economy, brief: { async read() { return { text: 'The human-owned Brief.', source: 'configured://brief', observedAt: now }; } }, map: { async snapshot() { return { source: { repository: 'owner/repo', parentIssue: 9 }, observedAt: now, completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }; } } });

test('host read registry binds scope, exposes five actual sources, and preserves unknown economy headroom', async () => {
  const tools = registry();
  assert.deepEqual(tools.all().map((tool) => tool.name), ['brief.get', 'map.get', 'log.query', 'models.get', 'budget.get']);
  const values = await Promise.all(tools.all().map((tool) => tools.invoke(tool.name, tool.name === 'log.query' ? { limit: 1 } : {}, context)));
  assert.ok(values.every((value) => value.state === 'succeeded'));
  assert.deepEqual((values[0] as { value: unknown }).value, { text: 'The human-owned Brief.', source: 'configured://brief', observedAt: now });
  assert.equal((values[1] as { value: { source: { repository: string } } }).value.source.repository, 'owner/repo');
  assert.doesNotMatch(JSON.stringify((values[2] as { value: unknown }).value), /payload|transcript|secret/i);
  const budget = (values[4] as { value: { headroom: string; quota: Array<{ state: string }> } }).value;
  assert.equal(budget.headroom, 'unknown'); assert.equal(budget.quota[0]?.state, 'unknown');
  assert.deepEqual(await tools.invoke('brief.get', {}, { ...context, runId: 'foreign' }), { state: 'refused', reason: 'tool context is outside the trusted host binding' });
  assert.equal((await tools.invoke('log.query', { limit: 101 }, context)).state, 'refused');
  assert.equal((await tools.invoke('map.get', { path: '/etc/passwd' }, context)).state, 'refused');
});

test('Fable callback and Astra loopback list and invoke the same host read registry', async () => {
  const tools = registry(async () => {}); let definitions: Array<{ name: string; handler(input: Record<string, unknown>, extra: unknown): Promise<unknown> }> = [];
  const artifacts: OrchestratorArtifacts = { async readText() { return 'objective'; }, async saveInvocation() { return 'invocation'; }, async saveRecoveryBundle() { return 'bundle'; }, async loadRecoveryBundle() { throw new Error('unused'); } };
  const fable = new FableDriver(artifacts, tools, { async assertCurrent() {} }, { async capture() { return { recoveryStateRef: 'recovery' }; }, async restore() { return 'recovery'; } }, { env: { PATH: process.env.PATH ?? '' } }, {
    tool: ((name: string, _description: string, _input: unknown, handler: (input: Record<string, unknown>) => Promise<unknown>) => ({ name, handler })) as never,
    createSdkMcpServer(input: { tools?: unknown }) { definitions = input.tools as typeof definitions; return {} as never; },
    query: (() => (async function* () { await definitions.find((tool) => tool.name === 'brief.get')!.handler({}, {}); yield { type: 'result', subtype: 'success', is_error: false }; })()) as never,
  });
  const started = await fable.start({ runId: context.runId, contextRefs: [], mode: 'primary' });
  await fable.invoke({ sessionId: started.sessionId, objectiveRef: 'objective', contextRefs: [] });
  assert.deepEqual(definitions.map((tool) => tool.name), tools.all().map((tool) => tool.name));
  assert.deepEqual(await tools.invoke('brief.get', {}, { ...context, sessionId: started.sessionId }), { state: 'succeeded', value: { text: 'The human-owned Brief.', source: 'configured://brief', observedAt: now } });

  const bridge = await AstraLoopbackMcpTransport.open({ registry: tools, guard: { async assertCurrent() {} }, session: context });
  try {
    const [{ Client }, { StreamableHTTPClientTransport }, { CallToolResultSchema }] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'), import('@modelcontextprotocol/sdk/types.js')]);
    const [key, token] = Object.entries(bridge.env)[0]!;
    const transport = new StreamableHTTPClientTransport(new URL(bridge.config.mcp_servers.helm.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'read-tools', version: '1' }); await client.connect(transport);
    try { assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), tools.all().map((tool) => tool.name)); assert.deepEqual((await client.callTool({ name: 'brief.get', arguments: {} }, CallToolResultSchema)).structuredContent, await tools.invoke('brief.get', {}, context)); }
    finally { await transport.close(); }
    assert.ok(key.startsWith('HELM_ASTRA_MCP_TOKEN_'));
  } finally { await bridge.close(); }
});

test('operator read API and CLI reuse the host registry without a writable endpoint', async () => {
  const server = createOperatorServer({ async read() { return { schemaVersion: 1 as const, observedAt: now, source: { kind: 'fixture' as const, evidenceMode: 'fixture' as const, id: 'fixture', observedAt: now }, unknowns: [], map: null, run: { runId: context.runId, owner: { orchestrator: null, epoch: null }, leases: { orchestrator: { state: 'unknown' as const, id: null, expiresAt: null }, autonomy: { state: 'unknown' as const, id: null, expiresAt: null } } }, attempts: [], pendingCommands: [], needsYou: null, resources: { units: [], context: [] }, quality: { gate: { passed: null, total: null }, integration: { passed: null, total: null } } }; } }, { registry: registry(), context });
  const address = await listenOperatorServer(server); const origin = `http://${address.host}:${address.port}`;
  try {
    assert.deepEqual(await readOperatorToolApi(origin, 'brief.get'), await registry().invoke('brief.get', {}, context));
    assert.deepEqual(JSON.parse(await operatorCli(['--url', origin, '--read', 'log.query', '--limit', '1'])), await registry().invoke('log.query', { limit: 1 }, context));
    assert.equal((await fetch(`${origin}/api/operator/read/log.query?limit=1000`)).status, 400);
    assert.equal((await fetch(`${origin}/api/operator/read/brief.get?path=x`)).status, 400);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
