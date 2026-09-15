import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autonomyLeaseSchema,
  commandSchema,
  createObservationSchema,
  eventSchema,
  gateResultSchema,
  orchestratorLeaseSchema,
  parseExecutableCommand,
  rawArtifactRefSchema,
  usageRecordSchema,
  workerResultSchema,
} from '../../src/contracts/index.js';
import { z } from 'zod/v3';

const command = {
  schemaVersion: 1,
  commandId: 'cmd-1',
  kind: 'worker.spawn',
  idempotencyKey: 'spawn:node-1',
  payloadHash: 'sha256:abc',
  scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' },
  actorId: 'authenticated-session-subject',
  runId: 'run-1',
  leaseId: 'authority-lease-1',
  leaseRevision: 1,
  plannedAt: '2026-09-15T00:00:00Z',
  notAfter: '2026-09-15T01:00:00Z',
  expected: [],
  payload: { attemptId: 'attempt-1' },
  requiredEvidence: ['evidence:spawn'],
};

test('orchestrator commands require ownership lease and a positive epoch', () => {
  assert.equal(commandSchema.safeParse({ ...command, origin: 'orchestrator' }).success, false);
  assert.equal(commandSchema.safeParse({
    ...command,
    origin: 'orchestrator',
    orchestratorLeaseId: 'controller-lease-1',
    orchestratorEpoch: 0,
  }).success, false);
  assert.equal(commandSchema.safeParse({
    ...command,
    origin: 'orchestrator',
    orchestratorLeaseId: 'controller-lease-1',
    orchestratorEpoch: 9,
  }).success, true);
  assert.equal(commandSchema.safeParse({
    ...command,
    origin: 'orchestrator',
    orchestratorLeaseId: 'controller-lease-1',
    orchestratorEpoch: 9,
    plannedAt: '2026-09-15T02:00:00Z',
  }).success, false);
});

test('non-orchestrator commands cannot smuggle controller ownership fields', () => {
  assert.equal(commandSchema.safeParse({
    ...command,
    origin: 'supervisor',
    orchestratorLeaseId: 'controller-lease-1',
    orchestratorEpoch: 9,
  }).success, false);
});

test('a command envelope is not executable until its registered payload validates', () => {
  assert.throws(() => parseExecutableCommand({ ...command, origin: 'worker' }, {}), /No payload schema/);
  assert.throws(() => parseExecutableCommand({ ...command, origin: 'worker', payload: {} }, {
    'worker.spawn': z.object({ attemptId: z.string().min(1) }),
  }));
  assert.equal(parseExecutableCommand({ ...command, origin: 'worker' }, {
    'worker.spawn': z.object({ attemptId: z.string().min(1) }),
  }).commandId, 'cmd-1');
});

test('an executable payload registry cannot alter the command payload', () => {
  const withExtraField = { ...command, origin: 'worker', payload: { attemptId: 'attempt-1', unexpected: true } };
  assert.throws(() => parseExecutableCommand(withExtraField, {
    'worker.spawn': z.object({ attemptId: z.string() }),
  }), /preserve exact JSON semantics/);
  assert.throws(() => parseExecutableCommand({ ...command, origin: 'worker', payload: { retries: '3' } }, {
    'worker.spawn': z.object({ retries: z.coerce.number() }),
  }), /preserve exact JSON semantics/);
  assert.throws(() => parseExecutableCommand({ ...command, origin: 'worker', payload: {} }, {
    'worker.spawn': z.object({ retries: z.number().default(1) }),
  }), /preserve exact JSON semantics/);
  const inheritedRegistry = Object.create({ 'worker.spawn': z.object({ attemptId: z.string() }) }) as Record<string, z.ZodType<unknown>>;
  assert.throws(() => parseExecutableCommand({ ...command, origin: 'worker' }, inheritedRegistry), /No payload schema/);
});

test('timestamps, identifiers, and quantities are validated at contract boundaries', () => {
  assert.equal(createObservationSchema(z.string()).safeParse({
    value: 'fresh', state: 'known', source: 'github', observedAt: '2026-09-15T00:00:00+10:00',
  }).success, false);
  assert.equal(autonomyLeaseSchema.safeParse({
    leaseId: 'l', revision: 1, issuedBy: 'human', parentAuthorityId: 'p',
    scope: { repositoryId: 'r', mapNodeIds: [] }, allowedActions: [],
    issuedAt: '2026-09-15T00:00:00Z', expiresAt: '2026-09-16T00:00:00Z',
    maxConcurrency: Number.POSITIVE_INFINITY, maxAttemptsPerNode: -1,
    poolLimits: [{ poolId: 'pool', unit: 'tokens', limit: Number.NaN }], protectedReserves: [],
  }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, origin: 'worker', commandId: ' cmd-1' }).success, false);
  assert.equal(autonomyLeaseSchema.safeParse({
    leaseId: 'l', revision: Number.MAX_SAFE_INTEGER + 1, issuedBy: 'human', parentAuthorityId: 'p',
    scope: { repositoryId: 'r', mapNodeIds: [] }, allowedActions: [],
    issuedAt: '2026-09-15T00:00:00Z', expiresAt: '2026-09-15T00:00:00Z',
    maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [],
  }).success, false);
});

test('result and event seams reject malformed durable records', () => {
  assert.equal(rawArtifactRefSchema.safeParse({ ref: '', hash: 'hash', mediaType: 'text/plain' }).success, false);
  assert.equal(workerResultSchema.safeParse({ status: 'succeeded' }).success, false);
  assert.equal(gateResultSchema.safeParse({ gateId: 'gate' }).success, false);
  assert.equal(eventSchema.safeParse({
    eventId: 'e', schemaVersion: 1, kind: 'gate.completed', source: 'ci', sourceEventId: 'remote-1',
    occurredAt: '2026-09-15T00:00:00Z', recordedAt: '2026-09-15T00:00:01Z', correlationId: 'c', payload: {},
  }).success, true);
  assert.equal(orchestratorLeaseSchema.safeParse({
    runId: 'run', leaseId: 'lease', owner: 'astra', sessionId: 'session', epoch: 0,
    issuedAt: '2026-09-15T00:00:00Z', expiresAt: '2026-09-15T01:00:00Z',
  }).success, false);
});

test('worker and gate results round-trip as claims and evidence records', () => {
  const workerResult = {
    status: 'succeeded', summary: 'Implemented the change.', changed_files: ['src/a.ts'], commits: ['abc123'],
    decisions: ['Use contracts.'], discoveries: ['No prior schema.'], tests_claimed: ['npm test'],
    acceptance_claims: [{ criterionId: 'ac-1', claim: 'Schema validates.', evidenceRefs: ['artifact:test-log'] }],
    risks: [], unresolved: [], artifacts: [{ ref: 'artifact:worker-result', hash: 'sha256:abc', mediaType: 'application/json' }],
    recommended_next_action: 'Review the evidence.',
  };
  const gateResult = {
    gateId: 'unit', trustedDefinitionRef: 'policy:unit', definitionHash: 'sha256:def', command: ['npm', 'test'],
    repositoryId: 'repo', headSha: 'abc123', exitStatus: 0,
    checks: [{ name: 'contracts', result: 'pass', evidenceRefs: ['artifact:test-log'] }],
    artifactRefs: ['artifact:test-log'], observedAt: '2026-09-15T00:00:00Z',
  };
  assert.deepEqual(workerResultSchema.parse(workerResult), workerResult);
  assert.deepEqual(gateResultSchema.parse(gateResult), gateResult);
});

test('usage records preserve provenance and distinguish known from unavailable telemetry', () => {
  const knownUsage = {
    usageId: 'usage-1', schemaVersion: 1, attemptId: 'attempt-1', sessionId: 'session-1',
    model: 'astra', provider: 'openai', poolId: 'subscription', consumer: 'orchestrator',
    observedAt: '2026-09-15T00:00:00Z',
    contextOccupancy: {
      contextTokens: { state: 'known', value: 1200 }, contextWindow: { state: 'known', value: 128000 },
      compactionCount: { state: 'known', value: 1 },
    },
    consumedTokens: { state: 'known', value: 900 }, cachedTokens: { state: 'unknown', value: null, reason: 'provider omitted cache telemetry' },
    cost: { state: 'known', amount: 1.25, unit: 'provider-credit' },
  };
  const unknownUsage = {
    ...knownUsage,
    usageId: 'usage-2',
    contextOccupancy: {
      contextTokens: { state: 'unavailable', value: null }, contextWindow: { state: 'unknown', value: null },
      compactionCount: { state: 'unknown', value: null },
    },
    consumedTokens: { state: 'unknown', value: null }, cachedTokens: { state: 'unavailable', value: null },
    cost: { state: 'unknown', amount: null, reason: 'provider did not report cost' },
  };
  assert.deepEqual(usageRecordSchema.parse(knownUsage), knownUsage);
  assert.deepEqual(usageRecordSchema.parse(unknownUsage), unknownUsage);
});

test('usage records reject malformed or internally inconsistent telemetry', () => {
  const usage = {
    usageId: 'usage-1', schemaVersion: 1, attemptId: 'attempt-1', sessionId: 'session-1', model: 'astra',
    provider: 'openai', poolId: 'subscription', consumer: 'orchestrator', observedAt: '2026-09-15T00:00:00Z',
    contextOccupancy: {
      contextTokens: { state: 'known', value: 1 }, contextWindow: { state: 'known', value: 2 }, compactionCount: { state: 'known', value: 0 },
    },
    consumedTokens: { state: 'known', value: 1 }, cachedTokens: { state: 'known', value: 0 }, cost: { state: 'known', amount: 0, unit: 'credit' },
  };
  assert.equal(usageRecordSchema.safeParse({ ...usage, consumedTokens: { state: 'known', value: -1 } }).success, false);
  assert.equal(usageRecordSchema.safeParse({ ...usage, contextOccupancy: { ...usage.contextOccupancy, contextWindow: { state: 'known', value: Number.POSITIVE_INFINITY } } }).success, false);
  assert.equal(usageRecordSchema.safeParse({ ...usage, cachedTokens: { state: 'unknown', value: 0 } }).success, false);
  assert.equal(usageRecordSchema.safeParse({ ...usage, cost: { state: 'unknown', amount: 0 } }).success, false);
});
