import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod/v3';
import { openHost } from '../../src/host/index.js';
import { appendHostMapTools, createRegisteredGateClosureValidator, mapClosePayloadSchema, mapUpdatePayloadSchema } from '../../src/host/map-tools.js';
import { createHostGateTool, gateRunPayloadSchema } from '../../src/host/gate-tools.js';
import { AstraLoopbackMcpTransport, FableDriver, HelmToolRegistry, type HelmToolExecutionContext, type OrchestratorArtifacts } from '../../src/runtime/orchestrator/index.js';
import type { TrackerCommandTransport } from '../../src/tracker/index.js';

const before = '2026-09-15T00:00:00Z';
const after = '2026-09-15T00:01:00Z';
const later = '2026-09-16T00:00:00Z';
const context = { runId: 'map-run', sessionId: 'map-session', mode: 'primary' as const };
const exec = promisify(execFile);

function transport(input: { failPatch?: boolean; failReadback?: boolean } = {}) {
  const issues = new Map<number, { number: number; title: string; body: string; state: 'open' | 'closed'; updated_at: string; html_url: string; repository_url: string }>();
  const issue = (number: number, patch = {}) => ({ number, title: `Issue ${number}`, body: `Body ${number}`, state: 'open' as const, updated_at: before, html_url: `https://github.com/owner/repo/issues/${number}`, repository_url: 'https://api.github.com/repos/owner/repo', ...patch });
  issues.set(1, issue(1)); issues.set(2, issue(2)); issues.set(9, issue(9, { state: 'closed' as const }));
  let patches = 0; let patched = false;
  const value: TrackerCommandTransport = async (argv) => {
    const method = argv[2]!; const path = argv[3]!; const match = path.match(/^repos\/owner\/repo\/issues\/(\d+)(?:\/(sub_issues|dependencies\/blocked_by))?/);
    if (!match) return { ok: false, stdout: '', stderr: 'unexpected' };
    const number = Number(match[1]); const relation = match[2];
    if (method === 'GET' && relation === 'sub_issues') return { ok: true, stdout: JSON.stringify(number === 1 ? [issues.get(2)] : []), stderr: '' };
    if (method === 'GET' && relation === 'dependencies/blocked_by') return { ok: true, stdout: JSON.stringify(number === 2 ? [issues.get(9)] : []), stderr: '' };
    if (method === 'GET') { if (input.failReadback && patched && number === 2) return { ok: false, stdout: '', stderr: 'readback lost' }; return { ok: true, stdout: JSON.stringify(issues.get(number)), stderr: '' }; }
    if (method === 'PATCH') { patches += 1; if (input.failPatch) return { ok: false, stdout: '', stderr: 'lost' }; const fields = Object.fromEntries(argv.slice(4).reduce<string[][]>((all, entry, index, values) => entry === '-f' && values[index + 1] ? [...all, values[index + 1]!.split(/=(.*)/s)] : all, [])); const current = issues.get(number)!; const next = { ...current, ...(fields.title ? { title: fields.title } : {}), ...(fields.body ? { body: fields.body } : {}), ...(fields.state ? { state: fields.state as 'open' | 'closed' } : {}), updated_at: after }; issues.set(number, next); patched = true; return { ok: true, stdout: JSON.stringify(next), stderr: '' }; }
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  return { value, patches: () => patches };
}

async function fixture(input: { failPatch?: boolean; failReadback?: boolean; evidenceFails?: boolean; gateFails?: boolean; transferOnSecondEvidenceCheck?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'helm3-map-tools-'));
  const plane = await openHost({ stateDirectory: directory, now: () => before, kinds: { 'map.update': { payloadSchema: mapUpdatePayloadSchema }, 'map.close': { payloadSchema: mapClosePayloadSchema }, 'gate.run': { payloadSchema: gateRunPayloadSchema }, 'worker.spawn': { payloadSchema: z.object({ workerId: z.string() }).strict() } } });
  plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'owner/repo', mapNodeIds: ['2'], allowedActions: ['map.update', 'map.close', 'gate.run', 'worker.spawn'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
  plane.recordAutonomyLease({ leaseId: 'autonomy', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'owner/repo', mapNodeIds: ['2'] }, allowedActions: ['map.update', 'map.close', 'gate.run', 'worker.spawn'], issuedAt: before, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
  plane.acquireOwnership({ runId: context.runId, leaseId: 'owner', owner: 'fable', sessionId: context.sessionId, epoch: 1, issuedAt: before, expiresAt: later }, 0);
  const workspace = join(directory, 'proof-workspace'); await mkdir(workspace, { recursive: true }); await exec('git', ['init', workspace]); await exec('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.invalid']); await exec('git', ['-C', workspace, 'config', 'user.name', 'fixture']); await writeFile(join(workspace, 'proof.txt'), 'green\n'); await exec('git', ['-C', workspace, 'add', '.']); await exec('git', ['-C', workspace, 'commit', '-m', 'proof']); const canonicalWorkspace = await realpath(workspace); const proofHead = (await exec('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim();
  const common = { schemaVersion: 1 as const, scope: { repositoryId: 'owner/repo', mapNodeId: '2' }, actorId: 'fable', runId: context.runId, origin: 'orchestrator' as const, leaseId: 'autonomy', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: before, notAfter: later, expected: [] };
  const predecessor = plane.admitOrchestrator({ ...common, commandId: 'proof-predecessor', kind: 'worker.spawn', idempotencyKey: 'proof-predecessor', payloadHash: `sha256:${createHash('sha256').update(JSON.stringify({ workerId: 'proof-worker' })).digest('hex')}`, payload: { workerId: 'proof-worker' }, requiredEvidence: [] }, context, 'fable');
  const gateTool = createHostGateTool({ context, authorize: async (value) => { plane.artifactsFor(value); }, host: plane, catalog: { async resolve() { return { gateId: 'proof', workerId: 'proof-worker', repositoryId: 'owner/repo', mapNodeId: '2', workspaceId: 'proof-workspace', workspace: canonicalWorkspace, expectedHead: proofHead, acceptanceVersion: 'proof-v1', checks: [{ name: 'green proof', executable: process.execPath, args: ['-e', input.gateFails ? 'process.exit(7)' : 'process.exit(0)'], timeoutMs: 5000 }], environment: { PATH: process.env.PATH ?? '' } }; } }, command: { actorId: 'fable', leaseId: 'autonomy', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: () => before, notAfter: () => later, commandId: () => 'proof-gate' }, executor: { executorId: 'proof-gate' }, claimExpiresAt: () => later });
  const gateResult = await gateTool.execute({ gateId: 'proof', workerId: 'proof-worker', expectedHead: proofHead }, context); assert.equal(gateResult.state, 'succeeded'); assert.equal((gateResult as { value: { gateState: string } }).value.gateState, input.gateFails ? 'failed' : 'succeeded'); const gate = (await plane.snapshot(context.runId)).commands.find((command) => command.command.commandId === 'proof-gate')!; const gateEvidenceRef = gate.observations[0]!.evidenceRefs[0]!;
  const fake = transport(input); let validation = 0;
  const validator = createRegisteredGateClosureValidator({ host: plane, proofs: input.evidenceFails ? [] : [{ evidenceRef: gateEvidenceRef, runId: context.runId, repositoryId: 'owner/repo', mapNodeId: '2', gateCommandId: gate.command.commandId, predecessorCommandId: predecessor.command.commandId, workerId: 'proof-worker', workspace: canonicalWorkspace, expectedHead: proofHead }] });
  const registryFor = (actual: HelmToolExecutionContext, epoch = 1) => appendHostMapTools(new HelmToolRegistry([]), { context: actual, authorize: async (value) => { plane.artifactsFor(value); }, host: plane, catalog: { async resolve(node) { if (node !== 'node-2') throw new Error('foreign'); return { node, repositoryId: 'owner/repo', parentIssue: 1, issueNumber: 2 }; } }, transport: fake.value, command: { actorId: 'fable', leaseId: 'autonomy', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: epoch, plannedAt: () => before, notAfter: () => later }, executor: { executorId: 'host-map' }, claimExpiresAt: () => later, closureEvidence: { async validate(value) { validation += 1; await validator.validate(value); if (input.transferOnSecondEvidenceCheck && validation === 2) plane.acquireOwnership({ runId: context.runId, leaseId: 'owner', owner: 'astra', sessionId: 'replacement', epoch: 2, issuedAt: before, expiresAt: later }, 1); } } });
  const tools = registryFor(context);
  const driverTools = new HelmToolRegistry(tools.all().map((entry) => ({ ...entry, async execute(value, actual) { const owner = (await plane.snapshot(actual.runId)).ownership; return registryFor(actual, owner?.epoch ?? 0).invoke(entry.name, value, actual); } })));
  return { directory, plane, tools, driverTools, fake, transport: fake.value, gateEvidenceRef, validations: () => validation };
}

test('map.update uses Core admission, mutator readback receipt, and stable durable idempotency', async () => {
  const value = await fixture();
  try {
    const first = await value.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, title: 'Renamed' }, context);
    assert.equal(first.state, 'succeeded', JSON.stringify(first)); assert.equal(value.fake.patches(), 1);
    const second = await value.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, title: 'Renamed' }, context);
    assert.equal(second.state, 'succeeded'); assert.equal(value.fake.patches(), 1, 'a replay reads the durable receipt and cannot PATCH twice');
    const snapshot = await value.plane.snapshot(context.runId); const command = snapshot.commands.find((item) => item.command.kind === 'map.update' && item.command.commandId !== 'proof-predecessor'); assert.equal(command?.status, 'succeeded'); assert.equal(command?.observations[0]?.evidenceRefs.length, 1);
  } finally { value.plane.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test('successful PATCH with unavailable readback stays unknown across a host reopen and is never replayed', async () => {
  const value = await fixture({ failReadback: true });
  try {
    const intent = { node: 'node-2', expectedRevision: before, title: 'Readback uncertain' };
    const first = await value.tools.invoke('map.update', intent, context);
    assert.equal(first.state, 'unknown'); assert.equal(value.fake.patches(), 1);
    value.plane.close();
    const reopened = await openHost({ stateDirectory: value.directory, now: () => before, kinds: { 'map.update': { payloadSchema: mapUpdatePayloadSchema }, 'map.close': { payloadSchema: mapClosePayloadSchema }, 'gate.run': { payloadSchema: gateRunPayloadSchema }, 'worker.spawn': { payloadSchema: z.object({ workerId: z.string() }).strict() } } });
    try {
      const tools = appendHostMapTools(new HelmToolRegistry([]), { context, authorize: async (actual) => { reopened.artifactsFor(actual); }, host: reopened, catalog: { async resolve(node) { if (node !== 'node-2') throw new Error('foreign'); return { node, repositoryId: 'owner/repo', parentIssue: 1, issueNumber: 2 }; } }, transport: value.transport, command: { actorId: 'fable', leaseId: 'autonomy', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: () => before, notAfter: () => later }, executor: { executorId: 'host-map' }, claimExpiresAt: () => later, closureEvidence: { async validate() { throw new Error('unused'); } } });
      const replay = await tools.invoke('map.update', intent, context);
      assert.equal(replay.state, 'unknown'); assert.equal(value.fake.patches(), 1, 'durable unknown must reconcile rather than PATCH again');
    } finally { reopened.close(); }
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test('map.close binds only verified evidence while invalid input and uncertain writes never become success', async () => {
  const evidence = await fixture({ evidenceFails: true }); const unknown = await fixture({ failPatch: true }); const closed = await fixture(); const red = await fixture({ gateFails: true }); const stale = await fixture({ transferOnSecondEvidenceCheck: true });
  try {
    const refused = await evidence.tools.invoke('map.close', { node: 'node-2', expectedRevision: before, rationale: 'Done.', evidenceRefs: ['foreign:claim'], resolvedDependencies: ['owner/repo#9'] }, context);
    assert.equal(refused.state, 'refused'); assert.equal(evidence.fake.patches(), 0);
    const malformed = await evidence.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, command: 'PATCH' }, context);
    assert.equal(malformed.state, 'refused'); assert.equal(evidence.fake.patches(), 0);
    const result = await unknown.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, title: 'Maybe' }, context);
    assert.equal(result.state, 'unknown', JSON.stringify(result)); assert.equal(unknown.fake.patches(), 1);
    const replay = await unknown.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, title: 'Maybe' }, context);
    assert.equal(replay.state, 'unknown'); assert.equal(unknown.fake.patches(), 1);
    const success = await closed.tools.invoke('map.close', { node: 'node-2', expectedRevision: before, rationale: 'Verified gate passed.', evidenceRefs: [closed.gateEvidenceRef], resolvedDependencies: ['owner/repo#9'] }, context);
    assert.equal(success.state, 'succeeded', JSON.stringify(success)); assert.equal(closed.fake.patches(), 1); assert.equal(closed.validations(), 2, 'closure evidence is checked before admission and again at effect time');
    const redClose = await red.tools.invoke('map.close', { node: 'node-2', expectedRevision: before, rationale: 'Red gate must not close.', evidenceRefs: [red.gateEvidenceRef], resolvedDependencies: ['owner/repo#9'] }, context);
    assert.equal(redClose.state, 'refused'); assert.equal(red.fake.patches(), 0, 'a failed actual gate cannot close the Map');
    const staleClose = await stale.tools.invoke('map.close', { node: 'node-2', expectedRevision: before, rationale: 'Owner changed.', evidenceRefs: [stale.gateEvidenceRef], resolvedDependencies: ['owner/repo#9'] }, context);
    assert.equal(staleClose.state, 'unknown'); assert.equal(stale.fake.patches(), 0, 'ownership transfer after the second evidence check fences PATCH');
  } finally { for (const value of [evidence, unknown, closed, red, stale]) { value.plane.close(); await rm(value.directory, { recursive: true, force: true }); } }
});

test('real Fable callbacks and Astra loopback invoke the same HostCore Map tools', async () => {
  const fableFixture = await fixture(); const astraFixture = await fixture();
  const artifacts: OrchestratorArtifacts = { async readText() { return 'objective'; }, async saveInvocation() { return 'invocation'; }, async saveRecoveryBundle() { return 'bundle'; }, async loadRecoveryBundle() { throw new Error('unused'); } };
  try {
    const claude = await import('@anthropic-ai/claude-agent-sdk'); let definitions: Array<{ name: string; handler(value: Record<string, unknown>, extra: unknown): Promise<unknown> }> = []; const fableResults: unknown[] = [];
    const fable = new FableDriver(artifacts, fableFixture.driverTools, { async assertCurrent() {} }, { async capture() { return { recoveryStateRef: 'recovery' }; }, async restore() { return 'recovery'; } }, { env: { PATH: process.env.PATH ?? '' } }, {
      ...claude, createSdkMcpServer(value) { definitions = value.tools as typeof definitions; return claude.createSdkMcpServer(value); }, query: (() => (async function* () { fableResults.push(await definitions.find((item) => item.name === 'map.update')!.handler({ node: 'node-2', expectedRevision: before, title: 'Fable update' }, {})); fableResults.push(await definitions.find((item) => item.name === 'map.close')!.handler({ node: 'node-2', expectedRevision: after, rationale: 'Fable evidence verified.', evidenceRefs: [fableFixture.gateEvidenceRef], resolvedDependencies: ['owner/repo#9'] }, {})); yield { type: 'result', subtype: 'success', is_error: false }; })()) as never,
    });
    const started = await fable.start({ runId: context.runId, contextRefs: [], mode: 'primary' });
    fableFixture.plane.acquireOwnership({ runId: context.runId, leaseId: 'owner', owner: 'fable', sessionId: started.sessionId, epoch: 2, issuedAt: before, expiresAt: later }, 1);
    await fable.invoke({ sessionId: started.sessionId, objectiveRef: 'objective', contextRefs: [] });
    assert.equal(definitions.length, 2); assert.match(JSON.stringify(fableResults), /succeeded/); assert.equal(fableFixture.fake.patches(), 2);

    const astraContext = { ...context, sessionId: 'astra-loopback' };
    astraFixture.plane.acquireOwnership({ runId: context.runId, leaseId: 'owner', owner: 'astra', sessionId: astraContext.sessionId, epoch: 2, issuedAt: before, expiresAt: later }, 1);
    const bridge = await AstraLoopbackMcpTransport.open({ registry: astraFixture.driverTools, guard: { async assertCurrent() {} }, session: astraContext });
    try {
      const [{ Client }, { StreamableHTTPClientTransport }, { CallToolResultSchema }] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'), import('@modelcontextprotocol/sdk/types.js')]);
      const [, token] = Object.entries(bridge.env)[0]!; const clientTransport = new StreamableHTTPClientTransport(new URL(bridge.config.mcp_servers.helm.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }); const client = new Client({ name: 'map-tools', version: '1' }); await client.connect(clientTransport);
      try {
        const update = await client.callTool({ name: 'map.update', arguments: { node: 'node-2', expectedRevision: before, title: 'Astra update' } }, CallToolResultSchema);
        const close = await client.callTool({ name: 'map.close', arguments: { node: 'node-2', expectedRevision: after, rationale: 'Astra evidence verified.', evidenceRefs: [astraFixture.gateEvidenceRef], resolvedDependencies: ['owner/repo#9'] } }, CallToolResultSchema);
        assert.equal(update.isError, false); assert.equal(close.isError, false); assert.equal(astraFixture.fake.patches(), 2);
      } finally { await clientTransport.close(); }
    } finally { await bridge.close(); }
  } finally { for (const value of [fableFixture, astraFixture]) { value.plane.close(); await rm(value.directory, { recursive: true, force: true }); } }
});
