import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  type Command,
  type OrchestratorLease,
  type AutonomyLease,
    type OrchestratorDriver,
} from '../../src/contracts/index.js';
import { EventSupervisor, type SupervisorSignal, type Wake } from '../../src/supervisor/index.js';
import { openHost } from '../../src/host/index.js';
import {
  HostWakeDispatcher,
  wakeDeliveryPayloadSchema,
  type WakeDeliveryPayload,
} from '../../src/host/wake-dispatcher.js';
import type { HelmToolExecutionContext } from '../../src/runtime/orchestrator/index.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const nowStr = '2026-09-16T01:00:00Z';
const endStr = '2026-09-16T02:00:00Z';

function createFixtures(runId: string, epoch = 1) {
  const ownership: OrchestratorLease = {
    runId,
    leaseId: `owner-${runId}-${epoch}`,
    owner: 'astra',
    sessionId: `session-${runId}-${epoch}`,
    epoch,
    issuedAt: nowStr,
    expiresAt: endStr,
  };

  const autonomyLease: AutonomyLease = {
    leaseId: `autonomy-${runId}`,
    revision: 1,
    issuedBy: 'human',
    parentAuthorityId: 'human',
    scope: { repositoryId: 'repo', mapNodeIds: ['node'] },
    allowedActions: ['orchestrator.wake'],
    issuedAt: nowStr,
    expiresAt: endStr,
    maxConcurrency: 1,
    maxAttemptsPerNode: 3,
    poolLimits: [],
    protectedReserves: [],
  };

  return { ownership, autonomyLease };
}

function createCommandFactory(autonomyLease: AutonomyLease, nowFn: () => string) {
  return (wake: Wake, owner: OrchestratorLease, payload: WakeDeliveryPayload): Command => {
    const payloadHash = 'sha256:' + hash(payload);
    return {
      schemaVersion: 1,
      commandId: `wake:${wake.wakeId}`,
      kind: 'orchestrator.wake',
      idempotencyKey: `wake:${wake.wakeId}`,
      payloadHash,
      scope: { repositoryId: 'repo', mapNodeId: 'node' },
      actorId: 'trusted-host',
      runId: wake.runId,
      leaseId: autonomyLease.leaseId,
      leaseRevision: autonomyLease.revision,
      plannedAt: nowFn(),
      notAfter: endStr,
      expected: [],
      payload,
      requiredEvidence: [],
      origin: 'orchestrator',
      orchestratorLeaseId: owner.leaseId,
      orchestratorEpoch: owner.epoch,
    };
  };
}

test('quiet return with no driver calls when no wakes pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-wake-quiet-'));
  const host = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: () => nowStr });
  try {
    const runId = 'run-quiet';
    const { ownership, autonomyLease } = createFixtures(runId);
    host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['orchestrator.wake'], expiresAt: endStr, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
    host.recordAutonomyLease(autonomyLease);
    host.acquireOwnership(ownership, 0);

    let driverCalls = 0;
    const driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'> = {
      async send_event() { driverCalls++; },
      async invoke() { driverCalls++; return { resultRef: 'res' }; },
    };

    const dispatcher = new HostWakeDispatcher({
      host,
      driver,
      commandFor: createCommandFactory(autonomyLease, () => nowStr),
      executor: { executorId: 'wake-executor' },
      claimExpiresAt: () => endStr,
      readFact: async () => ({ value: true, state: 'known', source: 'fact', observedAt: nowStr }),
      verifyResult: async () => 'succeeded',
      now: () => nowStr,
    });

    const context: HelmToolExecutionContext = { runId, sessionId: ownership.sessionId, mode: 'primary' };
    const res = await dispatcher.dispatch(context);
    assert.deepEqual(res, []);
    assert.equal(driverCalls, 0);
  } finally { host.close(); await rm(root, { recursive: true, force: true }); }
});

test('successful wake invoke, artifact receipt verification, and supervisor ack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-wake-success-'));
  const host = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: () => nowStr });
  try {
    const runId = 'run-success';
    const { ownership, autonomyLease } = createFixtures(runId);
    host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['orchestrator.wake'], expiresAt: endStr, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
    host.recordAutonomyLease(autonomyLease);
    host.acquireOwnership(ownership, 0);

    const supervisor = new EventSupervisor(host.supervisorLog(), () => nowStr);
    const signal: SupervisorSignal = {
      runId, mapNodeId: 'node', source: 'worker', sourceEventId: 'evt-success', group: 'group-1',
      observedAt: nowStr, kind: 'worker.failed', evidenceRefs: [], needsJudgement: true,
    };
    supervisor.record(signal);

    const artifacts = host.artifactsFor({ runId, sessionId: ownership.sessionId, mode: 'primary' });
    let savedReceiptRef = '';
    const driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'> = {
      async send_event() {},
      async invoke(inp) {
        savedReceiptRef = await artifacts.saveInvocation({ driver: 'astra', sessionId: inp.sessionId, outcome: 'succeeded', text: 'Wake processed' });
        return { resultRef: savedReceiptRef };
      },
    };

    const dispatcher = new HostWakeDispatcher({
      host,
      driver,
      commandFor: createCommandFactory(autonomyLease, () => nowStr),
      executor: { executorId: 'wake-executor' },
      claimExpiresAt: () => endStr,
      readFact: async () => ({ value: true, state: 'known', source: 'fact', observedAt: nowStr }),
      verifyResult: async (ref) => {
        const inv = await artifacts.readInvocation(ref);
        return inv.outcome;
      },
      now: () => nowStr,
    });

    const context: HelmToolExecutionContext = { runId, sessionId: ownership.sessionId, mode: 'primary' };
    const res = await dispatcher.dispatch(context);
    assert.equal(res.length, 1);
    assert.equal(res[0].state, 'handled');
    assert.equal(res[0].resultRef, savedReceiptRef);

    const pending = supervisor.pending(ownership);
    assert.equal(pending.length, 0);
  } finally { host.close(); await rm(root, { recursive: true, force: true }); }
});

test('reopened host does not duplicate invocation for already acked causes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-wake-reopen-'));
  const runId = 'run-reopen';
  const { ownership, autonomyLease } = createFixtures(runId);
  try {
    const host1 = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: () => nowStr });
    host1.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['orchestrator.wake'], expiresAt: endStr, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
    host1.recordAutonomyLease(autonomyLease);
    host1.acquireOwnership(ownership, 0);

    const supervisor1 = new EventSupervisor(host1.supervisorLog(), () => nowStr);
    supervisor1.record({
      runId, mapNodeId: 'node', source: 'worker', sourceEventId: 'evt-reopen', group: 'group-1',
      observedAt: nowStr, kind: 'worker.failed', evidenceRefs: [], needsJudgement: true,
    });

    let invokeCount = 0;
    const driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'> = {
      async send_event() {},
      async invoke() { invokeCount++; return { resultRef: 'res-ack' }; },
    };

    const dispatcher1 = new HostWakeDispatcher({
      host: host1,
      driver,
      commandFor: createCommandFactory(autonomyLease, () => nowStr),
      executor: { executorId: 'wake-executor' },
      claimExpiresAt: () => endStr,
      readFact: async () => ({ value: true, state: 'known', source: 'fact', observedAt: nowStr }),
      verifyResult: async () => 'succeeded',
      now: () => nowStr,
    });

    const context: HelmToolExecutionContext = { runId, sessionId: ownership.sessionId, mode: 'primary' };
    await dispatcher1.dispatch(context);
    assert.equal(invokeCount, 1);
    host1.close();

    const host2 = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: () => nowStr });
    const dispatcher2 = new HostWakeDispatcher({
      host: host2,
      driver,
      commandFor: createCommandFactory(autonomyLease, () => nowStr),
      executor: { executorId: 'wake-executor' },
      claimExpiresAt: () => endStr,
      readFact: async () => ({ value: true, state: 'known', source: 'fact', observedAt: nowStr }),
      verifyResult: async () => 'succeeded',
      now: () => nowStr,
    });

    const res2 = await dispatcher2.dispatch(context);
    assert.deepEqual(res2, []);
    assert.equal(invokeCount, 1);
    host2.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown or failed invocation leaves pending; redispatch or new cause does not replay old cause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-wake-fail-block-'));
  const host = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: () => nowStr });
  try {
    const runId = 'run-fail-block';
    const { ownership, autonomyLease } = createFixtures(runId);
    host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['orchestrator.wake'], expiresAt: endStr, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
    host.recordAutonomyLease(autonomyLease);
    host.acquireOwnership(ownership, 0);

    const supervisor = new EventSupervisor(host.supervisorLog(), () => nowStr);
    supervisor.record({
      runId, mapNodeId: 'node', source: 'worker', sourceEventId: 'evt-c1', group: 'group-1',
      observedAt: nowStr, kind: 'worker.failed', evidenceRefs: [], needsJudgement: true,
    });

    let invokeCount = 0;
    const driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'> = {
      async send_event() {},
      async invoke() { invokeCount++; return { resultRef: 'res-bad' }; },
    };

    const dispatcher = new HostWakeDispatcher({
      host,
      driver,
      commandFor: createCommandFactory(autonomyLease, () => nowStr),
      executor: { executorId: 'wake-executor' },
      claimExpiresAt: () => endStr,
      readFact: async () => ({ value: true, state: 'known', source: 'fact', observedAt: nowStr }),
      verifyResult: async () => 'unknown',
      now: () => nowStr,
    });

    const context: HelmToolExecutionContext = { runId, sessionId: ownership.sessionId, mode: 'primary' };
    const res1 = await dispatcher.dispatch(context);
    assert.equal(res1[0].state, 'unknown');
    assert.equal(invokeCount, 1);

    // Redispatch does not repeat invoke
    const res2 = await dispatcher.dispatch(context);
    assert.equal(res2[0].state, 'unknown');
    assert.equal(invokeCount, 1);

    // Group gains new cause
    supervisor.record({
      runId, mapNodeId: 'node', source: 'worker', sourceEventId: 'evt-c2', group: 'group-1',
      observedAt: nowStr, kind: 'worker.failed', evidenceRefs: [], needsJudgement: true,
    });

    const res3 = await dispatcher.dispatch(context);
    assert.equal(res3[0].state, 'unknown');
    assert.equal(invokeCount, 1);
  } finally { host.close(); await rm(root, { recursive: true, force: true }); }
});

test('crash after successful observation before ack recovers without invoking again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-wake-crash-'));
  let host = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: () => nowStr });
  try {
    const runId = 'run-crash';
    const { ownership, autonomyLease } = createFixtures(runId);
    host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['orchestrator.wake'], expiresAt: endStr, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
    host.recordAutonomyLease(autonomyLease);
    host.acquireOwnership(ownership, 0);

    const supervisor = new EventSupervisor(host.supervisorLog(), () => nowStr);
    supervisor.record({
      runId, mapNodeId: 'node', source: 'worker', sourceEventId: 'evt-crash', group: 'group-1',
      observedAt: nowStr, kind: 'worker.failed', evidenceRefs: [], needsJudgement: true,
    });

    let invokeCount = 0;
    const driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'> = {
      async send_event() {},
      async invoke() { invokeCount++; return { resultRef: 'res-crash' }; },
    };

    let throwAck = true;
    const log = host.supervisorLog();
    host.supervisorLog = () => ({ ...log, appendOwnedEvent(event, owner) {
      if (throwAck && event.kind === 'supervisor.ack') { throwAck = false; throw new Error('simulated crash before ack'); }
      log.appendOwnedEvent(event, owner);
    } });

    const dispatcher = new HostWakeDispatcher({
      host,
      driver,
      commandFor: createCommandFactory(autonomyLease, () => nowStr),
      executor: { executorId: 'wake-executor' },
      claimExpiresAt: () => endStr,
      readFact: async () => ({ value: true, state: 'known', source: 'fact', observedAt: nowStr }),
      verifyResult: async () => 'succeeded',
      now: () => nowStr,
    });

    const context: HelmToolExecutionContext = { runId, sessionId: ownership.sessionId, mode: 'primary' };
    const res1 = await dispatcher.dispatch(context);
    assert.equal(res1[0].state, 'unknown');
    assert.equal(invokeCount, 1);

    // Reopen the database after observation but before acknowledgement.
    host.close();
    host = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: () => nowStr });
    const restarted = new HostWakeDispatcher({ host, driver, commandFor: createCommandFactory(autonomyLease, () => nowStr), executor: { executorId: 'restart' }, claimExpiresAt: () => endStr, readFact: async () => { throw new Error('unexpected fact'); }, verifyResult: async () => 'succeeded', now: () => nowStr });
    const res2 = await restarted.dispatch(context);
    assert.equal(res2.length, 1);
    assert.equal(res2[0].state, 'handled');
    assert.equal(invokeCount, 1);

    const pending = new EventSupervisor(host.supervisorLog(), () => nowStr).pending(ownership);
    assert.equal(pending.length, 0);
  } finally { host.close(); await rm(root, { recursive: true, force: true }); }
});

test('concurrent dispatchers or duplicate cause claims execute at most once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-wake-conc-'));
  const host = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: () => nowStr });
  try {
    const runId = 'run-conc';
    const { ownership, autonomyLease } = createFixtures(runId);
    host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['orchestrator.wake'], expiresAt: endStr, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
    host.recordAutonomyLease(autonomyLease);
    host.acquireOwnership(ownership, 0);

    const supervisor = new EventSupervisor(host.supervisorLog(), () => nowStr);
    supervisor.record({
      runId, mapNodeId: 'node', source: 'worker', sourceEventId: 'evt-conc', group: 'group-1',
      observedAt: nowStr, kind: 'worker.failed', evidenceRefs: [], needsJudgement: true,
    });

    let invokeCount = 0;
    const driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'> = {
      async send_event() {},
      async invoke() { invokeCount++; return { resultRef: 'res-conc' }; },
    };

    const d1 = new HostWakeDispatcher({
      host,
      driver,
      commandFor: createCommandFactory(autonomyLease, () => nowStr),
      executor: { executorId: 'wake-executor-1' },
      claimExpiresAt: () => endStr,
      readFact: async () => ({ value: true, state: 'known', source: 'fact', observedAt: nowStr }),
      verifyResult: async () => 'succeeded',
      now: () => nowStr,
    });

    const d2 = new HostWakeDispatcher({
      host,
      driver,
      commandFor: createCommandFactory(autonomyLease, () => nowStr),
      executor: { executorId: 'wake-executor-2' },
      claimExpiresAt: () => endStr,
      readFact: async () => ({ value: true, state: 'known', source: 'fact', observedAt: nowStr }),
      verifyResult: async () => 'succeeded',
      now: () => nowStr,
    });

    const context: HelmToolExecutionContext = { runId, sessionId: ownership.sessionId, mode: 'primary' };
    const [res1, res2] = await Promise.all([d1.dispatch(context), d2.dispatch(context)]);
    assert.equal(invokeCount, 1);
    const handled = [...res1, ...res2].filter((r) => r.state === 'handled').length;
    assert.equal(handled, 1);
  } finally { host.close(); await rm(root, { recursive: true, force: true }); }
});

test('lease expiry, revocation, or invalid command identity reject execution', async () => {
  for (const scenario of ['expired-autonomy', 'revoked-autonomy', 'wrong-command'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'helm-wake-fence-'));
    let currTime = nowStr;
    const host = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: () => currTime });
    try {
      const runId = `run-fence-${scenario}`;
      const { ownership, autonomyLease } = createFixtures(runId);
      host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['orchestrator.wake'], expiresAt: endStr, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
      host.recordAutonomyLease(autonomyLease);
      host.acquireOwnership(ownership, 0);

      const supervisor = new EventSupervisor(host.supervisorLog(), () => currTime);
      supervisor.record({
        runId, mapNodeId: 'node', source: 'worker', sourceEventId: `evt-${scenario}`, group: 'group-1',
        observedAt: nowStr, kind: 'worker.failed', evidenceRefs: [], needsJudgement: true,
      });

      let invokeCount = 0;
      const driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'> = {
        async send_event() {},
        async invoke() { invokeCount++; return { resultRef: 'res-fence' }; },
      };

      if (scenario === 'revoked-autonomy') {
        host.revokeAutonomyLease(autonomyLease.leaseId);
      } else if (scenario === 'expired-autonomy') {
        currTime = '2026-09-16T03:00:00Z'; // Past endStr
      }

      const cmdFactory = createCommandFactory(autonomyLease, () => currTime);
      const customFactory = (wake: Wake, owner: OrchestratorLease, payload: WakeDeliveryPayload) => {
        const cmd = cmdFactory(wake, owner, payload);
        if (scenario === 'wrong-command') {
          return { ...cmd, commandId: 'wrong-id' };
        }
        return cmd;
      };

      const dispatcher = new HostWakeDispatcher({
        host,
        driver,
        commandFor: customFactory,
        executor: { executorId: 'wake-executor' },
        claimExpiresAt: () => endStr,
        readFact: async () => ({ value: true, state: 'known', source: 'fact', observedAt: currTime }),
        verifyResult: async () => 'succeeded',
        now: () => currTime,
      });

      const context: HelmToolExecutionContext = { runId, sessionId: ownership.sessionId, mode: 'primary' };
      if (scenario === 'wrong-command') {
        await assert.rejects(dispatcher.dispatch(context));
      } else {
        const res = await dispatcher.dispatch(context);
        assert.notEqual(res[0]?.state, 'handled');
      }
      assert.equal(invokeCount, 0);
    } finally { host.close(); await rm(root, { recursive: true, force: true }); }
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'helm-wake-boundary-'));
  let clock = nowStr;
  const now = () => clock;
  const host = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now });
  const { ownership, autonomyLease } = createFixtures('boundary');
  host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['orchestrator.wake'], expiresAt: endStr, maxConcurrency: 2, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
  host.recordAutonomyLease(autonomyLease);
  host.acquireOwnership(ownership, 0);
  const context: HelmToolExecutionContext = { runId: ownership.runId, sessionId: ownership.sessionId, mode: 'primary' };
  const events = new EventSupervisor(host.supervisorLog(), now);
  const signal = (sourceEventId: string) => events.record({ runId: ownership.runId, mapNodeId: 'node', source: 'worker', sourceEventId, group: 'group', observedAt: now(), kind: 'worker.failed', evidenceRefs: [], needsJudgement: true });
  const binding = (driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'>) => ({
    host, driver, commandFor: createCommandFactory(autonomyLease, now), executor: { executorId: 'boundary' },
    claimExpiresAt: () => endStr, readFact: async () => { throw new Error('unexpected precondition'); },
    verifyResult: async (ref: string, ctx: HelmToolExecutionContext) => (await host.artifactsFor(ctx).readInvocation(ref)).outcome, now,
  });
  return { root, host, now, ownership, autonomyLease, context, events, signal, binding,
    setTime: (time: string) => { clock = time; },
    close: async () => { host.close(); await rm(root, { recursive: true, force: true }); } };
}

test('authority loss during send_event fences invocation, including exact expiry and takeover', async () => {
  for (const scenario of ['expiry', 'revocation', 'takeover', 'invalid-time'] as const) {
    const f = await fixture(); let invokes = 0; let sent = 0;
    try {
      f.signal('first');
      const driver = { async send_event() {
        sent++;
        if (scenario === 'expiry') f.setTime(endStr);
        if (scenario === 'invalid-time') f.setTime('invalid');
        if (scenario === 'revocation') f.host.revokeAutonomyLease(f.autonomyLease.leaseId);
        if (scenario === 'takeover') f.host.acquireOwnership({ ...f.ownership, leaseId: 'next', sessionId: 'next', epoch: 2 }, 1);
      }, async invoke() { invokes++; return { resultRef: '' }; } };
      await new HostWakeDispatcher(f.binding(driver)).dispatch(f.context);
      assert.equal(sent, 1); assert.equal(invokes, 0);
    } finally { await f.close(); }
  }
});

test('failed, missing, wrong-kind and uncertain receipts never acknowledge or replay after takeover', async () => {
  for (const outcome of ['failed', 'unknown', 'missing', 'wrong-kind'] as const) {
    const f = await fixture(); let invokes = 0;
    try {
      f.signal('first');
      const driver = { async send_event() {}, async invoke() {
        invokes++;
        const artifacts = f.host.artifactsFor(f.context);
        return { resultRef: outcome === 'missing' ? '' : outcome === 'wrong-kind'
          ? await artifacts.writeText('claim', 'succeeded')
          : await artifacts.saveInvocation({ driver: 'astra', sessionId: f.context.sessionId, outcome, text: 'claims success' }) };
      } };
      const d = new HostWakeDispatcher(f.binding(driver));
      assert.notEqual((await d.dispatch(f.context))[0]?.state, 'handled');
      f.signal('second'); await d.dispatch(f.context);
      const replacement = { ...f.ownership, leaseId: 'next', sessionId: 'next', epoch: 2 };
      f.host.acquireOwnership(replacement, 1);
      await new HostWakeDispatcher(f.binding(driver)).dispatch({ ...f.context, sessionId: 'next' });
      assert.equal(invokes, 1); assert.equal(f.events.pending(replacement)[0]?.causes.length, 2);
    } finally { await f.close(); }
  }
});

test('queued delivery keeps original objective and context is captured before serial dispatch', async () => {
  const f = await fixture();
  try {
    f.signal('queued'); const wake = f.events.recordWakes(f.ownership)[0]!;
    const originalRef = await f.host.artifactsFor(f.context).writeText('objective', 'original payload');
    const payload: WakeDeliveryPayload = { wake: { ...wake, causes: [...wake.causes], evidenceRefs: [] }, objectiveRef: originalRef, contextRefs: [] };
    const command = createCommandFactory(f.autonomyLease, f.now)(wake, f.ownership, payload);
    f.host.admitOrchestrator(command, f.context, 'trusted-host');
    let sentRef = ''; let invokedRef = '';
    const driver = { async send_event(input: { eventRef: string }) { sentRef = input.eventRef; }, async invoke(input: { objectiveRef: string }) {
      invokedRef = input.objectiveRef;
      return { resultRef: await f.host.artifactsFor(f.context).saveInvocation({ driver: 'astra', sessionId: f.context.sessionId, outcome: 'succeeded', text: 'done' }) };
    } };
    const caller = { ...f.context };
    const dispatch = new HostWakeDispatcher(f.binding(driver)).dispatch(caller);
    caller.sessionId = 'tampered-after-enqueue';
    assert.equal((await dispatch)[0]?.state, 'handled');
    assert.equal(sentRef, originalRef); assert.equal(invokedRef, originalRef);
  } finally { await f.close(); }
});

test('two host connections racing differently grouped wakes cannot invoke overlapping causes twice', async () => {
  const f = await fixture();
  const other = await openHost({ stateDirectory: f.root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now: f.now });
  try {
    f.signal('one');
    let entered!: () => void; let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let invokes = 0;
    const driver = { async send_event() {}, async invoke() {
      invokes++; return { resultRef: await f.host.artifactsFor(f.context).saveInvocation({ driver: 'astra', sessionId: f.context.sessionId, outcome: 'succeeded', text: 'done' }) };
    } };
    const originalPerform = f.host.performAdmitted.bind(f.host);
    f.host.performAdmitted = async (...args) => { entered(); await held; return originalPerform(...args); };
    const first = new HostWakeDispatcher(f.binding(driver)).dispatch(f.context);
    await enteredPromise;
    f.signal('two');
    const second = await new HostWakeDispatcher({ ...f.binding(driver), host: other }).dispatch(f.context);
    assert.notEqual(second[0]?.state, 'handled');
    release(); await first;
    assert.equal(invokes, 1);
    assert.equal(f.events.pending(f.ownership)[0]?.causes.length, 1);
  } finally { other.close(); await f.close(); }
});
