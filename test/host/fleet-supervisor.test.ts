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
import type { HelmToolExecutionContext } from '../../src/runtime/orchestrator/index.js';
import type { PiNativeWorker } from '../../src/runtime/pi/index.js';
import { WorkspaceManager } from '../../src/workspace/index.js';

const exec = promisify(execFile);
const stamp = '2026-09-15T00:00:00.000Z';
const later = '2099-01-01T00:00:00.000Z';
const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

test('native fleet terminal events signal once, preserve a delivery fault for reopen replay, and never run a new worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm3-fleet-supervisor-'));
  const repo = join(root, 'repo'); const state = join(root, 'state'); const context: HelmToolExecutionContext = { runId: 'run', sessionId: 'session', mode: 'primary' };
  let plane!: Awaited<ReturnType<typeof openHost>>; let workspace!: WorkspaceManager;
  let starts = 0; let runs = 0; let outcomes: Array<'success' | 'failed' | 'partial' | 'invalid' | 'multiple' | 'corrupt' | 'unknown'> = [];
  try {
    await mkdir(repo); await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']); await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const kinds = { 'worker.spawn': { payloadSchema: z.object({ workerId: z.string(), attemptId: z.string(), modelId: z.literal('offline'), modelProvider: z.literal('faux'), modelApi: z.literal('fixture'), role: z.literal('builder'), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict(), modelSelection: () => ({ modelId: 'offline', role: 'builder', requiredCapabilities: ['build'], dataClassification: 'public' as const }) } };
    const open = async () => {
      plane = await openHost({ stateDirectory: state, now: () => stamp, kinds });
      workspace = new WorkspaceManager({ stateRoot: join(root, 'workspace') });
    };
    await open();
    plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn'], expiresAt: later, maxConcurrency: 8, maxAttemptsPerNode: 8, poolLimits: [], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn'], issuedAt: stamp, expiresAt: later, maxConcurrency: 8, maxAttemptsPerNode: 8, poolLimits: [], protectedReserves: [] });
    plane.recordModelFact({ modelId: 'offline', provider: 'faux', poolId: 'none', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp });
    plane.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'session', epoch: 1, issuedAt: stamp, expiresAt: later }, 0);
    const binding = () => ({ host: plane!, workspaceManager: workspace!, executor: { executorId: 'fleet' }, claimExpiresAt: () => later, readFact: async () => ({ value: true, state: 'known' as const, source: 'fixture', observedAt: stamp }),
      spawnCommand(input: WorkerSpawnInput, workerId: string, attemptId: string): Command { const payload = { workerId, attemptId, modelId: input.modelId, modelProvider: 'faux' as const, modelApi: 'fixture' as const, role: input.role, inputDigest: digest({ ...input, contextRefs: [...input.contextRefs] }), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const }; return { schemaVersion: 1, commandId: `spawn-${workerId}`, kind: 'worker.spawn', idempotencyKey: `spawn-${workerId}`, payloadHash: digest(payload), payload, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      inputDigest: (command: Command) => (command.payload as { inputDigest: string }).inputDigest,
      stopCommand: () => { throw new Error('stop is not used by this fixture'); },
      attempt(command: Command, workerId: string): Attempt { return { attemptId: `attempt-${workerId}`, mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'faux', capability: 'build', poolId: 'none', workspace: join(root, workerId), baseSha, contextManifestHash: 'sha256:context', leaseId: 'auto', sessionIds: [], commandIds: [command.commandId], startedAt: stamp, evidenceRefs: [], usageRefs: [], findingRefs: [] }; },
      workspace: (_command: Command, workerId: string, attempt: Attempt) => ({ repository: repo, destination: join(root, workerId), branch: workerId, baseSha, owner: { attemptId: attempt.attemptId, generation: 1, expiresAt: later }, policy: { writableRoots: ['.'] } }),
      start: async (command: Command) => { starts++; const outcome = outcomes.shift(); if (!outcome) throw new Error('fixture outcome is absent'); const attemptId = (command.payload as { attemptId: string }).attemptId; const status = outcome === 'failed' ? 'failed' as const : outcome === 'partial' ? 'partial' as const : 'succeeded' as const; const result = { status, summary: 'fixture', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'fixture complete' }; const journal = plane!.artifactsFor(context).journalForTrustedPi(); const envelope = outcome === 'unknown' ? undefined : await journal.append({ source: 'pi.envelope', sourceIdentity: `pi-envelope:${attemptId}:fixture:terminal`, mediaType: 'application/json', bytes: Buffer.from(outcome === 'invalid' ? 'not a WorkerResult' : JSON.stringify(result)) }); const extra = outcome === 'multiple' ? await journal.append({ source: 'pi.envelope', sourceIdentity: `pi-envelope:${attemptId}:fixture:second`, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(result)) }) : undefined; if (outcome === 'corrupt') await writeFile(join(state, 'journal', 'raw', 'sha256', envelope!.hash.slice('sha256:'.length)), 'tampered'); const worker = { sessionId: `pi-${starts}`, isActive: true, modelIdentity: { modelId: 'offline', provider: 'faux', api: 'fixture' }, contextOccupancy: {}, async run() { runs++; (this as { isActive: boolean }).isActive = false; if (outcome === 'unknown') throw new Error('native runner failed without a terminal envelope'); return { result, artifacts: [envelope!, ...(extra ? [extra] : [])] }; }, async persistedSession() { return { sessionId: `pi-${starts}`, sessionFile: 'fixture', historyHash: `sha256:${'a'.repeat(64)}`, branchDigest: `sha256:${'b'.repeat(64)}` }; }, async stopLocal() { return 'stopped' as const; }, dispose() {} }; return worker as unknown as PiNativeWorker; },
      prompt: () => 'fixture', correction: () => 'fixture',
    });
    const artifacts = plane.artifactsFor(context); const objectiveRef = await artifacts.writeText('objective', 'objective'); const acceptanceRef = await artifacts.writeText('acceptance', 'acceptance');

    outcomes = ['success']; const fleet = new PiWorkerFleet(binding()); const success = await fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }); await fleet.waitForTerminal(success.workerId);
    let fleetEvents = plane.createSupervisor().log().readEvents('run').filter(event => event.source === 'host.worker_fleet');
    let signals = plane.createSupervisor().log().readEvents('supervisor:run').filter(event => event.kind === 'supervisor.signal');
    const completedEvent = fleetEvents.find(event => event.kind === 'worker.completed')!;
    assert.equal(fleetEvents.filter(event => event.kind === 'worker.completed').length, 1); assert.equal(signals.length, 1); assert.equal((signals[0]!.payload as { sourceEventId: string }).sourceEventId, completedEvent.eventId); assert.equal(plane.createSupervisor().log().readEvents('supervisor:run').filter(event => event.kind === 'supervisor.wake').length, 0);

    outcomes = ['failed']; const failed = await fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }); await fleet.waitForTerminal(failed.workerId);
    const failedSignal = plane.createSupervisor().log().readEvents('supervisor:run').find(event => event.kind === 'supervisor.signal' && (event.payload as { group: string }).group === failed.workerId);
    assert.equal((failedSignal?.payload as { kind: string; needsJudgement: boolean }).kind, 'worker.completed'); assert.equal((failedSignal?.payload as { needsJudgement: boolean }).needsJudgement, true, 'a valid terminal WorkerResult failure remains distinct from infrastructure unknown');

    outcomes = ['partial']; const partial = await fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }); await fleet.waitForTerminal(partial.workerId);
    const partialSignal = plane.createSupervisor().log().readEvents('supervisor:run').find(event => event.kind === 'supervisor.signal' && (event.payload as { group: string }).group === partial.workerId);
    assert.equal((partialSignal?.payload as { needsJudgement: boolean }).needsJudgement, true, 'a valid partial WorkerResult also requires judgement');

    for (const outcome of ['invalid', 'multiple'] as const) { outcomes = [outcome]; const blocked = await fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }); await fleet.waitForTerminal(blocked.workerId); }
    plane.appendFleetEvent({ ...completedEvent, eventId: 'missing-result-event', sourceEventId: 'missing-result-source', payload: { evidenceRefs: [] } });
    assert.equal(plane.createSupervisor().log().readEvents('supervisor:run').filter(event => event.kind === 'supervisor.signal').length, 3, 'invalid, ambiguous, and missing-status completions emit no guessed signal');

    const normal = plane.createSupervisor.bind(plane); (plane as unknown as { createSupervisor: typeof plane.createSupervisor }).createSupervisor = () => ({ ...normal(), process: async () => { throw new Error('delivery fault after durable fleet append'); } });
    outcomes = ['unknown']; const interrupted = new PiWorkerFleet(binding()); const unknown = await interrupted.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }); await interrupted.waitForTerminal(unknown.workerId);
    assert.equal((await interrupted.inspect(context, unknown.workerId)).state, 'unknown', 'delivery failure cannot rewrite the native terminal-unknown evidence');
    plane.close(); workspace.close(); await open();
    const restarted = new PiWorkerFleet(binding()); await plane.recover('run'); await restarted.replaySupervisorEvents('run'); await restarted.replaySupervisorEvents('run');
    fleetEvents = plane.createSupervisor().log().readEvents('run').filter(event => event.source === 'host.worker_fleet'); signals = plane.createSupervisor().log().readEvents('supervisor:run').filter(event => event.kind === 'supervisor.signal');
    const wakes = plane.createSupervisor().log().readEvents('supervisor:run').filter(event => event.kind === 'supervisor.wake');
    const unknownEvent = fleetEvents.find(event => event.kind === 'worker.failed')!; const unknownSignal = signals.find(event => (event.payload as { sourceEventId: string }).sourceEventId === unknownEvent.eventId)!;
    assert.equal(signals.length, 4); assert.equal(wakes.length, 3); assert.equal((unknownSignal.payload as { evidenceRefs: string[] }).evidenceRefs.length, 2, 'the signal retains both the prior launch chain and immutable terminal phase evidence'); assert.equal(starts, 6); assert.equal(runs, 6, 'replay does not start or run Pi');

    outcomes = ['corrupt']; const corrupt = await restarted.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }); await restarted.waitForTerminal(corrupt.workerId);
    assert.equal(plane.createSupervisor().log().readEvents('supervisor:run').filter(event => event.kind === 'supervisor.signal').length, 4, 'a corrupt raw envelope cannot masquerade as a valid completion');
  } finally { plane?.close(); workspace?.close(); await rm(root, { recursive: true, force: true }); }
});
