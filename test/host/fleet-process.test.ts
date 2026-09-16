import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod/v3';
import type { Attempt, Command } from '../../src/contracts/index.js';
import { openHost } from '../../src/host/index.js';
import { PiWorkerFleet, type WorkerSpawnInput } from '../../src/host/worker-fleet.js';
import type { ProcessIdentity, ProcessObservation, ProcessProbe } from '../../src/host/process-liveness.js';
import type { HelmToolExecutionContext } from '../../src/runtime/orchestrator/index.js';
import type { PiNativeWorker } from '../../src/runtime/pi/index.js';
import { wakeDeliveryPayloadSchema } from '../../src/host/wake-dispatcher.js';
import { WorkspaceManager } from '../../src/workspace/index.js';
import { EventSupervisor } from '../../src/supervisor/index.js';

const exec = promisify(execFile);
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

class FakeProcessProbe implements ProcessProbe {
  capturedIdentity: ProcessIdentity | undefined = {
    hostId: 'test-host',
    bootId: 'boot-12345',
    pid: 9999,
    startedAt: new Date().toISOString(),
  };
  observationResponse: ProcessObservation | undefined = undefined;
  throwOnObserve: Error | undefined = undefined;
  captureCalls = 0;
  observeCalls = 0;
  onObserve: (() => Promise<void>) | undefined;

  async capture(): Promise<ProcessIdentity | undefined> {
    this.captureCalls++;
    return this.capturedIdentity;
  }

  async observe(_identity: ProcessIdentity): Promise<ProcessObservation> {
    this.observeCalls++;
    await this.onObserve?.();
    if (this.throwOnObserve) {
      throw this.throwOnObserve;
    }
    if (this.observationResponse) {
      return this.observationResponse;
    }
    return {
      state: 'same-process',
      observedAt: new Date().toISOString(),
      reason: 'alive',
    };
  }
}

test('fleet process liveness integration: identity storage, probe observation, and idempotent wakes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm3-fleet-process-test-'));
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  const context: HelmToolExecutionContext = { runId: 'run', sessionId: 'session', mode: 'primary' };

  const currentStamp = new Date().toISOString();
  let nowFn = () => new Date().toISOString();

  let plane!: Awaited<ReturnType<typeof openHost>>;
  let plane2: Awaited<ReturnType<typeof openHost>> | undefined;
  let workspace!: WorkspaceManager;
  let starts = 0;
  let runs = 0;
  const probe = new FakeProcessProbe();

  const terminalWaits: Promise<void>[] = [];
  let hangingRunResolve: (() => void) | undefined;
  const hangingRunPromise = new Promise<void>((resolve) => { hangingRunResolve = resolve; });

  try {
    await mkdir(repo);
    await exec('git', ['init', repo]);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();

    const kinds = {
      'orchestrator.wake': { payloadSchema: wakeDeliveryPayloadSchema },
      'worker.spawn': {
        payloadSchema: z.object({
          workerId: z.string(), attemptId: z.string(), modelId: z.literal('offline'),
          modelProvider: z.literal('faux'), modelApi: z.literal('fixture'), role: z.literal('builder'),
          inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1),
          dataPolicy: z.literal('public-only'),
        }).strict(),
        modelSelection: () => ({ modelId: 'offline', role: 'builder', requiredCapabilities: ['build'], dataClassification: 'public' as const }),
      },
    };

    const later = new Date(Date.now() + 86400000).toISOString();
    const leaseExpiry = new Date(Date.now() + 60000).toISOString();

    plane = await openHost({ stateDirectory: state, now: () => nowFn(), kinds });
    workspace = new WorkspaceManager({ stateRoot: join(root, 'workspace') });

    plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn'], expiresAt: later, maxConcurrency: 8, maxAttemptsPerNode: 8, poolLimits: [], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn'], issuedAt: currentStamp, expiresAt: leaseExpiry, maxConcurrency: 8, maxAttemptsPerNode: 8, poolLimits: [], protectedReserves: [] });
    plane.recordModelFact({ modelId: 'offline', provider: 'faux', poolId: 'none', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: currentStamp });
    plane.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'session', epoch: 1, issuedAt: currentStamp, expiresAt: later }, 0);

    let activeWorkerInstance: { sessionId: string; isActive: boolean } | undefined;

    const binding = (hostPlane: typeof plane = plane) => ({
      host: hostPlane,
      workspaceManager: workspace,
      processProbe: probe,
      executor: { executorId: 'fleet' },
      claimExpiresAt: () => later,
      readFact: async () => ({ value: true, state: 'known' as const, source: 'fixture', observedAt: new Date().toISOString() }),
      spawnCommand(input: WorkerSpawnInput, workerId: string, attemptId: string): Command {
        const payload = { workerId, attemptId, modelId: input.modelId, modelProvider: 'faux' as const, modelApi: 'fixture' as const, role: input.role, inputDigest: digest({ ...input, contextRefs: [...input.contextRefs] }), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const };
        return { schemaVersion: 1, commandId: `spawn-${workerId}`, kind: 'worker.spawn', idempotencyKey: `spawn-${workerId}`, payloadHash: digest(payload), payload, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: new Date().toISOString(), notAfter: later, expected: [], requiredEvidence: [] };
      },
      inputDigest: (command: Command) => (command.payload as { inputDigest: string }).inputDigest,
      stopCommand: () => { throw new Error('stop not used in test'); },
      attempt(command: Command, workerId: string): Attempt {
        return { attemptId: `attempt-${workerId}`, mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'faux', capability: 'build', poolId: 'none', workspace: join(root, workerId), baseSha, contextManifestHash: 'sha256:context', leaseId: 'auto', sessionIds: [], commandIds: [command.commandId], startedAt: new Date().toISOString(), evidenceRefs: [], usageRefs: [], findingRefs: [] };
      },
      workspace: (_command: Command, workerId: string, attempt: Attempt) => ({
        repository: repo,
        destination: join(root, workerId),
        branch: workerId,
        baseSha,
        owner: { attemptId: attempt.attemptId, generation: 1, expiresAt: later },
        policy: { writableRoots: ['.'] },
      }),
      start: async () => {
        starts++;
        const fixedSessionId = `pi-session-${starts}`;
        const worker = {
          sessionId: fixedSessionId,
          isActive: true,
          modelIdentity: { modelId: 'offline', provider: 'faux', api: 'fixture' },
          contextOccupancy: {},
          async run() {
            runs++;
            await hangingRunPromise;
            worker.isActive = false;
            return {
              result: { status: 'succeeded' as const, summary: 'done', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'none' },
              artifacts: [],
            };
          },
          async persistedSession() {
            return { sessionId: fixedSessionId, sessionFile: 'fixture', historyHash: `sha256:${'a'.repeat(64)}`, branchDigest: `sha256:${'b'.repeat(64)}` };
          },
          async stopLocal() {
            worker.isActive = false;
            return 'stopped' as const;
          },
          dispose() {
            worker.isActive = false;
          },
        };
        activeWorkerInstance = worker;
        return worker as unknown as PiNativeWorker;
      },
      prompt: () => 'fixture',
      correction: () => 'fixture',
    });

    const artifacts = plane.artifactsFor(context);
    const objectiveRef = await artifacts.writeText('objective', 'objective');
    const acceptanceRef = await artifacts.writeText('acceptance', 'acceptance');

    // Case 1: Process identity stored for launch
    const fleet1 = new PiWorkerFleet(binding(plane));
    const worker1 = await fleet1.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' });
    terminalWaits.push(fleet1.waitForTerminal(worker1.workerId));
    assert.equal(probe.captureCalls, 1, 'processProbe.capture called on spawn');
    assert.equal(starts, 1);
    assert.equal(runs, 1);
    assert.equal(activeWorkerInstance?.sessionId, worker1.sessionId);

    const launchRef = (await plane.snapshot('run')).commands[0]!.observations[0]!.evidenceRefs[0]!;
    const rawLaunchText = await plane.readFleetEffect('run', launchRef);
    const parsedLaunch = JSON.parse(rawLaunchText);
    assert.ok(parsedLaunch.ownerProcess, 'ownerProcess identity stored in durable launch record');
    assert.equal(parsedLaunch.ownerProcess.hostId, 'test-host');
    assert.equal(parsedLaunch.ownerProcess.pid, 9999);

    // Case 2: Inspect exposes state not private identity; live stays known locally
    const inspected = await fleet1.inspect(context, worker1.workerId);
    assert.equal(inspected.live, 'known');
    assert.ok(inspected.ownerProcessObservation);
    assert.equal(inspected.ownerProcessObservation.state, 'same-process');
    assert.equal((inspected as unknown as { ownerProcess?: unknown }).ownerProcess, undefined, 'private ownerProcess identity must not leak into model-facing inspect');

    // Case 2b: Test probe stale/future/malformed/throw becomes unknown with no exception leakage
    probe.throwOnObserve = new Error('simulated probe connection failure');
    const inspectThrow = await fleet1.inspect(context, worker1.workerId);
    assert.equal(inspectThrow.ownerProcessObservation?.state, 'unknown');
    assert.equal(inspectThrow.ownerProcessObservation?.reason, 'owner process probe failed');
    probe.throwOnObserve = undefined;

    probe.observationResponse = { state: 'same-process', observedAt: new Date(Date.now() - 40000).toISOString(), reason: 'stale-stamp' };
    const inspectStale = await fleet1.inspect(context, worker1.workerId);
    assert.equal(inspectStale.ownerProcessObservation?.state, 'unknown');
    assert.equal(inspectStale.ownerProcessObservation?.reason, 'owner process probe observation is stale');

    probe.observationResponse = { state: 'same-process', observedAt: new Date(Date.now() + 40000).toISOString(), reason: 'future-stamp' };
    const inspectFuture = await fleet1.inspect(context, worker1.workerId);
    assert.equal(inspectFuture.ownerProcessObservation?.state, 'unknown');
    assert.equal(inspectFuture.ownerProcessObservation?.reason, 'owner process probe observation is from the future');

    probe.observationResponse = { state: 'same-process', observedAt: 'malformed-stamp', reason: 'bad-stamp' };
    const inspectMalformed = await fleet1.inspect(context, worker1.workerId);
    assert.equal(inspectMalformed.ownerProcessObservation?.state, 'unknown');
    assert.equal(inspectMalformed.ownerProcessObservation?.reason, 'owner process probe timestamp is malformed');

    // Reset probe to fresh alive observation
    probe.observationResponse = undefined;

    // Case 3: New fleet loses handle, live stays unknown, no false terminal, no new worker
    const fleet2 = new PiWorkerFleet(binding(plane));
    const inspected2 = await fleet2.inspect(context, worker1.workerId);
    assert.equal(inspected2.live, 'unknown', 'live stays unknown without local handle');
    assert.equal(inspected2.state, 'unknown', 'unhandled non-terminal worker inspects as unknown state');
    assert.notEqual(inspected2.state, 'terminal', 'no false terminal');
    assert.equal(starts, 1, 'no new worker started');
    assert.equal(runs, 1, 'no extra run');

    // observeProcesses with alive process and matching owner is quiet
    await fleet2.observeProcesses('run');
    let supervisorSignals = plane.createSupervisor().log().readEvents('supervisor:run').filter(ev => ev.kind === 'supervisor.signal');
    assert.equal(supervisorSignals.length, 0, 'same-process observation with matching owner is quiet');

    // Case 4: Dead owner causes exactly one durable pending wake across repeat, new fleet, and second host connection to same DB
    plane2 = await openHost({ stateDirectory: state, now: () => nowFn(), kinds });
    const fleetFromSecondHost = new PiWorkerFleet(binding(plane2));
    probe.observationResponse = { state: 'not-running', observedAt: new Date().toISOString(), reason: 'process exited' };
    await Promise.all([fleet2.observeProcesses('run'), fleetFromSecondHost.observeProcesses('run')]);
    assert.equal(plane.createSupervisor().log().readEvents('run').filter(ev => ev.kind === 'reconciliation.ambiguous').length, 1, 'two connections race to append one durable observation');
    supervisorSignals = plane.createSupervisor().log().readEvents('supervisor:run').filter(ev => ev.kind === 'supervisor.signal');
    assert.equal(supervisorSignals.length, 1, 'dead process causes supervisor signal');
    assert.equal(supervisorSignals[0]!.kind, 'supervisor.signal');
    assert.equal((supervisorSignals[0]!.payload as { kind: string }).kind, 'reconciliation.ambiguous');
    assert.equal((supervisorSignals[0]!.payload as { needsJudgement: boolean }).needsJudgement, true);

    const ownerLease = { runId: 'run', leaseId: 'owner', owner: 'fable' as const, sessionId: 'session', epoch: 1, issuedAt: currentStamp, expiresAt: later };
    let supervisor = new EventSupervisor(plane.createSupervisor().log(), () => new Date().toISOString());
    let wakes = supervisor.pending(ownerLease);
    assert.equal(wakes.length, 1, 'wake created for ambiguous dead process signal');

    // Repeat observation on same fleet
    await fleet2.observeProcesses('run');
    supervisorSignals = plane.createSupervisor().log().readEvents('supervisor:run').filter(ev => ev.kind === 'supervisor.signal');
    assert.equal(supervisorSignals.length, 1, 'repeated observation does not emit duplicate signal');
    supervisor = new EventSupervisor(plane.createSupervisor().log(), () => new Date().toISOString());
    wakes = supervisor.pending(ownerLease);
    assert.equal(wakes.length, 1, 'repeated observation does not create new wake');

    // Repeat observation on new fleet instance (fleet3)
    const fleet3 = new PiWorkerFleet(binding(plane));
    await fleet3.observeProcesses('run');
    supervisorSignals = plane.createSupervisor().log().readEvents('supervisor:run').filter(ev => ev.kind === 'supervisor.signal');
    assert.equal(supervisorSignals.length, 1, 'new fleet instance does not duplicate signal');
    supervisor = new EventSupervisor(plane.createSupervisor().log(), () => new Date().toISOString());
    wakes = supervisor.pending(ownerLease);
    assert.equal(wakes.length, 1, 'wake count remains exactly one across new fleet instance');

    // Repeat observation via a SECOND host connection to SAME state DB
    await fleetFromSecondHost.observeProcesses('run');
    supervisorSignals = plane2.createSupervisor().log().readEvents('supervisor:run').filter(ev => ev.kind === 'supervisor.signal');
    assert.equal(supervisorSignals.length, 1, 'second host connection sees exactly one signal');
    const supervisor2 = new EventSupervisor(plane2.createSupervisor().log(), () => new Date().toISOString());
    wakes = supervisor2.pending(ownerLease);
    assert.equal(wakes.length, 1, 'second host connection sees exactly one pending wake');

    // Concurrent observeProcesses across 2 fleet instances: same cause emits one event, no duplicate effects
    await Promise.all([
      fleet2.observeProcesses('run'),
      fleet3.observeProcesses('run'),
    ]);
    supervisorSignals = plane.createSupervisor().log().readEvents('supervisor:run').filter(ev => ev.kind === 'supervisor.signal');
    assert.equal(supervisorSignals.length, 1, 'concurrent observe across 2 fleets emits exactly one signal');

    // Case 5: Workspace ownership changed after await triggers question
    probe.observationResponse = undefined; // fresh 'same-process'
    const reservation = workspace.reservation(parsedLaunch.workspace);
    const alteredOwner = { attemptId: 'different-attempt', generation: 2, expiresAt: later };
    probe.onObserve = async () => {
      await Promise.resolve();
      workspace.transfer(reservation, reservation.owner.generation, alteredOwner);
      probe.onObserve = undefined;
    };

    // With owner mismatch, even if probe says same-process, it should emit reconciliation.ambiguous signal
    await fleet3.observeProcesses('run');
    supervisorSignals = plane.createSupervisor().log().readEvents('supervisor:run').filter(ev => ev.kind === 'supervisor.signal');
    assert.equal(supervisorSignals.length, 2, 'owner mismatch emits new reconciliation.ambiguous signal');

    // Legacy launches without identity remain readable and surface unknown.
    probe.capturedIdentity = undefined;
    const legacy = await fleet1.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' });
    terminalWaits.push(fleet1.waitForTerminal(legacy.workerId));
    const legacyInspection = await fleet3.inspect(context, legacy.workerId);
    assert.equal(legacyInspection.ownerProcessObservation?.state, 'unknown');
    assert.equal(legacyInspection.ownerProcessObservation?.reason, 'no owner process identity recorded');
    await fleet3.observeProcesses('run');
    supervisorSignals = plane.createSupervisor().log().readEvents('supervisor:run').filter(ev => ev.kind === 'supervisor.signal');
    assert.equal(supervisorSignals.length, 3, 'missing identity creates a distinct durable cause');

    const beforeExpiry = await plane.snapshot('run');
    const rawEventsCountBefore = plane.createSupervisor().log().readEvents('supervisor:run').length;
    const probesBefore = probe.observeCalls;
    // Monitoring after authority expiry reads new facts but grants no effects.
    const expiredStamp = new Date(Date.parse(leaseExpiry) + 1000).toISOString();
    nowFn = () => expiredStamp;
    await fleet3.observeProcesses('run');
    assert.ok(probe.observeCalls > probesBefore, 'monitoring still probes after expiry');
    assert.equal(starts, 2, 'monitoring after expired lease starts no workers');
    assert.equal(runs, 2, 'monitoring after expired lease starts no model runs');
    const finalSnapshot = await plane.snapshot('run');
    assert.deepEqual(finalSnapshot.commands, beforeExpiry.commands, 'monitoring does not mutate commands or reservations');
    assert.deepEqual(finalSnapshot.attempts, beforeExpiry.attempts, 'monitoring does not clear lifecycle');
    assert.equal(plane.createSupervisor().log().readEvents('supervisor:run').length, rawEventsCountBefore, 'unchanged causes remain deduplicated after expiry');

    // Controlled clean resolution: resolve background runner, wait for terminal, then close both hosts cleanly
    hangingRunResolve?.();
    await Promise.all(terminalWaits);
  } finally {
    hangingRunResolve?.();
    await Promise.allSettled(terminalWaits);
    plane2?.close();
    plane?.close();
    workspace?.close();
    await rm(root, { recursive: true, force: true });
  }
});
