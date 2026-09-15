import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openKernel } from '../../src/core/index.js';
import { type OrchestratorLease } from '../../src/contracts/index.js';
import { EventSupervisor, planRecovery, type RecoveryFacts, type SupervisorSignal } from '../../src/supervisor/index.js';
const now = '2026-09-15T10:00:00Z';
const later = '2026-09-15T11:00:00Z';
const owner: OrchestratorLease = { runId: 'r1', leaseId: 'owner1', owner: 'astra', sessionId: 's1', epoch: 1, issuedAt: now, expiresAt: later };
const signal: SupervisorSignal = { runId: 'r1', source: 'native-pi', sourceEventId: 'pi-1', group: 'worker-1', observedAt: now, kind: 'worker.failed', evidenceRefs: ['raw:failure'], needsJudgement: true };
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
