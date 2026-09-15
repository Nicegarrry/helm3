import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostSnapshot } from '../../src/host/index.js';
import { createHostSnapshotSource, projectHostSnapshot } from '../../src/operator/host-source.js';
import type { GitHubMapSnapshot } from '../../src/tracker/index.js';

const now = '2026-09-15T10:00:00.000Z';
const host: HostSnapshot = {
  runId: 'run', commands: [], attempts: [], autonomyLeases: [], reservations: [], artifacts: [], recoveryRefs: [],
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
});

test('tracker outage leaves durable host view readable and source refreshes on every read', async () => {
  let reads = 0;
  const source = createHostSnapshotSource({ host: { async snapshot() { reads++; return host; } }, runId: 'run', evidenceMode: 'fixture', now: () => now,
    map: { async snapshot() { throw new Error('offline'); } } });
  assert.equal((await source.read()).map, null); await source.read(); assert.equal(reads, 2);
});
