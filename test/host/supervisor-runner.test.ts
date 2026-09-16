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
import { type SupervisorSignal, type Wake } from '../../src/supervisor/index.js';
import { openHost } from '../../src/host/index.js';
import {
  HostWakeDispatcher,
  wakeDeliveryPayloadSchema,
  type WakeDeliveryPayload,
} from '../../src/host/wake-dispatcher.js';
import type { HelmToolExecutionContext } from '../../src/runtime/orchestrator/index.js';
import { HostSupervisorRunner } from '../../src/host/supervisor-runner.js';

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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'helm-runner-test-'));
  let clock = nowStr;
  const now = () => clock;
  const host = await openHost({ stateDirectory: root, kinds: { 'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema } }, now });
  const { ownership, autonomyLease } = createFixtures('runner-run');
  host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['orchestrator.wake'], expiresAt: endStr, maxConcurrency: 2, maxAttemptsPerNode: 3, poolLimits: [], protectedReserves: [] });
  host.recordAutonomyLease(autonomyLease);
  host.acquireOwnership(ownership, 0);
  const context: HelmToolExecutionContext = { runId: ownership.runId, sessionId: ownership.sessionId, mode: 'primary' };

  const createDriver = (callLog?: string[]): Pick<OrchestratorDriver, 'send_event' | 'invoke'> => ({
    async send_event() { callLog?.push('send_event'); },
    async invoke(input) {
      callLog?.push('invoke');
      const resultRef = await host.artifactsFor(context).saveInvocation({ driver: 'astra', sessionId: input.sessionId, outcome: 'succeeded', text: 'done' });
      return { resultRef };
    },
  });

  const createDispatcher = (driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'>) => {
    return new HostWakeDispatcher({
      host,
      driver,
      commandFor: createCommandFactory(autonomyLease, now),
      executor: { executorId: 'runner-test' },
      claimExpiresAt: () => endStr,
      readFact: async () => { throw new Error('unexpected precondition'); },
      verifyResult: async (ref: string, ctx: HelmToolExecutionContext) => {
        return (await host.artifactsFor(ctx).readInvocation(ref)).outcome;
      },
      now,
    });
  };

  return {
    root,
    host,
    now,
    ownership,
    autonomyLease,
    context,
    createDriver,
    createDispatcher,
    setTime: (time: string) => { clock = time; },
    close: async () => {
      host.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('observer batch -> persisted signal -> real dispatched receipt/ack', async () => {
  const f = await fixture();
  try {
    const replayCalls: string[] = [];
    const fleetDouble = {
      replaySupervisorEvents: async (runId: string) => {
        replayCalls.push(runId);
      },
    };

    const callLog: string[] = [];
    const driver = f.createDriver(callLog);
    const wakeDispatcher = f.createDispatcher(driver);

    let observed = false;
    const runner = new HostSupervisorRunner({
      context: f.context,
      host: f.host,
      fleet: fleetDouble,
      wakeDispatcher,
      observe: async () => {
        if (observed) return [];
        observed = true;
        return [
          {
            runId: f.context.runId,
            mapNodeId: 'node',
            source: 'worker',
            sourceEventId: 'evt-1',
            group: 'group-1',
            observedAt: f.now(),
            kind: 'worker.failed',
            evidenceRefs: [],
            needsJudgement: true,
          },
        ];
      },
      intervalMs: 100,
    });

    const cycle = await runner.tick(new AbortController().signal);
    assert.equal(cycle.observedSignals, 1);
    assert.equal(cycle.deliveries.length, 1);
    assert.equal(cycle.deliveries[0].state, 'handled');
    assert.equal(cycle.aborted, false);
    assert.deepEqual(replayCalls, [f.context.runId]);
    assert.ok(callLog.includes('send_event'));

    const inv = await f.host.artifactsFor(f.context).readInvocation(cycle.deliveries[0]!.resultRef!);
    assert.equal(inv.outcome, 'succeeded');
  } finally {
    await f.close();
  }
});

test('duplicate events deduplicate via log and do not re-invoke driver', async () => {
  const f = await fixture();
  try {
    const fleetDouble = {
      replaySupervisorEvents: async () => {},
    };

    const callLog: string[] = [];
    const driver = f.createDriver(callLog);
    const wakeDispatcher = f.createDispatcher(driver);

    const runner = new HostSupervisorRunner({
      context: f.context,
      host: f.host,
      fleet: fleetDouble,
      wakeDispatcher,
      observe: async () => [
        {
          runId: f.context.runId,
          mapNodeId: 'node',
          source: 'worker',
          sourceEventId: 'dup-1',
          group: 'dup-group',
          observedAt: f.now(),
          kind: 'worker.failed',
          evidenceRefs: [],
          needsJudgement: true,
        },
      ],
      intervalMs: 100,
    });

    const cycle1 = await runner.tick(new AbortController().signal);
    assert.equal(cycle1.deliveries.length, 1);
    assert.equal(cycle1.deliveries[0].state, 'handled');

    const sendCountAfter1 = callLog.filter((x) => x === 'send_event').length;
    assert.equal(sendCountAfter1, 1);

    const cycle2 = await runner.tick(new AbortController().signal);
    assert.equal(cycle2.deliveries.length, 0);
    const sendCountAfter2 = callLog.filter((x) => x === 'send_event').length;
    assert.equal(sendCountAfter2, 1);
  } finally {
    await f.close();
  }
});

test('abort while observer awaited stops process and driver invocation', async () => {
  const f = await fixture();
  try {
    const fleetDouble = { replaySupervisorEvents: async () => {} };
    const callLog: string[] = [];
    const driver = f.createDriver(callLog);
    const wakeDispatcher = f.createDispatcher(driver);

    const controller = new AbortController();
    const runner = new HostSupervisorRunner({
      context: f.context,
      host: f.host,
      fleet: fleetDouble,
      wakeDispatcher,
      observe: async (signal: AbortSignal) => {
        controller.abort();
        assert.equal(signal.aborted, true);
        return [
          {
            runId: f.context.runId,
            mapNodeId: 'node',
            source: 'worker',
            sourceEventId: 'abort-evt-1',
            group: 'abort-group',
            observedAt: f.now(),
            kind: 'worker.failed',
            evidenceRefs: [],
            needsJudgement: true,
          },
        ];
      },
      intervalMs: 100,
    });

    const cycle = await runner.tick(controller.signal);
    assert.equal(cycle.aborted, true);
    assert.equal(cycle.deliveries.length, 0);
    assert.equal(callLog.length, 0);
  } finally {
    await f.close();
  }
});

test('observation and replay continue after lease expiry, dispatcher handles fresh refusal', async () => {
  const f = await fixture();
  try {
    let replayed = false;
    let observed = false;
    const fleetDouble = {
      replaySupervisorEvents: async () => {
        replayed = true;
      },
    };

    const callLog: string[] = [];
    const driver = f.createDriver(callLog);
    const wakeDispatcher = f.createDispatcher(driver);

    const runner = new HostSupervisorRunner({
      context: f.context,
      host: f.host,
      fleet: fleetDouble,
      wakeDispatcher,
      observe: async () => {
        observed = true;
        return [
          {
            runId: f.context.runId,
            mapNodeId: 'node',
            source: 'worker',
            sourceEventId: 'expired-evt-1',
            group: 'expired-group',
            observedAt: f.now(),
            kind: 'worker.failed',
            evidenceRefs: [],
            needsJudgement: true,
          },
        ];
      },
      intervalMs: 100,
    });

    f.setTime('2026-09-16T02:30:00Z');

    const cycle = await runner.tick(new AbortController().signal);
    assert.equal(replayed, true);
    assert.equal(observed, true);
    assert.equal(cycle.observedSignals, 1);
    assert.equal(cycle.deliveries.length, 0);
    assert.equal(callLog.length, 0);
    assert.ok(f.host.supervisorLog().readEvents('supervisor:' + f.context.runId).some(event => event.kind === 'supervisor.signal'));
  } finally {
    await f.close();
  }
});

test('rejects foreign run and protects against mutable context input', async () => {
  const f = await fixture();
  try {
    const fleetDouble = { replaySupervisorEvents: async () => {} };
    const driver = f.createDriver();
    const wakeDispatcher = f.createDispatcher(driver);

    assert.throws(
      () =>
        new HostSupervisorRunner({
          context: { ...f.context, mode: 'consultant' },
          host: f.host,
          fleet: fleetDouble,
          wakeDispatcher,
          observe: async () => [],
          intervalMs: 100,
        }),
      /primary/,
    );

    const mutableContext = { ...f.context };
    const runner = new HostSupervisorRunner({
      context: mutableContext,
      host: f.host,
      fleet: fleetDouble,
      wakeDispatcher,
      observe: async () => [
        {
          runId: 'different-run',
          mapNodeId: 'node',
          source: 'worker',
          sourceEventId: 'foreign-1',
          group: 'foreign-group',
          observedAt: f.now(),
          kind: 'worker.failed',
          evidenceRefs: [],
          needsJudgement: true,
        },
      ],
      intervalMs: 100,
    });

    mutableContext.runId = 'tampered';

    await assert.rejects(
      () => runner.tick(new AbortController().signal),
      /foreign supervisor signal/,
    );
  } finally {
    await f.close();
  }
});

test('serial ticks queue properly and run prevents concurrent execution', async () => {
  const f = await fixture();
  try {
    const fleetDouble = { replaySupervisorEvents: async () => {} };
    const driver = f.createDriver();
    const wakeDispatcher = f.createDispatcher(driver);

    const executionOrder: string[] = [];
    const runner = new HostSupervisorRunner({
      context: f.context,
      host: f.host,
      fleet: fleetDouble,
      wakeDispatcher,
      observe: async () => {
        executionOrder.push('observe');
        return [];
      },
      intervalMs: 100,
    });

    const controller = new AbortController();
    const t1 = runner.tick(controller.signal);
    const t2 = runner.tick(controller.signal);
    await Promise.all([t1, t2]);
    assert.deepEqual(executionOrder, ['observe', 'observe']);

    const runController = new AbortController();
    const runPromise = runner.run(runController.signal);
    await assert.rejects(
      () => runner.run(runController.signal),
      /already running on this instance/,
    );
    runController.abort();
    await runPromise;

    const preAborted = new AbortController();
    preAborted.abort();
    await runner.run(preAborted.signal);
  } finally {
    await f.close();
  }
});

test('quiet continuous cycles spend nothing, abort the interval promptly, and propagate signal errors', async () => {
  const f = await fixture();
  try {
    let cycles = 0; const calls: string[] = []; const stop = new AbortController();
    const base = { context: f.context, host: f.host, fleet: { async replaySupervisorEvents() {} }, wakeDispatcher: f.createDispatcher(f.createDriver(calls)), intervalMs: 100 };
    const runner = new HostSupervisorRunner({ ...base, observe: async () => { if (++cycles === 3) stop.abort(); return []; } });
    await runner.run(stop.signal);
    assert.equal(cycles, 3); assert.deepEqual(calls, []);
    assert.equal((await f.host.snapshot(f.context.runId)).commands.length, 0);
    const bad = new HostSupervisorRunner({ ...base, observe: async () => [{ runId: f.context.runId, mapNodeId: 'node', source: 'observer', sourceEventId: 'invalid-time', group: 'group', observedAt: 'not-a-date', kind: 'worker.failed', evidenceRefs: [], needsJudgement: true }] });
    await assert.rejects(bad.tick(new AbortController().signal));
    assert.deepEqual(calls, [], 'a failed process promise must prevent wake dispatch');
  } finally { await f.close(); }
});

test('a queued tick waits for the preceding observation', async () => {
  const f = await fixture();
  try {
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let observations = 0;
    const runner = new HostSupervisorRunner({ context: f.context, host: f.host, fleet: { async replaySupervisorEvents() {} }, wakeDispatcher: f.createDispatcher(f.createDriver()), intervalMs: 100,
      observe: async () => { observations++; if (observations === 1) { entered(); await held; } return []; } });
    const first = runner.tick(new AbortController().signal);
    const second = runner.tick(new AbortController().signal);
    await started; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(observations, 1); release(); await Promise.all([first, second]); assert.equal(observations, 2);
  } finally { await f.close(); }
});
