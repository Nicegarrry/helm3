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
const successfulEffect = { effectId: 'effect-1', execute: async () => undefined, observe: async (input: { commandId: string }) => ({ commandId: input.commandId, effectId: 'effect-1', state: 'succeeded' as const, source: 'test-observer', observedAt: now, evidenceRefs: ['artifact:receipt'], detail: 'external receipt' }) };

test('admission uses trusted identity, validates kind payload, and preserves idempotent immutable intent', () => {
  const { kernel, host } = opened();
  host.issueAutonomyLease(lease());
  const admitted = host.admit(command(), allowed());
  assert.equal(admitted.command.actorId, 'trusted-runtime-actor');
  assert.equal('issueAutonomyLease' in kernel, false);
  assert.equal('acquireOwnership' in kernel, false);
  assert.equal('db' in kernel, false);
  assert.equal(host.admit(command(), allowed()).immutableHash, admitted.immutableHash);
  assert.throws(() => host.admit(command({ payload: { invalid: true } }), allowed()), /Required/);
  assert.throws(() => host.admit(command({ payload: { value: 'different' } }), allowed()), /collision/);
  host.close();
});

test('leases fail closed for expiry, revocation, and wrong scope', () => {
  const { kernel, host, setNow } = opened();
  host.issueAutonomyLease(lease());
  setNow(later);
  assert.throws(() => host.admit(command(), allowed()), /expired/);
  setNow(now);
  host.revokeAutonomyLease('lease-1');
  assert.throws(() => host.admit(command(), allowed()), /revoked/);
  host.issueAutonomyLease(lease({ leaseId: 'lease-2', scope: { repositoryId: 'repo-2', mapNodeIds: [] } }));
  assert.throws(() => host.admit(command({ leaseId: 'lease-2' }), allowed()), /scope/);
  assert.throws(() => host.issueAutonomyLease(lease({ leaseId: 'future-lease', issuedAt: later, expiresAt: '2026-09-15T02:00:00Z' })), /future/);
  assert.throws(() => host.claim('command-1', { executorId: 'bad-expiry' }, 'not-a-timestamp'), /datetime/);
  host.close();
});

test('a false known fact refuses an effect and a stale claimant cannot begin it', async () => {
  const { kernel, host, setNow } = opened();
  host.issueAutonomyLease(lease());
  const withFact = command({ expected: [{ authority: 'git', subject: 'head', version: 'sha-1', predicate: 'is exact head' }] });
  host.admit(withFact, allowed());
  const first = host.claim('command-1', { executorId: 'worker-a' }, '2026-09-15T00:10:00Z');
  await assert.rejects(host.perform('command-1', first, { executorId: 'worker-a' }, async () => ({ value: false, state: 'known', source: 'git', observedAt: now, subjectVersion: 'sha-1' }), successfulEffect), /not freshly known/);
  assert.equal(kernel.getCommand('command-1')?.status, 'refused');
  host.admit(command({ commandId: 'stale-claim', idempotencyKey: 'stale-claim' }), allowed());
  const stale = host.claim('stale-claim', { executorId: 'worker-a' }, '2026-09-15T00:10:00Z');
  setNow('2026-09-15T00:11:00Z');
  const second = host.claim('stale-claim', { executorId: 'worker-b' }, '2026-09-15T00:20:00Z');
  await assert.rejects(host.perform('stale-claim', stale, { executorId: 'worker-a' }, trueFact, successfulEffect), /claim is stale/);
  assert.equal((await host.perform('stale-claim', second, { executorId: 'worker-b' }, trueFact, successfulEffect)).state, 'succeeded');
  host.close();
});

test('opening a second connection does not recover a live claimant', () => {
  const path = databasePath();
  const first = opened(path);
  first.host.issueAutonomyLease(lease());
  first.host.admit(command(), allowed());
  first.host.claim('command-1', { executorId: 'live-worker' }, '2026-09-15T00:10:00Z');
  const second = opened(path);
  assert.equal(second.kernel.getCommand('command-1')?.status, 'claimed');
  first.host.close(); second.host.close();
});

test('ownership compare-and-swap fences stale orchestrator commands while supervisor authority survives transfer', async () => {
  const path = databasePath();
  const first = opened(path);
  const second = opened(path);
  first.host.issueAutonomyLease(lease());
  first.host.acquireOwnership({ runId: 'run-1', leaseId: 'controller-1', owner: 'astra', sessionId: 'session-1', epoch: 1, issuedAt: now, expiresAt: later }, 0);
  first.host.admit(command({ origin: 'orchestrator', commandId: 'queued-old-epoch', idempotencyKey: 'queued-old-epoch', orchestratorLeaseId: 'controller-1', orchestratorEpoch: 1 }), { actorId: 'trusted-orchestrator', sessionId: 'session-1', allowedOrigins: ['orchestrator'] });
  assert.throws(() => second.host.acquireOwnership({ runId: 'run-1', leaseId: 'controller-race', owner: 'fable', sessionId: 'session-race', epoch: 1, issuedAt: now, expiresAt: later }, 0), /compare-and-swap/);
  first.host.acquireOwnership({ runId: 'run-1', leaseId: 'controller-2', owner: 'fable', sessionId: 'session-2', epoch: 2, issuedAt: now, expiresAt: later }, 1);
  assert.throws(() => first.host.claim('queued-old-epoch', { executorId: 'stale-owner' }, '2026-09-15T00:10:00Z'), /stale/);
  assert.throws(() => first.host.admit(command({ origin: 'orchestrator', orchestratorLeaseId: 'controller-1', orchestratorEpoch: 1 }), { actorId: 'trusted-orchestrator', allowedOrigins: ['orchestrator'] }), /stale/);
  assert.throws(() => first.host.admit(command({ origin: 'orchestrator', commandId: 'controller-2-command', idempotencyKey: 'controller-2-command', orchestratorLeaseId: 'controller-2', orchestratorEpoch: 2 }), { actorId: 'trusted-orchestrator', sessionId: 'wrong-session', allowedOrigins: ['orchestrator'] }), /session/);
  const supervisor = command({ origin: 'supervisor', commandId: 'supervisor-1', idempotencyKey: 'supervisor-1' });
  first.host.admit(supervisor, { actorId: 'trusted-supervisor', allowedOrigins: ['supervisor'] });
  const claim = first.host.claim('supervisor-1', { executorId: 'supervisor' }, '2026-09-15T00:10:00Z');
  assert.equal((await first.host.perform('supervisor-1', claim, { executorId: 'supervisor' }, trueFact, successfulEffect)).state, 'succeeded');
  first.host.close(); second.host.close();
});

test('events and attempts are append-only durable records', () => {
  const { host } = opened();
  const event = { eventId: 'event-1', schemaVersion: 1, kind: 'worker.completed', source: 'pi', sourceEventId: 'pi-1', occurredAt: now, recordedAt: now, correlationId: 'run-1', payload: {} } as const;
  host.appendEvent(event); host.appendEvent(event);
  assert.throws(() => host.appendEvent({ ...event, payload: { changed: true } }), /collision/);
  const attempt = {
    attemptId: 'attempt-1', mapNodeId: 'node-1', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder',
    model: 'sol', family: 'openai', provider: 'openai', capability: 'build', poolId: 'subscription', workspace: '/safe/worktree', baseSha: 'abc',
    contextManifestHash: 'sha256:context', leaseId: 'lease-1', sessionIds: ['session-1'], commandIds: ['command-1'], startedAt: now,
    evidenceRefs: [], usageRefs: [], findingRefs: [],
  };
  host.appendAttempt(attempt); host.appendAttempt(attempt);
  assert.throws(() => host.appendAttempt({ ...attempt, role: 'reviewer' }), /immutable/);
  host.close();
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
  assert.throws(() => reopened.host.claim('command-1', { executorId: 'retry' }, '2026-09-15T00:10:00Z'), /not claimable/);
  reopened.host.recordObservation('command-1', { commandId: 'command-1', effectId: 'effect-1', state: 'succeeded', source: 'external-readback', observedAt: now, evidenceRefs: ['artifact:external-id'], detail: 'read external identity' });
  assert.equal(reopened.kernel.getCommand('command-1')?.status, 'succeeded');
  reopened.host.close();
});

test('a terminal observation cannot be overwritten and clock rollback refuses new authority', async () => {
  const { kernel, host, setNow } = opened();
  host.issueAutonomyLease(lease());
  host.admit(command(), allowed());
  const claim = host.claim('command-1', { executorId: 'worker' }, '2026-09-15T00:10:00Z');
  assert.equal(claim.generation, 1);
  await host.perform('command-1', claim, { executorId: 'worker' }, trueFact, { effectId: 'effect-1', execute: async () => undefined, observe: async (input) => ({ commandId: input.commandId, effectId: 'effect-1', state: 'unknown', source: 'observer', observedAt: now, evidenceRefs: ['artifact:unknown'] }) });
  host.recordObservation('command-1', { commandId: 'command-1', effectId: 'effect-1', state: 'succeeded', source: 'readback', observedAt: now, evidenceRefs: ['artifact:success'] });
  host.recordObservation('command-1', { commandId: 'command-1', effectId: 'effect-1', state: 'failed', source: 'late', observedAt: now, evidenceRefs: ['artifact:late'], detail: 'late stale observer' });
  assert.equal(kernel.getCommand('command-1')?.status, 'succeeded');
  assert.equal(kernel.getCommand('command-1')?.observations.length, 2);
  assert.throws(() => host.recordObservation('command-1', { commandId: 'command-1', effectId: 'wrong-effect', state: 'succeeded', source: 'bad', observedAt: now, evidenceRefs: ['artifact:bad'] }), /identity/);
  setNow('2026-09-15T00:30:00Z');
  host.admit(command({ commandId: 'highwater', idempotencyKey: 'highwater' }), allowed());
  setNow('2026-09-15T00:20:00Z');
  assert.throws(() => host.admit(command({ commandId: 'rollback', idempotencyKey: 'rollback' }), allowed()), /clock moved backwards/);
  host.close();
});
