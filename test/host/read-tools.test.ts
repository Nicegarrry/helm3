import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod/v3';
import { createHostReadToolRegistry } from '../../src/host/tools.js';
import { openHost } from '../../src/host/index.js';
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

function event(runId: string, sequence: number, payload: unknown = { secret: 'must-not-escape' }) {
  return {
    eventId: `${runId}-event-${sequence}`, schemaVersion: 1 as const, kind: 'worker.observed', source: 'read-tools-test', sourceEventId: `${runId}-source-${sequence}`,
    occurredAt: now, recordedAt: now, correlationId: runId, sessionId: `${runId}-session`, payload,
  };
}

async function realHostReadRegistry(clock: () => string = () => now) {
  const directory = mkdtempSync(join(tmpdir(), 'helm3-read-tools-'));
  const plane = await openHost({ stateDirectory: directory, kinds: {}, now: clock });
  const authority = { runId: 'run-read', owner: 'fable' as const, leaseId: 'read-owner-1', expectedEpoch: 0, issuedAt: now, expiresAt: '2026-09-16T01:00:00.000Z' };
  const guard = plane.createSessionGuard(authority);
  await guard.authorizeStart?.({ driver: 'fable', runId: 'run-read', sessionId: 'session-read', mode: 'primary' });
  const actual = { runId: 'run-read', sessionId: 'session-read', mode: 'primary' as const };
  const tools = createHostReadToolRegistry({
    context: actual,
    authorize: async (value) => { plane.artifactsFor(value); },
    host: plane,
    economy,
    brief: { async read() { return { text: 'The human-owned Brief.', source: 'configured://brief', observedAt: now }; } },
    map: { async snapshot() { return { source: { repository: 'owner/repo', parentIssue: 9 }, observedAt: now, completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }; } },
  });
  return { directory, plane, tools, actual };
}

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

test('host read source failures are stable public outcomes, including synchronous economy failures', async () => {
  const marker = 'synthetic-provider-token-must-not-escape';
  const tools = createHostReadToolRegistry({
    context,
    authorize: async () => {},
    brief: { async read() { throw new Error(marker); } },
    host: { async snapshot() { throw new Error(marker); }, readRunEvents() { throw new Error(marker); } },
    map: { async snapshot() { throw new Error(marker); } },
    economy: { snapshot() { throw new Error(marker); } },
  });
  for (const name of ['brief.get', 'map.get', 'log.query', 'models.get', 'budget.get'] as const) {
    const result = await tools.invoke(name, name === 'log.query' ? { limit: 1 } : {}, context);
    assert.deepEqual(result, { state: 'unknown', reason: 'host read source is unavailable' });
    assert.ok(!JSON.stringify(result).includes(marker));
  }
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

test('host log.query reads a payload-free latest tail without loading the bounded supervisor history', async () => {
  const fixture = await realHostReadRegistry();
  try {
    for (let sequence = 0; sequence <= 10_000; sequence += 1) fixture.plane.supervisorLog().appendEvent(event('run-read', sequence));
    fixture.plane.supervisorLog().appendEvent(event('other-run', 1));
    const outcome = await fixture.tools.invoke('log.query', { limit: 3 }, fixture.actual);
    assert.equal(outcome.state, 'succeeded');
    const value = (outcome as { value: { runId: string; events: Array<{ eventId: string }> } }).value;
    assert.equal(value.runId, 'run-read');
    assert.deepEqual(value.events.map((entry) => entry.eventId), ['run-read-event-9998', 'run-read-event-9999', 'run-read-event-10000']);
    assert.ok(!JSON.stringify(value).includes('must-not-escape'), 'metadata query never projects event payload bytes');
    assert.equal(value.events.length, 3, 'the SQLite tail query is bounded at the requested limit');
  } finally { fixture.plane.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test('host read registry refuses stale, superseded, and expired durable owner sessions', async () => {
  let clock = now;
  const fixture = await realHostReadRegistry(() => clock);
  try {
    const stale = await fixture.tools.invoke('brief.get', {}, { ...fixture.actual, sessionId: 'other-session' });
    assert.equal(stale.state, 'refused');
    fixture.plane.acquireOwnership({ runId: 'run-read', leaseId: 'read-owner-2', owner: 'astra', sessionId: 'replacement', epoch: 2, issuedAt: now, expiresAt: '2026-09-16T01:00:00.000Z' }, 1);
    assert.equal((await fixture.tools.invoke('brief.get', {}, fixture.actual)).state, 'refused');

    const expired = await realHostReadRegistry(() => clock);
    try {
      clock = '2026-09-16T01:00:00.000Z';
      assert.equal((await expired.tools.invoke('brief.get', {}, expired.actual)).state, 'refused');
    } finally { expired.plane.close(); await rm(expired.directory, { recursive: true, force: true }); }
  } finally { fixture.plane.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test('operator read CLI enforces the streaming response bound and cancels an oversized response', async () => {
  let closed = false;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"state":"succeeded","value":"');
    response.write('x'.repeat(1024 * 1024));
    response.on('close', () => { closed = true; });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(readOperatorToolApi(`http://127.0.0.1:${address.port}`, 'brief.get'), /exceeds the CLI read bound/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closed, true);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('operator read CLI refuses malformed tool result envelopes', async () => {
  const server = createServer((_request, response) => { response.end('{"state":"succeeded","reason":"wrong-shape"}'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await assert.rejects(readOperatorToolApi(`http://127.0.0.1:${address.port}`, 'brief.get'), /invalid result/); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
