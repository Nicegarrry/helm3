import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod/v3';
import type { Attempt, Command, Observation, Precondition } from '../../src/contracts/index.js';
import { openHost, type HostControlPlane } from '../../src/host/index.js';
import { PiWorkerFleet, type WorkerFleetBinding, type WorkerSpawnInput } from '../../src/host/worker-fleet.js';
import { PiNativeWorker } from '../../src/runtime/pi/index.js';
import { WorkspaceManager, type WorktreeReservation } from '../../src/workspace/index.js';

const exec = promisify(execFile);
const now = '2026-09-17T00:00:00Z';
const later = '2099-01-01T00:00:00Z';
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const context = { runId: 'run', sessionId: 'controller', mode: 'primary' as const };
const poolLimits = [{ poolId: 'offline-usd', unit: 'usd' as const, limit: 10 }];
const workerEnvelope = JSON.stringify({ status: 'succeeded', summary: 'done', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' });

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error('fixture condition did not become true before timeout');
}

type Fixture = {
  root: string;
  repo: string;
  base: string;
  host: HostControlPlane;
  manager: WorkspaceManager;
  runtime: any;
  faux: any;
  ai: any;
  fleet: PiWorkerFleet;
  binding: WorkerFleetBinding;
  closeHost(): void;
  close(): Promise<void>;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'helm3-pi-delivery-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const base = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const manager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  const faux = ai.fauxProvider({ provider: 'delivery-faux', models: [{ id: 'offline' }] });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey('delivery-faux', 'fixture');
  const model = faux.getModel()!;
  const spawnSchema = z.object({
    workerId: z.string(), attemptId: z.string(), modelId: z.string(), modelProvider: z.string(), modelApi: z.string(), role: z.string(),
    mode: z.literal('worker'), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only'),
  }).strict();
  const stopSchema = z.object({ workerId: z.string() }).strict();
  const modelSchema = z.object({ effectId: z.string(), kind: z.literal('model.request'), upperBound: z.number().positive() }).strict();
  const writeSchema = z.object({ effectId: z.string(), kind: z.literal('workspace.write') }).strict();
  const host = await openHost({ stateDirectory: join(root, 'host-state'), now: () => now, kinds: {
    'worker.spawn': { payloadSchema: spawnSchema },
    'worker.stop': { payloadSchema: stopSchema },
    'pi.model': { payloadSchema: modelSchema, resourceRequest: value => ({ poolId: 'offline-usd', unit: 'usd', upperBound: modelSchema.parse(value).upperBound, consumer: 'worker' }) },
    'pi.write': { payloadSchema: writeSchema },
  } });
  host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn', 'worker.stop', 'pi.model', 'pi.write'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 2, poolLimits, protectedReserves: [] });
  host.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn', 'worker.stop', 'pi.model', 'pi.write'], issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 2, poolLimits, protectedReserves: [] });
  host.recordModelFact({ modelId: model.id, provider: model.provider, poolId: 'offline-usd', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: now });
  host.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'controller', epoch: 1, issuedAt: now, expiresAt: later }, 0);
  const commandForPiEffect = (effect: { effectId: string; kind: 'model.request' | 'workspace.write' }): Command => {
    const payload = effect.kind === 'model.request' ? { effectId: effect.effectId, kind: effect.kind, upperBound: 3 } : { effectId: effect.effectId, kind: effect.kind };
    return { schemaVersion: 1, commandId: effect.effectId, kind: effect.kind === 'model.request' ? 'pi.model' : 'pi.write', idempotencyKey: effect.effectId, payloadHash: hash(payload), payload, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'trusted-pi', runId: 'run', origin: 'worker', leaseId: 'auto', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], requiredEvidence: [] } as Command;
  };
  const inputDigest = (command: Command) => (command.payload as { inputDigest: string }).inputDigest;
  const spawnCommand = (input: WorkerSpawnInput, workerId: string, attemptId: string): Command => {
    const payload = { workerId, attemptId, modelId: model.id, modelProvider: model.provider, modelApi: model.api, role: input.role, mode: 'worker' as const, inputDigest: hash({ ...input, contextRefs: [...input.contextRefs] }), baseSha: base, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const };
    return { schemaVersion: 1, commandId: `spawn:${workerId}`, kind: 'worker.spawn', idempotencyKey: `spawn:${workerId}`, payloadHash: hash(payload), payload, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'trusted-fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: now, notAfter: later, expected: [], requiredEvidence: [] };
  };
  const attempt = (command: Command, workerId: string): Attempt => {
    const payload = command.payload as { attemptId: string; modelId: string; role: string };
    return { attemptId: payload.attemptId, mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: payload.role, model: payload.modelId, family: 'faux', provider: model.provider, capability: 'build', poolId: 'offline-usd', workspace: join(root, workerId), baseSha: base, contextManifestHash: 'sha256:fixture', leaseId: 'auto', sessionIds: [], commandIds: [], startedAt: now, evidenceRefs: [], usageRefs: [], findingRefs: [] };
  };
  const binding: WorkerFleetBinding = {
    host, workspaceManager: manager, executor: { executorId: 'fleet' }, claimExpiresAt: () => later,
    readFact: async (_precondition: Precondition): Promise<Observation<boolean>> => ({ value: true, state: 'known', source: 'fixture', observedAt: now }),
    spawnCommand: (input, workerId, attemptId) => spawnCommand(input, workerId, attemptId),
    inputDigest,
    stopCommand: (record) => {
      const payload = { workerId: record.workerId };
      return { schemaVersion: 1, commandId: `stop:${record.workerId}`, kind: 'worker.stop', idempotencyKey: `stop:${record.workerId}`, payloadHash: hash(payload), payload, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'trusted-fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: now, notAfter: later, expected: [], requiredEvidence: [] };
    },
    attempt,
    workspace: (command, workerId, value) => ({ repository: repo, destination: join(root, workerId), branch: workerId, baseSha: value.baseSha, owner: { attemptId: value.attemptId, generation: 1, expiresAt: later }, policy: { writableRoots: ['.'] } }),
    start: async (command, workspace: WorktreeReservation) => {
      const payload = command.payload as { attemptId: string };
      return PiNativeWorker.start({ commandId: command.commandId, attemptId: payload.attemptId, workspace, owner: workspace.owner, workspaceManager: manager, authority: host.piAuthority({ attemptId: payload.attemptId, actorId: 'trusted-pi', executorId: 'native-pi', commandForEffect: commandForPiEffect }), journal: host.artifactsFor(context).journalForTrustedPi(), stateRoot: join(root, 'pi-state', payload.attemptId), modelRuntime: runtime, model });
    },
    prompt: () => 'Return the worker result JSON.',
    correction: () => 'Return valid worker result JSON.',
  };
  const fleet = new PiWorkerFleet(binding);
  const objectiveRef = await host.artifactsFor(context).writeText('fixture.objective', 'exercise native delivery recovery');
  const acceptanceRef = await host.artifactsFor(context).writeText('fixture.acceptance', 'preserve unknown billing and recover stop');
  let hostIsOpen = true;
  const closeHost = () => { if (hostIsOpen) { host.close(); hostIsOpen = false; } };
  const close = async () => { closeHost(); manager.close(); await rm(root, { recursive: true, force: true }); };
  return { root, repo, base, host, manager, runtime, faux, ai, fleet, binding, closeHost, close };
}

test('real native Pi drained error reconciles one model command, retains its monetary reservation, and frees capacity after stop', async () => {
  const fixture = await createFixture();
  try {
    const objectiveRef = await fixture.host.artifactsFor(context).writeText('test.objective', 'native error');
    const acceptanceRef = await fixture.host.artifactsFor(context).writeText('test.acceptance', 'stop proof');
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage('provider error', { stopReason: 'error', errorMessage: 'private-provider-body' })]);
    const launch = await fixture.fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' });
    await fixture.fleet.waitForTerminal(launch.workerId);
    const inspected = await fixture.fleet.inspect(context, launch.workerId);
    assert.equal(inspected.state, 'unknown', 'fleet worker outcome remains unknown even when delivery is proven failed');
    const snapshot = await fixture.host.snapshot('run');
    const model = snapshot.commands.find((entry) => entry.command.kind === 'pi.model');
    assert.ok(model, JSON.stringify(snapshot));
    assert.equal(model?.status, 'failed', JSON.stringify(model));
    assert.equal(snapshot.reservations[0]?.state, 'reserved', 'failed delivery does not claim billing absence');
    assert.equal(snapshot.reservations[0]?.settledActual, undefined);
    assert.equal(snapshot.attemptLifecycles[0]?.state, 'finished', 'capacity releases only after the native stop proof');
    assert.equal(fixture.faux.state.callCount, 1);
    assert.ok(!JSON.stringify(snapshot).includes('private-provider-body'));
    const events = fixture.host.createSupervisor().log().readEvents('run');
    assert.ok(events.some((event) => event.kind === 'worker.failed'), 'native failure is surfaced as a durable fleet event for supervisor wake processing');
    // A second real native launch proves the first finished attempt released
    // the concurrency slot while its unknown monetary reservation remained.
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage(workerEnvelope)]);
    const objectiveTwo = await fixture.host.artifactsFor(context).writeText('test.second.objective', 'capacity released');
    const acceptanceTwo = await fixture.host.artifactsFor(context).writeText('test.second.acceptance', 'second native worker');
    const second = await fixture.fleet.spawn(context, { objectiveRef: objectiveTwo, acceptanceRef: acceptanceTwo, contextRefs: [], modelId: 'offline', role: 'builder' });
    await fixture.fleet.waitForTerminal(second.workerId);
    assert.equal((await fixture.fleet.inspect(context, second.workerId)).state, 'terminal');
    assert.equal((await fixture.host.snapshot('run')).attemptLifecycles.find((item) => item.attemptId === second.attemptId)?.state, 'finished');
  } finally { await fixture.close(); }
});

test('receipt and stop proof replay after a failed first observation, preserving original unknown evidence and idempotently recovering lifecycle', async () => {
  const fixture = await createFixture();
  let restarted: HostControlPlane | undefined;
  let restartedFleet: PiWorkerFleet | undefined;
  try {
    const objectiveRef = await fixture.host.artifactsFor(context).writeText('test.restart.objective', 'restart delivery');
    const acceptanceRef = await fixture.host.artifactsFor(context).writeText('test.restart.acceptance', 'replay receipt');
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage('provider error', { stopReason: 'error', errorMessage: 'private-provider-body' })]);
    const original = fixture.host.reconcilePiModelDeliveryFailure.bind(fixture.host);
    let allowRecovery = false;
    (fixture.host as unknown as { reconcilePiModelDeliveryFailure: typeof fixture.host.reconcilePiModelDeliveryFailure }).reconcilePiModelDeliveryFailure = async proof => { if (!allowRecovery) throw new Error('fixture observation write failed'); return original(proof); };
    const launch = await fixture.fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' });
    await fixture.fleet.waitForTerminal(launch.workerId);
    const before = await fixture.host.snapshot('run');
    const modelBefore = before.commands.find((entry) => entry.command.kind === 'pi.model');
    assert.ok(modelBefore, JSON.stringify(before));
    assert.equal(modelBefore?.status, 'unknown', 'receipt may exist while its Core observation is still unknown');
    assert.equal(before.attemptLifecycles[0]?.state, 'unknown', 'stop projection remains conservative while model command is unknown');
    allowRecovery = true;
    // Every forged proof below is durably written under the identity it
    // claims. The validator must reject it without changing the unknown
    // command or its still-held reservation.
    const deliveryJournal = fixture.host.artifactsFor(context).journalForTrustedPi();
    const actualEffectId = modelBefore!.command.commandId;
    const actualIdentity = `pi-model-delivery-failure:${launch.attemptId}:${actualEffectId}`;
    const actualMetadata = await deliveryJournal.metadataFor(actualIdentity);
    assert.ok(actualMetadata, 'native runtime wrote the delivery receipt');
    const actualReceipt = JSON.parse((await deliveryJournal.read(actualMetadata!.raw, actualIdentity)).toString('utf8')) as Record<string, unknown>;
    const unchanged = () => fixture.host.snapshot('run').then(snapshot => ({ lifecycles: snapshot.attemptLifecycles, status: snapshot.commands.find(entry => entry.command.commandId === actualEffectId)?.status, reservations: snapshot.reservations.map(entry => ({ commandId: entry.commandId, state: entry.state, settledActual: entry.settledActual })) }));
    const beforeForged = await unchanged();
    const rejectForged = async (receipt: Record<string, unknown>, sourceIdentity: string, expected = /native delivery receipt/) => {
      const receiptRef = await deliveryJournal.append({ source: 'pi.model.delivery.failure', sourceIdentity, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(receipt)) });
      await assert.rejects(fixture.host.reconcilePiModelDeliveryFailure({ receipt: receipt as any, receiptRef }), expected);
      assert.deepEqual(await unchanged(), beforeForged);
    };
    await rejectForged({ ...actualReceipt, attemptId: 'foreign-attempt' }, `pi-model-delivery-failure:foreign-attempt:${actualEffectId}`);
    await rejectForged({ ...actualReceipt, effectId: 'foreign-effect', modelCommandId: 'foreign-effect' }, `pi-model-delivery-failure:${launch.attemptId}:foreign-effect`);
    await rejectForged({ ...actualReceipt, effectId: 'foreign-model-effect', modelCommandId: actualEffectId, model: 'foreign-model' }, `pi-model-delivery-failure:${launch.attemptId}:foreign-model-effect`, /session or model provenance/);
    await rejectForged({ ...actualReceipt, effectId: 'foreign-session-effect', modelCommandId: actualEffectId, sessionId: 'foreign-session' }, `pi-model-delivery-failure:${launch.attemptId}:foreign-session-effect`, /session/);
    await assert.rejects(fixture.host.reconcilePiModelDeliveryFailure({ receipt: { ...actualReceipt, sessionId: 'foreign-session' } as any, receiptRef: actualMetadata!.raw }), /bytes changed|metadata/);
    await assert.rejects(fixture.host.reconcilePiModelDeliveryFailure({ receipt: { ...actualReceipt, streamEnded: false } as any, receiptRef: actualMetadata!.raw }), /invalid|streamEnded/);
    await assert.rejects(fixture.host.reconcilePiModelDeliveryFailure({ receipt: actualReceipt as any, receiptRef: { ref: 'raw:missing', hash: 'sha256:' + '0'.repeat(64), mediaType: 'application/json' } }), /metadata/);
    assert.deepEqual(await unchanged(), beforeForged);
    fixture.host.revokeAutonomyLease('auto');
    fixture.host.recordModelFact({ modelId: 'offline', provider: 'delivery-faux', poolId: 'offline-usd', enabled: false, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_unavailable', factVersion: 2, observedAt: now });
    fixture.closeHost();
    restarted = await openHost({ stateDirectory: join(fixture.root, 'host-state'), now: () => now, kinds: {
      'worker.spawn': { payloadSchema: z.object({ workerId: z.string(), attemptId: z.string(), modelId: z.string(), modelProvider: z.string(), modelApi: z.string(), role: z.string(), mode: z.literal('worker'), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict() },
      'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() },
      'pi.model': { payloadSchema: z.object({ effectId: z.string(), kind: z.literal('model.request'), upperBound: z.number().positive() }).strict(), resourceRequest: value => ({ poolId: 'offline-usd', unit: 'usd', upperBound: (value as { upperBound: number }).upperBound, consumer: 'worker' }) },
      'pi.write': { payloadSchema: z.object({ effectId: z.string(), kind: z.literal('workspace.write') }).strict() },
    } });
    restartedFleet = new PiWorkerFleet({ ...fixture.binding, host: restarted });
    await restartedFleet.replaySupervisorEvents('run');
    const deliveryCount = await restarted.reconcilePiModelDeliveryFailures('run', launch.attemptId);
    assert.equal(deliveryCount, 1);
    const once = await restarted.snapshot('run');
    assert.equal(once.commands.find((entry) => entry.command.kind === 'pi.model')?.status, 'failed');
    assert.deepEqual(once.commands.find((entry) => entry.command.kind === 'pi.model')?.observations.slice(0, modelBefore.observations.length), modelBefore.observations, 'recovery preserves the original unknown observation verbatim');
    assert.equal(once.attemptLifecycles[0]?.state, 'finished');
    assert.equal(await restarted.reconcilePiModelDeliveryFailures('run', launch.attemptId), 1, 'repeated delivery replay is idempotent');
    const stopped = await restarted.reconcilePiStoppedReceipts('run', launch.attemptId);
    assert.equal(stopped, 1);
    assert.equal((await restarted.snapshot('run')).attemptLifecycles[0]?.state, 'finished');
    assert.equal(await restarted.reconcilePiStoppedReceipts('run', launch.attemptId), 1, 'repeated stop replay is idempotent');
    assert.equal(fixture.faux.state.callCount, 1, 'restart reconciliation never starts a provider request');
  } finally { restarted?.close(); await fixture.close(); }
});

test('missing stop evidence holds capacity and a canonical foreign-session stop proof is rejected', async () => {
  const fixture = await createFixture();
  try {
    const objectiveRef = await fixture.host.artifactsFor(context).writeText('test.reject.objective', 'foreign evidence');
    const acceptanceRef = await fixture.host.artifactsFor(context).writeText('test.reject.acceptance', 'reject evidence');
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage('provider error', { stopReason: 'error', errorMessage: 'private-provider-body' })]);
    const nativeStart = fixture.binding.start;
    (fixture.binding as { start: WorkerFleetBinding['start'] }).start = async (...args: Parameters<typeof nativeStart>) => {
      const worker = await nativeStart(...args);
      // Lab fixture: exercise fleet conservatism when the real native wrapper
      // cannot produce a trusted local stop receipt.
      (worker as any).stopLocal = async () => 'unknown';
      return worker;
    };
    const launch = await fixture.fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' });
    await fixture.fleet.waitForTerminal(launch.workerId);
    const before = await fixture.host.snapshot('run');
    const model = before.commands.find((entry) => entry.command.kind === 'pi.model');
    assert.ok(model, JSON.stringify(before));
    assert.equal(model?.status, 'failed', JSON.stringify(model));
    assert.equal(before.attemptLifecycles[0]?.state, 'unknown', 'missing stop proof retains attempt capacity');
    assert.equal(await fixture.host.reconcilePiStoppedReceipts('run', launch.attemptId), 0, 'missing stop evidence is not inferred from process termination');
    const stopCommandId = before.commands.find((entry) => entry.command.kind === 'worker.spawn')!.command.commandId;
    // Use the exact deterministic identity and source so validation reaches
    // the immutable launch/session binding rather than failing at metadata.
    const foreignReceipt = { schemaVersion: 1 as const, kind: 'pi.worker.stop' as const, commandId: stopCommandId, attemptId: launch.attemptId, sessionId: 'foreign-session', stopped: true as const, observedAt: now };
    const sourceIdentity = `pi-worker-stop:${launch.attemptId}:${stopCommandId}:foreign-session`;
    const fake = await fixture.host.artifactsFor(context).journalForTrustedPi().append({ source: 'pi.worker.stop', sourceIdentity, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(foreignReceipt)) });
    await assert.rejects(fixture.host.reconcilePiStoppedReceipt({ receipt: foreignReceipt, receiptRef: fake }), /session/);
    assert.equal((await fixture.host.snapshot('run')).attemptLifecycles[0]?.state, 'unknown');
  } finally { await fixture.close(); }
});

test('receipt written before Core observation is recovered with an explicit unknown interval', async () => {
  const fixture = await createFixture();
  try {
    const objectiveRef = await fixture.host.artifactsFor(context).writeText('test.crash.objective', 'receipt before Core catch');
    const acceptanceRef = await fixture.host.artifactsFor(context).writeText('test.crash.acceptance', 'preserve recovery interval');
    let recoveryInjected = false;
    const journal = fixture.host.artifactsFor(context).journalForTrustedPi();
    const append = journal.append.bind(journal);
    journal.append = async (input, options) => {
      const ref = await append(input, options);
      if (input.source === 'pi.model.delivery.failure') {
        // The native runtime has durably written the exact receipt while its
        // enclosing Core effect is still effect_started. This models a crash
        // between those writes without touching the database directly.
        const receipt = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as Record<string, unknown>;
        const inFlight = (await fixture.host.snapshot('run')).commands.find(entry => entry.command.commandId === receipt.modelCommandId);
        assert.equal(inFlight?.status, 'effect_started');
        assert.equal(inFlight?.observations.length, 0, 'the Core catch has not recorded an unknown observation at the receipt boundary');
        await fixture.host.reconcilePiModelDeliveryFailure({ receipt: receipt as any, receiptRef: ref });
        recoveryInjected = true;
      }
      return ref;
    };
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage('provider error', { stopReason: 'error', errorMessage: 'private-provider-body' })]);
    const launch = await fixture.fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' });
    await fixture.fleet.waitForTerminal(launch.workerId);
    assert.equal(recoveryInjected, true, 'the fault was injected after the native delivery receipt append');
    const snapshot = await fixture.host.snapshot('run');
    const model = snapshot.commands.find(entry => entry.command.kind === 'pi.model');
    assert.equal(model?.status, 'failed');
    assert.ok(model?.observations.some(observation => observation.source === 'pi.model.delivery.recovery' && observation.state === 'unknown'), 'reconciliation records the previously unobserved interval before failed delivery');
    assert.equal(snapshot.reservations[0]?.state, 'reserved');
    assert.equal(snapshot.reservations[0]?.settledActual, undefined);
    assert.equal(snapshot.attemptLifecycles[0]?.state, 'finished');
    assert.equal(fixture.faux.state.callCount, 1);
  } finally { await fixture.close(); }
});

test('verified native stop frees execution capacity while an unresolved model effect and cost stay held', async () => {
  const fixture = await createFixture();
  try {
    const journal = fixture.host.artifactsFor(context).journalForTrustedPi();
    const append = journal.append.bind(journal);
    journal.append = async (input, options) => {
      if (input.source === 'pi.model.delivery.failure') throw new Error('fixture delivery evidence unavailable');
      return append(input, options);
    };
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage('error', { stopReason: 'error', errorMessage: 'fixture error' })]);
    const objectiveRef = await fixture.host.artifactsFor(context).writeText('test.slot.objective', 'uncertain billing');
    const acceptanceRef = await fixture.host.artifactsFor(context).writeText('test.slot.acceptance', 'independent execution capacity');
    const first = await fixture.fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' });
    await fixture.fleet.waitForTerminal(first.workerId);
    const before = await fixture.host.snapshot('run');
    const model = before.commands.find(entry => entry.command.kind === 'pi.model')!;
    assert.equal(model.status, 'unknown');
    assert.equal(before.reservations[0]?.state, 'reserved');
    assert.equal((await fixture.fleet.inspect(context, first.workerId)).state, 'unknown');
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage(workerEnvelope)]);
    const second = await fixture.fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' });
    await fixture.fleet.waitForTerminal(second.workerId);
    assert.equal((await fixture.fleet.inspect(context, second.workerId)).state, 'terminal', 'dead local worker must not retain execution slot');
    const after = await fixture.host.snapshot('run');
    assert.deepEqual(after.commands.find(entry => entry.command.commandId === model.command.commandId), model, 'stop does not relabel or replay the uncertain effect');
    assert.deepEqual(after.reservations.find(entry => entry.commandId === model.command.commandId), before.reservations[0], 'unknown billing remains held');
    assert.equal(fixture.faux.state.callCount, 2);
    assert.equal(after.attemptLifecycles.find(row => row.attemptId === first.attemptId)?.executionReleased, true);
    const capacity = fixture.host.readExecutionCapacity('human');
    assert.equal(capacity.maximum, 1);
    assert.equal(capacity.occupied, 0);
    assert.equal(capacity.stoppedUnresolved, 1);
    assert.equal(capacity.leases[0]?.maximum, 1);
    assert.equal(await fixture.host.reconcilePiStoppedReceipts('run', first.attemptId), 1);
    assert.deepEqual((await fixture.host.snapshot('run')).reservations, after.reservations);
  } finally { await fixture.close(); }
});
