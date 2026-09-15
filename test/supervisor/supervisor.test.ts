import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openKernel } from '../../src/core/index.js';
import { type Command, type OrchestratorLease } from '../../src/contracts/index.js';
import { type HostRuntime, openHost, type SupervisorObservationRuntime } from '../../src/host/index.js';
import { EventSupervisor, planRecovery, type RecoveryFacts, type SupervisorSignal } from '../../src/supervisor/index.js';
import { z } from 'zod/v3';
const now = '2026-09-15T10:00:00Z';
const later = '2026-09-15T11:00:00Z';
const owner: OrchestratorLease = { runId: 'r1', leaseId: 'owner1', owner: 'astra', sessionId: 's1', epoch: 1, issuedAt: now, expiresAt: later };
const signal: SupervisorSignal = { runId: 'r1', mapNodeId: 'node-1', source: 'native-pi', sourceEventId: 'pi-1', group: 'worker-1', observedAt: now, kind: 'worker.failed', evidenceRefs: ['raw:failure'], needsJudgement: true };
function opened(path: string) { return openKernel({ databasePath: path, kinds: {}, now: () => now }).host; }

test('quiet queue, durable duplicate suppression, coalescing and reopen without model calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-supervisor-')); let host = opened(join(dir, 'log.sqlite'));
  try {
    host.acquireOwnership(owner, 0); let supervisor = new EventSupervisor(host, () => now);
    assert.deepEqual(supervisor.pending(owner), []);
    supervisor.record(signal); supervisor.record(signal);
    supervisor.record({ ...signal, sourceEventId: 'pi-2', evidenceRefs: ['raw:second'] });
    supervisor.record({ ...signal, runId: 'other-run', sourceEventId: 'pi-3' });
    assert.equal(supervisor.pending(owner).length, 1);
    host.close(); host = opened(join(dir, 'log.sqlite')); supervisor = new EventSupervisor(host, () => now);
    const [wake] = supervisor.pending(owner); assert.equal(wake.causes.length, 2); assert.deepEqual(wake.evidenceRefs, ['raw:failure', 'raw:second']);
    supervisor.acknowledge(wake, owner); assert.deepEqual(supervisor.pending(owner), []);
    host.close(); host = opened(join(dir, 'log.sqlite')); assert.deepEqual(new EventSupervisor(host, () => now).pending(owner), []);
  } finally { host.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('takeover fences old acknowledgements and preserves pending causes for new owner', () => {
  const host = opened(':memory:');
  try {
    host.acquireOwnership(owner, 0); const supervisor = new EventSupervisor(host, () => now); supervisor.record(signal);
    const [oldWake] = supervisor.pending(owner);
    const next = { ...owner, leaseId: 'owner2', owner: 'fable' as const, sessionId: 's2', epoch: 2 };
    host.acquireOwnership(next, 1);
    assert.throws(() => supervisor.acknowledge(oldWake, owner), /stale/);
    assert.throws(() => supervisor.acknowledge(oldWake, next), /epoch/);
    const [wake] = supervisor.pending(next); assert.equal(wake.epoch, 2); assert.deepEqual(wake.causes, oldWake.causes);
    supervisor.acknowledge(wake, next); assert.equal(supervisor.pending(next).length, 0);
  } finally { host.close(); }
});

test('late signal survives acknowledgement of previously delivered causes and collisions refuse', () => {
  const host = opened(':memory:');
  try {
    host.acquireOwnership(owner, 0); const supervisor = new EventSupervisor(host, () => now); supervisor.record(signal);
    const [wake] = supervisor.pending(owner);
    supervisor.record({ ...signal, sourceEventId: 'pi-late' });
    supervisor.acknowledge(wake, owner); assert.equal(supervisor.pending(owner)[0].causes.length, 1);
    assert.throws(() => supervisor.record({ ...signal, evidenceRefs: ['tampered'] }), /different|collision|bytes/);
    supervisor.record({ ...signal, sourceEventId: 'gate', kind: 'gate.finished', needsJudgement: false });
    assert.equal(supervisor.pending(owner)[0].causes.length, 1);
  } finally { host.close(); }
});

const facts: RecoveryFacts = { observedAt: now, worker: 'dead', failure: 'transient', effects: 'confirmed-absent', provider: 'available', stopped: true, retryAllowed: true, leaseIssuedAt: now, leaseExpiresAt: later, leaseRevoked: false, attemptsUsed: 1, maxAttempts: 3 };
test('retry is proposed only for fresh confirmed-absent stopped transient failure within active authority', () => {
  assert.equal(planRecovery(facts, now).action, 'retry');
  for (const patch of [{ effects: 'unknown' }, { effects: 'present' }, { stopped: false }, { worker: 'unknown' }, { failure: 'permanent' }, { attemptsUsed: 3 }] as Partial<RecoveryFacts>[]) assert.equal(planRecovery({ ...facts, ...patch }, now).action, 'wake');
  for (const patch of [{ leaseExpiresAt: now }, { leaseRevoked: true }, { retryAllowed: false }, { provider: 'quota-exhausted' }, { provider: 'unknown' }] as Partial<RecoveryFacts>[]) assert.equal(planRecovery({ ...facts, ...patch }, now).action, 'block');
  assert.equal(planRecovery({ ...facts, worker: 'alive' }, now).action, 'observe');
  assert.equal(planRecovery(facts, '2026-09-15T10:00:31Z').action, 'wake');
  assert.equal(planRecovery(facts, '2026-09-15T09:59:59Z').action, 'wake');
});

test('ownership transfer at acknowledgement append cannot consume the old wake', () => {
  const host = opened(':memory:');
  try {
    host.acquireOwnership(owner, 0);
    const next = { ...owner, leaseId: 'o2', sessionId: 's2', epoch: 2 };
    const supervisor = new EventSupervisor({
      appendEvent: (event) => host.appendEvent(event), readEvents: (run) => host.readEvents(run),
      assertCurrentOwner: (lease) => host.assertCurrentOwner(lease),
      appendOwnedEvent(event, lease) { host.acquireOwnership(next, 1); host.appendOwnedEvent(event, lease); },
    }, () => now);
    supervisor.record(signal); const [wake] = supervisor.pending(owner);
    assert.throws(() => supervisor.acknowledge(wake, owner), /stale/);
    assert.equal(new EventSupervisor(host, () => now).pending(next)[0].causes.length, 1);
  } finally { host.close(); }
});

const hostKinds = { 'supervisor.retry': { payloadSchema: z.object({ value: z.string() }).strict() } };
const commandHash = (payload: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
function retryIntent(id = 'retry-1'): Command {
  const payload = { value: 'retry' };
  return { schemaVersion: 1, commandId: id, kind: 'supervisor.retry', idempotencyKey: id, payloadHash: commandHash(payload),
    scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'untrusted-observation', runId: 'r1', origin: 'supervisor',
    leaseId: 'autonomy-1', leaseRevision: 1, plannedAt: now, notAfter: later,
    expected: [{ authority: 'pi', subject: 'worker-1', predicate: 'confirmed stopped' }], payload, requiredEvidence: ['raw:failure'] };
}
async function supervisedHost(directory: string, runtime: HostRuntime, clock: () => string, supervisorRuntime: SupervisorObservationRuntime = {
  observeRecovery: async () => ({ ...facts, observedAt: clock() }),
  readFact: async () => ({ value: true, state: 'known', source: 'trusted-pi-observer', observedAt: clock() }),
}) {
  const plane = await openHost({ stateDirectory: directory, kinds: hostKinds, runtime, supervisorRuntime, now: clock });
  plane.recordHumanAuthority({ authorityId: 'human-1', repositoryId: 'repo-1', mapNodeIds: ['node-1'], allowedActions: ['supervisor.retry'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
  plane.recordAutonomyLease({ leaseId: 'autonomy-1', revision: 1, issuedBy: 'human', parentAuthorityId: 'human-1', scope: { repositoryId: 'repo-1', mapNodeIds: ['node-1'] }, allowedActions: ['supervisor.retry'], issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
  plane.acquireOwnership(owner, 0);
  return plane;
}

test('host supervisor serializes trusted recovery events through Kernel and restart cannot duplicate an effect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-supervisor-host-')); const effects: string[] = [];
  const runtime: HostRuntime = { createEffect: async ({ command }) => ({ effectId: `effect:${command.commandId}`,
    execute: async () => { effects.push((command.payload as { value: string }).value); },
    observe: async () => ({ commandId: command.commandId, effectId: `effect:${command.commandId}`, state: 'succeeded', source: 'trusted-runtime', observedAt: now, evidenceRefs: ['raw:receipt'] }),
  }) };
  const input = { signal: { ...signal, sourceEventId: 'host-retry', needsJudgement: false },
    retry: { intent: retryIntent(), executor: { executorId: 'supervisor' }, claimExpiresAt: '2026-09-15T10:05:00Z' } };
  let plane = await supervisedHost(directory, runtime, () => now);
  try {
    const pending = plane.createSupervisor().process(input);
    (input.retry.intent as Command).payload = { value: 'mutated-after-enqueue' };
    const first = await pending;
    assert.equal(first.decision?.action, 'retry'); assert.equal(first.retry?.status, 'performed'); assert.deepEqual(effects, ['retry']);
    plane.close(); plane = await openHost({ stateDirectory: directory, kinds: hostKinds, runtime, now: () => now });
    const replay = await plane.createSupervisor().process({ signal: { ...signal, sourceEventId: 'host-retry', needsJudgement: false }, retry: { intent: retryIntent(), executor: { executorId: 'supervisor' }, claimExpiresAt: '2026-09-15T10:05:00Z' } });
    assert.equal(replay.retry?.status, 'terminal'); assert.deepEqual(effects, ['retry']);
    assert.equal((await plane.snapshot('r1')).commands[0]?.status, 'succeeded');
  } finally { plane.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('host supervisor records durable coalesced wakes and blocks expiry, quota, stale facts, and stale controller epochs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-supervisor-blocks-')); let clock = now; const effects: string[] = [];
  const runtime: HostRuntime = { createEffect: async ({ command }) => ({ effectId: `effect:${command.commandId}`,
    execute: async () => { effects.push(command.commandId); },
    observe: async () => ({ commandId: command.commandId, effectId: `effect:${command.commandId}`, state: 'succeeded', source: 'trusted-runtime', observedAt: now, evidenceRefs: ['raw:receipt'] }),
  }) };
  let recovery = facts;
  const plane = await supervisedHost(directory, runtime, () => clock, { observeRecovery: async () => recovery, readFact: async () => ({ value: true, state: 'known', source: 'trusted-pi-observer', observedAt: clock }) });
  try {
    const service = plane.createSupervisor();
    const wakeInput = { signal: { ...signal, sourceEventId: 'wake-a', group: 'same-failure', needsJudgement: true } };
    const wake = await service.process(wakeInput); assert.equal(wake.wakes.length, 1);
    assert.equal(service.log().readEvents('supervisor:r1').filter((event) => event.kind === 'supervisor.wake').length, 1);
    const next = { ...owner, leaseId: 'owner2', sessionId: 's2', epoch: 2 };
    plane.acquireOwnership(next, 1);
    const nextWake = await service.process({ signal: { ...signal, sourceEventId: 'wake-b', group: 'same-failure', needsJudgement: true } });
    assert.equal(nextWake.wakes[0]?.epoch, 2, 'host resolves the current epoch; callers cannot reuse the stale one');
    const retry = { intent: retryIntent('blocked-retry'), executor: { executorId: 'supervisor' }, claimExpiresAt: '2026-09-15T10:05:00Z' };
    recovery = { ...facts, provider: 'quota-exhausted' };
    assert.equal((await service.process({ signal: { ...signal, sourceEventId: 'quota', kind: 'provider.blocked', needsJudgement: false }, retry })).decision?.action, 'block');
    assert.ok(service.log().readEvents('supervisor:r1').some((event) => event.kind === 'supervisor.signal' && (event.payload as { sourceEventId: string }).sourceEventId === 'quota'), 'provider block remains a durable observation rather than a fabricated recovery');
    clock = later;
    recovery = { ...facts, observedAt: later };
    assert.equal((await service.process({ signal: { ...signal, sourceEventId: 'expired', needsJudgement: false }, retry })).decision?.action, 'block');
    clock = now;
    recovery = { ...facts, observedAt: '2026-09-15T09:59:00Z' };
    assert.equal((await service.process({ signal: { ...signal, sourceEventId: 'stale', needsJudgement: false }, retry })).decision?.action, 'wake');
    assert.deepEqual(effects, []);
  } finally { plane.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('host supervisor requires a freshly known fact at effect time', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-supervisor-facts-')); const effects: string[] = [];
  const runtime: HostRuntime = { createEffect: async ({ command }) => ({ effectId: `effect:${command.commandId}`,
    execute: async () => { effects.push(command.commandId); },
    observe: async () => ({ commandId: command.commandId, effectId: `effect:${command.commandId}`, state: 'succeeded', source: 'trusted-runtime', observedAt: now, evidenceRefs: ['raw:receipt'] }),
  }) };
  const plane = await supervisedHost(directory, runtime, () => now, { observeRecovery: async () => facts, readFact: async () => ({ value: null, state: 'unknown', source: 'trusted-pi-observer', observedAt: now }) });
  try {
    await assert.rejects(plane.createSupervisor().process({ signal: { ...signal, sourceEventId: 'unknown-fact', needsJudgement: false },
      retry: { intent: retryIntent('unknown-fact-retry'), executor: { executorId: 'supervisor' }, claimExpiresAt: '2026-09-15T10:05:00Z' } }), /precondition is not freshly known/);
    assert.deepEqual(effects, []);
  } finally { plane.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('restart after admission but before an effect preserves queued work for a newly fresh observation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-supervisor-queued-')); const effects: string[] = [];
  const runtime: HostRuntime = { createEffect: async ({ command }) => ({ effectId: `effect:${command.commandId}`,
    execute: async () => { effects.push(command.commandId); },
    observe: async () => ({ commandId: command.commandId, effectId: `effect:${command.commandId}`, state: 'succeeded', source: 'trusted-runtime', observedAt: now, evidenceRefs: ['raw:receipt'] }),
  }) };
  const input = { signal: { ...signal, sourceEventId: 'queued-restart', needsJudgement: false }, retry: { intent: retryIntent('queued-restart'), executor: { executorId: 'supervisor' }, claimExpiresAt: '2026-09-15T10:05:00Z' } };
  let plane = await supervisedHost(directory, runtime, () => now, { observeRecovery: async () => ({ ...facts, effects: 'unknown' }), readFact: async () => ({ value: true, state: 'known', source: 'trusted-pi-observer', observedAt: now }) });
  try {
    assert.equal((await plane.createSupervisor().process(input)).retry?.status, 'reconcile');
    assert.equal((await plane.snapshot('r1')).commands[0]?.status, 'queued');
    plane.close(); plane = await openHost({ stateDirectory: directory, kinds: hostKinds, runtime, now: () => now, supervisorRuntime: { observeRecovery: async () => facts, readFact: async () => ({ value: true, state: 'known', source: 'trusted-pi-observer', observedAt: now }) } });
    assert.equal((await plane.createSupervisor().process(input)).retry?.status, 'performed');
    assert.deepEqual(effects, ['queued-restart']);
  } finally { plane.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('at-effect recovery observation rejects moved effects even with no command preconditions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-supervisor-at-effect-')); const effects: string[] = []; let observations = 0;
  const runtime: HostRuntime = { createEffect: async ({ command }) => ({ effectId: `effect:${command.commandId}`,
    execute: async () => { effects.push(command.commandId); },
    observe: async () => ({ commandId: command.commandId, effectId: `effect:${command.commandId}`, state: 'succeeded', source: 'trusted-runtime', observedAt: now, evidenceRefs: ['raw:receipt'] }),
  }) };
  const plane = await supervisedHost(directory, runtime, () => now, { observeRecovery: async () => (++observations === 1 ? facts : { ...facts, effects: 'present' }), readFact: async () => ({ value: true, state: 'known', source: 'trusted-pi-observer', observedAt: now }) });
  try {
    const intent = retryIntent('moved-at-effect'); intent.expected = [];
    const result = await plane.createSupervisor().process({ signal: { ...signal, sourceEventId: 'moved-at-effect', needsJudgement: false }, retry: { intent, executor: { executorId: 'supervisor' }, claimExpiresAt: '2026-09-15T10:05:00Z' } });
    assert.equal(result.retry?.status, 'reconcile'); assert.equal(result.retry?.observation?.state, 'unknown'); assert.deepEqual(effects, []);
  } finally { plane.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('retry command must bind the observed run and map node and cannot run without a host observer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-supervisor-bind-')); const runtime: HostRuntime = { createEffect: async () => { throw new Error('must not create effect'); } };
  const plane = await openHost({ stateDirectory: directory, kinds: hostKinds, runtime, now: () => now });
  try {
    plane.recordHumanAuthority({ authorityId: 'human-1', repositoryId: 'repo-1', mapNodeIds: ['node-1'], allowedActions: ['supervisor.retry'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'autonomy-1', revision: 1, issuedBy: 'human', parentAuthorityId: 'human-1', scope: { repositoryId: 'repo-1', mapNodeIds: ['node-1'] }, allowedActions: ['supervisor.retry'], issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
    plane.acquireOwnership(owner, 0);
    const wrong = retryIntent('wrong-binding'); wrong.scope = { repositoryId: 'repo-1', mapNodeId: 'other-node' };
    await assert.rejects(plane.createSupervisor().process({ signal: { ...signal, sourceEventId: 'wrong-binding', needsJudgement: false }, retry: { intent: wrong, executor: { executorId: 'supervisor' }, claimExpiresAt: '2026-09-15T10:05:00Z' } }), /same run and map node/);
    await assert.rejects(plane.createSupervisor().process({ signal: { ...signal, sourceEventId: 'no-observer', needsJudgement: false }, retry: { intent: retryIntent('no-observer'), executor: { executorId: 'supervisor' }, claimExpiresAt: '2026-09-15T10:05:00Z' } }), /no trusted supervisor recovery observer/);
  } finally { plane.close(); rmSync(directory, { recursive: true, force: true }); }
});
