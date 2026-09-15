import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod/v3';
import { openHost } from '../../src/host/index.js';

const stamp = '2026-09-15T00:00:00Z'; const later = '2099-01-01T00:00:00Z';
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

test('worker.steer creates its own accountable attempt and can persist terminal evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-steer-proof-'));
  const payload = { workerId: 'successor', attemptId: 'successor-attempt' };
  const plane = await openHost({ stateDirectory: root, now: () => stamp, kinds: { 'worker.steer': { payloadSchema: z.object({ workerId: z.string(), attemptId: z.string() }).strict() } } });
  try {
    plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.steer'], expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.steer'], issuedAt: stamp, expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [], protectedReserves: [] });
    plane.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'session', epoch: 1, issuedAt: stamp, expiresAt: later }, 0);
    const command = { schemaVersion: 1 as const, commandId: 'steer-successor', kind: 'worker.steer', idempotencyKey: 'steer-successor', payloadHash: digest(payload), payload, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator' as const, leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] };
    plane.admitOrchestrator(command, { runId: 'run', sessionId: 'session', mode: 'primary' }, 'fable', payload.attemptId);
    assert.equal((await plane.snapshot('run')).attemptLifecycles.find((entry) => entry.attemptId === payload.attemptId)?.state, 'ready');
    const ref = await plane.writeFleetEffect({ runId: 'run', attemptId: payload.attemptId, spawnCommandId: command.commandId, phase: 'terminal-known', text: JSON.stringify({ disposition: 'succeeded' }) });
    assert.match(ref, /host-worker-terminal-known/);
  } finally { plane.close(); await rm(root, { recursive: true, force: true }); }
});
