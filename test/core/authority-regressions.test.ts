import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { z } from 'zod';
import { openKernel, type KernelKind, type KernelOptions } from '../../src/core/index.js';

const now = '2026-09-15T00:00:00Z';
const later = '2026-09-15T01:00:00Z';
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const pool = { poolId: 'pool-1', unit: 'requests' };

const resourceKind: KernelKind = {
  payloadSchema: z.object({ value: z.string(), upper: z.number().nonnegative(), modelId: z.string().optional() }).strict(),
  requiresResourceEnforcement: true,
  resourceRequest: (payload) => {
    const input = payload as { upper: number };
    return { ...pool, upperBound: input.upper, consumer: 'worker' as const };
  },
};
const modelResourceKind: KernelKind = {
  ...resourceKind,
  modelSelection: (payload) => ({ modelId: (payload as { modelId: string }).modelId, requiredCapabilities: ['build'], role: 'worker' }),
};
const plainWorkerKind: KernelKind = { payloadSchema: z.object({ value: z.string() }).strict() };

function databasePath(): string { return join(mkdtempSync(join(tmpdir(), 'helm3-authority-')), 'kernel.sqlite'); }
function command(overrides: Record<string, unknown> = {}) {
  const payload = { value: 'safe', upper: 1 };
  const input = {
    schemaVersion: 1, commandId: 'command-1', kind: 'test.effect', idempotencyKey: 'key-1', payloadHash: hash(payload),
    scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'untrusted', runId: 'run-1', origin: 'worker',
    leaseId: 'lease-1', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [], ...overrides,
  };
  return 'payload' in overrides && !('payloadHash' in overrides) ? { ...input, payloadHash: hash(input.payload) } : input;
}
function grant(overrides: Record<string, unknown> = {}) {
  return {
    authorityId: 'authority-1', repositoryId: 'repo-1', mapNodeIds: ['node-1'], allowedActions: ['test.effect'], expiresAt: later,
    maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [{ ...pool, limit: 10 }], protectedReserves: [], ...overrides,
  };
}
function lease(overrides: Record<string, unknown> = {}) {
  return {
    leaseId: 'lease-1', revision: 1, issuedBy: 'human', parentAuthorityId: 'authority-1',
    scope: { repositoryId: 'repo-1', mapNodeIds: ['node-1'] }, allowedActions: ['test.effect'], issuedAt: now, expiresAt: later,
    maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [{ ...pool, limit: 10 }], protectedReserves: [], ...overrides,
  };
}
function opened(kinds: Record<string, KernelKind>, authority = grant(), options: Partial<KernelOptions> = {}) {
  const result = openKernel({ databasePath: databasePath(), kinds, now: () => now, ...options });
  result.host.declareHumanAuthority(authority);
  return result;
}
const caller = (attemptId = 'attempt-1') => ({ actorId: 'trusted-worker', attemptId, allowedOrigins: ['worker'] as const });
const observedSuccess = (commandId: string, effectId = 'effect-1') => ({ commandId, effectId, state: 'succeeded' as const, source: 'test', observedAt: now, evidenceRefs: ['artifact:receipt'] });

test('settled actual use remains charged and a stricter lease reserve protects its own pool', async () => {
  const { kernel, host } = opened({ 'test.effect': resourceKind });
  host.issueAutonomyLease(lease());
  host.admit(command({ commandId: 'first', idempotencyKey: 'first', payload: { value: 'a', upper: 8 } }), caller('a'));
  const claim = host.claim('first', { executorId: 'worker' }, '2026-09-15T00:10:00Z');
  await host.perform('first', claim, { executorId: 'worker' }, async () => ({ value: true, state: 'known', source: 'test', observedAt: now }), {
    effectId: 'effect-1', execute: async () => undefined, observe: async () => observedSuccess('first'),
  });
  host.settleResource('first', { state: 'known', amount: 6 });
  assert.equal(kernel.getCommand('first')?.status, 'succeeded');
  assert.throws(() => host.admit(command({ commandId: 'over-cap', idempotencyKey: 'over-cap', payload: { value: 'b', upper: 5 } }), caller('b')), /(cap|reserve)/);
  host.close();

  const reserved = opened({ 'test.effect': resourceKind }, grant({ authorityId: 'authority-2', protectedReserves: [] }));
  reserved.host.issueAutonomyLease(lease({ leaseId: 'lease-2', parentAuthorityId: 'authority-2', protectedReserves: [{ ...pool, amount: 4 }] }));
  assert.throws(() => reserved.host.admit(command({ commandId: 'lease-reserve', idempotencyKey: 'lease-reserve', leaseId: 'lease-2', payload: { value: 'c', upper: 7 } }), caller('c')), /protected orchestrator reserve/);
  reserved.host.close();
});

test('a lease cannot turn a nonempty parent map into a wildcard', () => {
  const { host } = opened({ 'test.effect': resourceKind });
  assert.throws(() => host.issueAutonomyLease(lease({ scope: { repositoryId: 'repo-1', mapNodeIds: [] } })), /map scope/);
  host.close();
});

test('opening a database created before typed authority columns migrates only the missing columns', () => {
  const path = databasePath();
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE commands (
      command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, repository_id TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      immutable_json TEXT NOT NULL, immutable_hash TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
      status TEXT NOT NULL, claim_token TEXT, claim_executor_id TEXT, claim_generation INTEGER NOT NULL DEFAULT 0, claim_expires_at TEXT, effect_id TEXT,
      UNIQUE(run_id, repository_id, kind, idempotency_key)
    );
    CREATE TABLE resource_reservations (command_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, parent_authority_id TEXT NOT NULL, pool_id TEXT NOT NULL, unit TEXT NOT NULL, reserved REAL NOT NULL, settled_actual REAL, state TEXT NOT NULL);
    CREATE TABLE model_facts (model_id TEXT PRIMARY KEY, bytes TEXT NOT NULL);
  `);
  legacy.prepare(`INSERT INTO model_facts (model_id, bytes) VALUES (?, ?)`).run('legacy-model', JSON.stringify({ modelId: 'legacy-model', provider: 'provider', poolId: 'pool-1', enabled: true, capabilities: ['build'], roles: ['worker'], availability: 'known_available' }));
  legacy.close();
  const { host } = opened({ 'test.effect': resourceKind }, grant(), { databasePath: path });
  host.putModelFact({ modelId: 'legacy-model', provider: 'provider', poolId: 'pool-1', enabled: true, capabilities: ['build'], roles: ['worker'], availability: 'known_available', factVersion: 1, observedAt: now });
  host.issueAutonomyLease(lease());
  host.admit(command(), caller('migrated-attempt'));
  host.close();
});

test('capacity is charged to durable attempts across runs, leases, and quarantine', () => {
  const { host } = opened({ 'test.effect': resourceKind });
  host.close();
  const constrained = opened({ 'test.effect': resourceKind }, grant({ maxConcurrency: 1 }));
  constrained.host.issueAutonomyLease(lease({ maxConcurrency: 1 }));
  constrained.host.issueAutonomyLease(lease({ leaseId: 'lease-2', maxConcurrency: 1 }));
  constrained.host.admit(command({ commandId: 'unknown', idempotencyKey: 'unknown', payload: { value: 'a', upper: 1 } }), caller('attempt-a'));
  const claim = constrained.host.claim('unknown', { executorId: 'worker-a' }, '2026-09-15T00:10:00Z');
  constrained.host.reportWorkerStop('unknown', 'unknown');
  assert.throws(() => constrained.host.claim('unknown', { executorId: 'worker-b' }, '2026-09-15T00:20:00Z'), /not claimable/);
  constrained.host.admit(command({ commandId: 'other-run', idempotencyKey: 'other-run', runId: 'run-2', leaseId: 'lease-2', payload: { value: 'b', upper: 1 } }), caller('attempt-b'));
  assert.throws(() => constrained.host.claim('other-run', { executorId: 'worker-b' }, '2026-09-15T00:20:00Z'), /concurrency/);
  assert.equal(claim.commandId, 'unknown');
  constrained.host.close();
});

test('resource requests require a stable attempt id and enforce lease and parent node caps by distinct typed identity', () => {
  const { host } = opened({ 'test.effect': resourceKind });
  host.close();
  const constrained = opened({ 'test.effect': resourceKind }, grant({ maxAttemptsPerNode: 1 }));
  constrained.host.issueAutonomyLease(lease({ maxAttemptsPerNode: 1 }));
  assert.throws(() => constrained.host.admit(command({ commandId: 'missing', idempotencyKey: 'missing', payload: { value: 'a', upper: 1 } }), { actorId: 'trusted-worker', allowedOrigins: ['worker'] }), /attempt identity/);
  constrained.host.admit(command({ commandId: 'tool-one', idempotencyKey: 'tool-one', payload: { value: 'a', upper: 1 } }), caller('one'));
  constrained.host.admit(command({ commandId: 'tool-two', idempotencyKey: 'tool-two', payload: { value: 'b', upper: 1 } }), caller('one'));
  constrained.host.issueAutonomyLease(lease({ leaseId: 'lease-renewal', maxAttemptsPerNode: 1 }));
  assert.throws(() => constrained.host.admit(command({ commandId: 'other-attempt', idempotencyKey: 'other-attempt', leaseId: 'lease-renewal', payload: { value: 'c', upper: 1 } }), caller('two')), /attempt cap/);
  constrained.host.close();
});

test('resource-free worker commands bind attempts, retain capacity across command gaps, and release only on a trusted finish', async () => {
  const { kernel, host } = opened({ 'test.effect': plainWorkerKind }, grant({ maxConcurrency: 1, maxAttemptsPerNode: 2 }));
  host.issueAutonomyLease(lease({ maxConcurrency: 1, maxAttemptsPerNode: 2, poolLimits: [] }));
  host.admit(command({ commandId: 'first-tool', idempotencyKey: 'first-tool', payload: { value: 'a' } }), caller('attempt-a'));
  const first = host.claim('first-tool', { executorId: 'worker-a' }, '2026-09-15T00:10:00Z');
  await host.perform('first-tool', first, { executorId: 'worker-a' }, async () => ({ value: true, state: 'known', source: 'test', observedAt: now }), { effectId: 'first-effect', execute: async () => undefined, observe: async () => observedSuccess('first-tool', 'first-effect') });
  host.admit(command({ commandId: 'same-attempt-tool', idempotencyKey: 'same-attempt-tool', payload: { value: 'b' } }), caller('attempt-a'));
  assert.equal(host.claim('same-attempt-tool', { executorId: 'worker-a' }, '2026-09-15T00:20:00Z').commandId, 'same-attempt-tool');
  host.reportWorkerStop('same-attempt-tool', 'stopped');
  host.admit(command({ commandId: 'other-attempt-tool', idempotencyKey: 'other-attempt-tool', payload: { value: 'c' } }), caller('attempt-b'));
  assert.throws(() => host.claim('other-attempt-tool', { executorId: 'worker-b' }, '2026-09-15T00:20:00Z'), /concurrency/);
  host.reportAttemptStop('attempt-a', 'stopped');
  assert.equal(host.claim('other-attempt-tool', { executorId: 'worker-b' }, '2026-09-15T00:20:00Z').commandId, 'other-attempt-tool');
  assert.equal(kernel.getCommand('other-attempt-tool')?.status, 'claimed');
  host.close();
});

test('resource-free worker attempts cannot bypass the parent node attempt cap', () => {
  const { host } = opened({ 'test.effect': plainWorkerKind }, grant({ maxAttemptsPerNode: 1 }));
  host.issueAutonomyLease(lease({ maxAttemptsPerNode: 1, poolLimits: [] }));
  host.admit(command({ commandId: 'first', idempotencyKey: 'first', payload: { value: 'a' } }), caller('attempt-a'));
  assert.throws(() => host.admit(command({ commandId: 'second', idempotencyKey: 'second', payload: { value: 'b' } }), caller('attempt-b')), /attempt cap/);
  host.close();
});

test('current versioned model facts are rechecked after awaited facts and must match the charged pool', async () => {
  const { host } = opened({ 'test.effect': modelResourceKind });
  host.issueAutonomyLease(lease());
  host.putModelFact({ modelId: 'model-1', provider: 'provider', poolId: 'pool-2', enabled: true, capabilities: ['build'], roles: ['worker'], availability: 'known_available', factVersion: 1, observedAt: now });
  assert.throws(() => host.admit(command({ commandId: 'wrong-pool', idempotencyKey: 'wrong-pool', payload: { value: 'a', upper: 1, modelId: 'model-1' } }), caller('a')), /pool/);
  host.close();

  const matching = opened({ 'test.effect': modelResourceKind });
  matching.host.issueAutonomyLease(lease());
  matching.host.putModelFact({ modelId: 'model-1', provider: 'provider', poolId: 'pool-1', enabled: true, capabilities: ['build'], roles: ['worker'], availability: 'known_available', factVersion: 1, observedAt: now });
  matching.host.admit(command({ commandId: 'freshness', idempotencyKey: 'freshness', expected: [{ authority: 'git', subject: 'head', predicate: 'fresh' }], payload: { value: 'a', upper: 1, modelId: 'model-1' } }), caller('a'));
  const claim = matching.host.claim('freshness', { executorId: 'worker' }, '2026-09-15T00:10:00Z');
  let executed = false;
  await assert.rejects(matching.host.perform('freshness', claim, { executorId: 'worker' }, async () => {
    matching.host.putModelFact({ modelId: 'model-1', provider: 'provider', poolId: 'pool-1', enabled: false, capabilities: ['build'], roles: ['worker'], availability: 'known_unavailable', factVersion: 2, observedAt: '2026-09-15T00:01:00Z' });
    return { value: true, state: 'known', source: 'git', observedAt: now };
  }, { effectId: 'effect-1', execute: async () => { executed = true; }, observe: async () => observedSuccess('freshness') }), /disabled/);
  assert.equal(executed, false);
  assert.equal(matching.kernel.getCommand('freshness')?.status, 'refused');
  matching.host.close();
});

test('a confirmed stop only settles zero before an effect starts and never releases an in-flight reservation', async () => {
  const { kernel, host } = opened({ 'test.effect': resourceKind });
  host.issueAutonomyLease(lease());
  host.admit(command({ payload: { value: 'a', upper: 3 } }), caller('a'));
  const claim = host.claim('command-1', { executorId: 'worker' }, '2026-09-15T00:10:00Z');
  let release!: () => void;
  const spending = host.perform('command-1', claim, { executorId: 'worker' }, async () => ({ value: true, state: 'known', source: 'test', observedAt: now }), {
    effectId: 'effect-1', execute: () => new Promise<void>((resolve) => { release = resolve; }), observe: async () => observedSuccess('command-1'),
  });
  await new Promise((resolve) => setImmediate(resolve));
  host.reportWorkerStop('command-1', 'stopped');
  assert.equal(kernel.getCommand('command-1')?.status, 'unknown');
  assert.throws(() => host.settleResource('command-1', { state: 'known', amount: 0 }), /may still spend/);
  release();
  await spending;
  host.close();
});
