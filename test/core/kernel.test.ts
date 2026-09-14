import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { z } from 'zod';
import { openKernel, type KernelOptions } from '../../src/core/index.js';

const now = '2026-09-15T00:00:00Z';
const later = '2026-09-15T01:00:00Z';
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const kinds = { 'test.effect': { payloadSchema: z.object({ value: z.string() }).strict() } };

function databasePath(): string { return join(mkdtempSync(join(tmpdir(), 'helm3-core-')), 'kernel.sqlite'); }
function lease(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    leaseId: 'lease-1', revision: 1, issuedBy: 'human', parentAuthorityId: 'authority-1',
    scope: { repositoryId: 'repo-1', mapNodeIds: ['node-1'] }, allowedActions: ['test.effect'],
    issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [], ...overrides,
  };
}
function command(overrides: Partial<Record<string, unknown>> = {}) {
  const payload = { value: 'safe' };
  const base = {
    schemaVersion: 1, commandId: 'command-1', kind: 'test.effect', idempotencyKey: 'idempotency-1', payloadHash: hash(payload),
    scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'forged-model-actor', runId: 'run-1', origin: 'worker',
    leaseId: 'lease-1', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [], ...overrides,
  };
  return 'payload' in overrides && !('payloadHash' in overrides) ? { ...base, payloadHash: hash(base.payload) } : base;
}
function opened(path = databasePath(), options: Partial<KernelOptions> = {}) {
  let clock = now;
  const result = openKernel({ databasePath: path, kinds, now: () => clock, ...options });
  return { ...result, path, setNow: (value: string) => { clock = value; } };
}
function allowed() { return { actorId: 'trusted-runtime-actor', allowedOrigins: ['worker'] as const }; }
const trueFact = async () => ({ value: true, state: 'known' as const, source: 'git', observedAt: now, subjectVersion: 'sha-1' });
const successfulEffect = { execute: async () => undefined, observe: async () => ({ state: 'succeeded' as const, detail: 'external receipt' }) };

test('admission uses trusted identity, validates kind payload, and preserves idempotent immutable intent', () => {
  const { kernel, host } = opened();
  host.issueAutonomyLease(lease());
  const admitted = kernel.admit(command(), allowed());
  assert.equal(admitted.command.actorId, 'trusted-runtime-actor');
  assert.equal('issueAutonomyLease' in kernel, false);
  assert.equal('acquireOwnership' in kernel, false);
  assert.equal('db' in kernel, false);
  assert.equal(kernel.admit(command(), allowed()).immutableHash, admitted.immutableHash);
  assert.throws(() => kernel.admit(command({ payload: { invalid: true } }), allowed()), /Required/);
  assert.throws(() => kernel.admit(command({ payload: { value: 'different' } }), allowed()), /collision/);
  kernel.close();
});

test('leases fail closed for expiry, revocation, and wrong scope', () => {
  const { kernel, host, setNow } = opened();
  host.issueAutonomyLease(lease());
  setNow(later);
  assert.throws(() => kernel.admit(command(), allowed()), /expired/);
  setNow(now);
  host.revokeAutonomyLease('lease-1');
  assert.throws(() => kernel.admit(command(), allowed()), /revoked/);
  host.issueAutonomyLease(lease({ leaseId: 'lease-2', scope: { repositoryId: 'repo-2', mapNodeIds: [] } }));
  assert.throws(() => kernel.admit(command({ leaseId: 'lease-2' }), allowed()), /scope/);
  kernel.close();
});

test('a false known fact refuses an effect and a stale claimant cannot begin it', async () => {
  const { kernel, host, setNow } = opened();
  host.issueAutonomyLease(lease());
  const withFact = command({ expected: [{ authority: 'git', subject: 'head', version: 'sha-1', predicate: 'is exact head' }] });
  kernel.admit(withFact, allowed());
  const first = kernel.claim('command-1', 'worker-a', '2026-09-15T00:10:00Z');
  await assert.rejects(kernel.perform('command-1', first, async () => ({ value: false, state: 'known', source: 'git', observedAt: now, subjectVersion: 'sha-1' }), successfulEffect), /not freshly known/);
  setNow('2026-09-15T00:11:00Z');
  const second = kernel.claim('command-1', 'worker-b', '2026-09-15T00:20:00Z');
  await assert.rejects(kernel.perform('command-1', first, trueFact, successfulEffect), /claim is stale/);
  assert.equal((await kernel.perform('command-1', second, trueFact, successfulEffect)).state, 'succeeded');
  kernel.close();
});

test('opening a second connection does not recover a live claimant', () => {
  const path = databasePath();
  const first = opened(path);
  first.host.issueAutonomyLease(lease());
  first.kernel.admit(command(), allowed());
  first.kernel.claim('command-1', 'live-worker', '2026-09-15T00:10:00Z');
  const second = opened(path);
  assert.equal(second.kernel.getCommand('command-1')?.status, 'claimed');
  first.kernel.close(); second.kernel.close();
});

test('ownership compare-and-swap fences stale orchestrator commands while supervisor authority survives transfer', async () => {
  const path = databasePath();
  const first = opened(path);
  const second = opened(path);
  first.host.issueAutonomyLease(lease());
  first.host.acquireOwnership({ runId: 'run-1', leaseId: 'controller-1', owner: 'astra', sessionId: 'session-1', epoch: 1, issuedAt: now, expiresAt: later }, 0);
  first.kernel.admit(command({ origin: 'orchestrator', commandId: 'queued-old-epoch', idempotencyKey: 'queued-old-epoch', orchestratorLeaseId: 'controller-1', orchestratorEpoch: 1 }), { actorId: 'trusted-orchestrator', sessionId: 'session-1', allowedOrigins: ['orchestrator'] });
  assert.throws(() => second.host.acquireOwnership({ runId: 'run-1', leaseId: 'controller-race', owner: 'fable', sessionId: 'session-race', epoch: 1, issuedAt: now, expiresAt: later }, 0), /compare-and-swap/);
  first.host.acquireOwnership({ runId: 'run-1', leaseId: 'controller-2', owner: 'fable', sessionId: 'session-2', epoch: 2, issuedAt: now, expiresAt: later }, 1);
  assert.throws(() => first.kernel.claim('queued-old-epoch', 'stale-owner', '2026-09-15T00:10:00Z'), /stale/);
  assert.throws(() => first.kernel.admit(command({ origin: 'orchestrator', orchestratorLeaseId: 'controller-1', orchestratorEpoch: 1 }), { actorId: 'trusted-orchestrator', allowedOrigins: ['orchestrator'] }), /stale/);
  assert.throws(() => first.kernel.admit(command({ origin: 'orchestrator', commandId: 'controller-2-command', idempotencyKey: 'controller-2-command', orchestratorLeaseId: 'controller-2', orchestratorEpoch: 2 }), { actorId: 'trusted-orchestrator', sessionId: 'wrong-session', allowedOrigins: ['orchestrator'] }), /session/);
  const supervisor = command({ origin: 'supervisor', commandId: 'supervisor-1', idempotencyKey: 'supervisor-1' });
  first.kernel.admit(supervisor, { actorId: 'trusted-supervisor', allowedOrigins: ['supervisor'] });
  const claim = first.kernel.claim('supervisor-1', 'supervisor', '2026-09-15T00:10:00Z');
  assert.equal((await first.kernel.perform('supervisor-1', claim, trueFact, successfulEffect)).state, 'succeeded');
  first.kernel.close(); second.kernel.close();
});

test('events and attempts are append-only durable records', () => {
  const { kernel } = opened();
  const event = { eventId: 'event-1', schemaVersion: 1, kind: 'worker.completed', source: 'pi', sourceEventId: 'pi-1', occurredAt: now, recordedAt: now, correlationId: 'run-1', payload: {} } as const;
  kernel.appendEvent(event); kernel.appendEvent(event);
  assert.throws(() => kernel.appendEvent({ ...event, payload: { changed: true } }), /collision/);
  const attempt = {
    attemptId: 'attempt-1', mapNodeId: 'node-1', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder',
    model: 'sol', family: 'openai', provider: 'openai', capability: 'build', poolId: 'subscription', workspace: '/safe/worktree', baseSha: 'abc',
    contextManifestHash: 'sha256:context', leaseId: 'lease-1', sessionIds: ['session-1'], commandIds: ['command-1'], startedAt: now,
    evidenceRefs: [], usageRefs: [], findingRefs: [],
  };
  kernel.appendAttempt(attempt); kernel.appendAttempt(attempt);
  assert.throws(() => kernel.appendAttempt({ ...attempt, role: 'reviewer' }), /immutable/);
  kernel.close();
});

test('a real child-process interruption leaves an unknown effect that cannot be blindly retried', () => {
  const path = databasePath();
  const marker = `${path}.marker`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'test/core/fixtures/interrupted-effect.ts'), path, marker], { encoding: 'utf8' });
  assert.equal(child.status, 91, child.stderr);
  assert.equal(existsSync(marker), true);
  assert.equal(readFileSync(marker, 'utf8'), 'external effect happened');
  const reopened = opened(path);
  reopened.host.recoverAfterRestart();
  assert.equal(reopened.kernel.getCommand('command-1')?.status, 'unknown');
  assert.throws(() => reopened.kernel.claim('command-1', 'retry', '2026-09-15T00:10:00Z'), /not claimable/);
  reopened.kernel.recordObservation('command-1', { state: 'succeeded', detail: 'read external identity' });
  assert.equal(reopened.kernel.getCommand('command-1')?.status, 'succeeded');
  reopened.kernel.close();
});

test('a terminal observation cannot be overwritten and clock rollback refuses new authority', async () => {
  const { kernel, host, setNow } = opened();
  host.issueAutonomyLease(lease());
  kernel.admit(command(), allowed());
  const claim = kernel.claim('command-1', 'worker', '2026-09-15T00:10:00Z');
  assert.equal(claim.generation, 1);
  await kernel.perform('command-1', claim, trueFact, { execute: async () => undefined, observe: async () => ({ state: 'unknown' }) });
  kernel.recordObservation('command-1', { state: 'succeeded' });
  kernel.recordObservation('command-1', { state: 'failed', detail: 'late stale observer' });
  assert.equal(kernel.getCommand('command-1')?.status, 'succeeded');
  setNow('2026-09-15T00:30:00Z');
  kernel.admit(command({ commandId: 'highwater', idempotencyKey: 'highwater' }), allowed());
  setNow('2026-09-15T00:20:00Z');
  assert.throws(() => kernel.admit(command({ commandId: 'rollback', idempotencyKey: 'rollback' }), allowed()), /clock moved backwards/);
  kernel.close();
});
