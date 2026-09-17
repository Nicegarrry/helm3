import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostSnapshot } from '../../src/host/index.js';
import { createHostSnapshotSource, projectHostSnapshot } from '../../src/operator/host-source.js';
import type { GitHubMapSnapshot } from '../../src/tracker/index.js';
import { createOperatorServer, listenOperatorServer } from '../../src/operator/server.js';
import { operatorCli, readOperatorApi } from '../../src/operator/cli.js';

const now = '2026-09-15T10:00:00.000Z';
const host: HostSnapshot = {
  runId: 'run', commands: [], attempts: [], attemptLifecycles: [], autonomyLeases: [], reservations: [], artifacts: [], recoveryRefs: [],
  ownership: { runId: 'run', leaseId: 'owner', owner: 'astra', sessionId: 'session', epoch: 2, issuedAt: '2026-09-15T09:00:00.000Z', expiresAt: now },
};
const map: GitHubMapSnapshot = { source: { repository: 'owner/repo', parentIssue: 1 }, observedAt: now, completeness: 'incomplete', nodes: [], frontier: [], incomplete: [{ code: 'transport_failed', subject: 'GitHub' }] };

test('host projection keeps incomplete Map, quota, decisions and expired authority explicit', () => {
  const result = projectHostSnapshot(host, map, now, 'fixture');
  assert.equal(result.source.kind, 'helm-log'); assert.equal(result.source.evidenceMode, 'fixture');
  assert.equal(result.map?.state, 'incomplete'); assert.equal(result.map?.frontier, null);
  assert.equal(result.run.leases.orchestrator.state, 'expired'); assert.equal(result.run.leases.autonomy.state, 'unknown');
  assert.equal(result.needsYou, null); assert.equal(result.quality.gate.passed, null);
  assert.ok(result.unknowns.some((reason) => reason.includes('Provider quota')));
  assert.doesNotMatch(JSON.stringify(result), /recoveryRefs|rawArtifacts|payloadHash/);
  const future = projectHostSnapshot({ ...host, ownership: { ...host.ownership!, issuedAt: '2026-09-16T09:00:00.000Z', expiresAt: '2026-09-17T10:00:00.000Z' } }, null, now, 'fixture');
  assert.equal(future.run.leases.orchestrator.state, 'unknown');
  const malformed = projectHostSnapshot({ ...host, ownership: { ...host.ownership!, issuedAt: 'invalid' } }, null, now, 'fixture');
  assert.equal(malformed.run.leases.orchestrator.state, 'unknown');
});

test('reservations are not reported as usage or subscription headroom; revoked lease cannot appear active', () => {
  const input: HostSnapshot = { ...host, reservations: [
    { commandId: 'a', leaseId: 'lease', poolId: 'pool', unit: 'USD', reserved: 0.5, settledActual: 0.25, state: 'settled' },
    { commandId: 'b', leaseId: 'lease', poolId: 'pool', unit: 'USD', reserved: 0.75, state: 'reserved' },
  ], autonomyLeases: [{ revoked: true, lease: {
    leaseId: 'lease', revision: 1, issuedBy: 'astra', parentAuthorityId: 'human', scope: { repositoryId: 'owner/repo', mapNodeIds: [] },
    allowedActions: [], issuedAt: '2026-09-15T09:00:00.000Z', expiresAt: '2026-09-16T10:00:00.000Z',
    maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [],
  } }] };
  const result = projectHostSnapshot(input, null, now, 'authoritative');
  assert.equal(result.run.leases.autonomy.state, 'revoked');
  assert.equal(result.resources.units[0].used, null);
  assert.equal(result.resources.units[0].reserved, 0.75);
  assert.equal(result.resources.units[0].limit, null);
  const settled = projectHostSnapshot({ ...input, reservations: input.reservations.slice(0, 1) }, null, now, 'authoritative');
  assert.equal(settled.resources.units[0].used, 0.25); assert.equal(settled.resources.units[0].reserved, 0);
  const futureLease = { ...input.autonomyLeases[0], revoked: false, lease: { ...input.autonomyLeases[0].lease, issuedAt: '2026-09-16T09:00:00.000Z' } };
  assert.equal(projectHostSnapshot({ ...input, autonomyLeases: [futureLease] }, null, now, 'fixture').run.leases.autonomy.state, 'unknown');
});

test('tracker outage leaves durable host view readable and source refreshes on every read', async () => {
  let reads = 0;
  const source = createHostSnapshotSource({ host: { async snapshot() { reads++; return host; } }, runId: 'run', evidenceMode: 'fixture', now: () => now,
    map: { async snapshot() { throw new Error('offline'); } } });
  assert.equal((await source.read()).map, null); await source.read(); assert.equal(reads, 2);
});

test('a durable stop observation is visible without inventing an accepted attempt outcome', () => {
  const attempt = { attemptId: 'attempt', mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'faux', capability: 'fixture', poolId: 'requests', workspace: '/fixture', baseSha: 'abc', contextManifestHash: 'fixture', leaseId: 'lease', sessionIds: [], commandIds: [], startedAt: now, evidenceRefs: [], usageRefs: [], findingRefs: [] };
  const result = projectHostSnapshot({ ...host, attempts: [attempt], attemptLifecycles: [{ attemptId: 'attempt', state: 'finished', executionReleased: true }] }, null, now, 'fixture');
  assert.equal(result.attempts[0].state, 'stopped');
  assert.equal(result.attempts[0].outcome, null);
  assert.equal(result.attempts[0].endedAt, null);
});

test('CLI reads identical host projection through loopback API and refuses remote origins', async () => {
  const snapshot = projectHostSnapshot(host, map, now, 'fixture');
  const server = createOperatorServer({ read: async () => snapshot });
  const { port } = await listenOperatorServer(server);
  try {
    const origin = `http://127.0.0.1:${port}`;
    assert.deepEqual(JSON.parse(await operatorCli(['--url', origin, '--json'])), snapshot);
    const html = await fetch(origin).then((response) => response.text());
    assert.match(html, /run/); assert.match(html, /expired/); assert.match(html, /fixture/);
    await assert.rejects(readOperatorApi('https://example.invalid'), /explicit/);
    await assert.rejects(readOperatorApi(`http://127.0.0.1:${port}/other`), /explicit/);
    await assert.rejects(operatorCli(['--url', origin, '--write']), /Usage/);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('released unknown execution displays stopped without inventing an outcome', () => {
  const attempt = { attemptId: 'attempt', mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'faux', capability: 'fixture', poolId: 'requests', workspace: '/fixture', baseSha: 'abc', contextManifestHash: 'fixture', leaseId: 'lease', sessionIds: [], commandIds: [], startedAt: now, evidenceRefs: [], usageRefs: [], findingRefs: [] };
  const result = projectHostSnapshot({ ...host, attempts: [attempt], attemptLifecycles: [{ attemptId: 'attempt', state: 'unknown', executionReleased: true }] }, null, now, 'fixture');
  assert.equal(result.attempts[0].state, 'stopped');
  assert.equal(result.attempts[0].outcome, null);
  assert.equal(result.attempts[0].endedAt, null);
});
