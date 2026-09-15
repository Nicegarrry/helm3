import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod/v3';
import type { Command } from '../contracts/index.js';
import { openHost, type HostControlPlane } from '../host/index.js';
import { PiWorkerFleet, type WorkerSpawnInput } from '../host/worker-fleet.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import { PiNativeWorker } from '../runtime/pi/index.js';
import { EventSupervisor } from '../supervisor/index.js';
import { WorkspaceManager } from '../workspace/index.js';

const exec = promisify(execFile);
const stamp = '2026-09-16T20:45:00.000Z';
const later = '2099-01-01T00:00:00.000Z';
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const payloadSchema = z.object({ workerId: z.string(), attemptId: z.string(), modelId: z.literal('offline'), modelProvider: z.literal('parallel-faux'), modelApi: z.string(), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict();
const effectSchema = z.object({ effectId: z.string(), kind: z.enum(['model.request', 'workspace.write']) }).strict();

export type ParallelRecoveryFixtureResult = Readonly<{
  fixture: true;
  runId: string;
  entered: readonly Readonly<{ workerId: string; sessionId: string; commandId: string; at: string }>[];
  releasedAt: string;
  workers: readonly Readonly<{ workerId: string; attemptId: string; sessionId: string; workspace: string; state: string; evidenceRefs: readonly string[] }> [];
  failedAttemptId: string;
  retainedReservations: number;
  supervisorSignalCount: number;
  failureSignalCount: number;
  pendingJudgements: number;
  oldEpochRefused: true;
  newEpochAdmitted: true;
  close(): Promise<void>;
}>;

/**
 * A deliberately local composition tracer. It uses the native Pi worker and
 * Core admission path, but only Pi's faux provider and a disposable Git repo.
 */
export async function runParallelRecoveryFixture(stateDirectory = join(tmpdir(), `helm3-parallel-recovery-${process.pid}-${Date.now()}`)): Promise<ParallelRecoveryFixtureResult> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  if ((await (await import('node:fs/promises')).readdir(stateDirectory)).length) throw new Error('parallel recovery state directory must be empty');
  const repository = join(stateDirectory, 'repository');
  await mkdir(repository); await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'fixture@example.invalid']); await exec('git', ['-C', repository, 'config', 'user.name', 'Fixture']); await writeFile(join(repository, 'README.md'), 'parallel fixture\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
  const baseSha = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const runtime = await ModelRuntime.create({ authPath: join(stateDirectory, 'no-account-auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  const faux = ai.fauxProvider({ provider: 'parallel-faux', models: [{ id: 'offline', contextWindow: 4096, maxTokens: 1024 }] }); runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('parallel-faux', 'offline');
  const model = faux.getModel(); const runId = 'parallel-recovery'; const context: HelmToolExecutionContext = { runId, sessionId: 'fixture-driver-1', mode: 'primary' };
  const kinds = {
    'worker.spawn': { payloadSchema, modelSelection: (value: unknown) => { const p = payloadSchema.parse(value); return { modelId: p.modelId, provider: p.modelProvider, factVersion: 1, role: 'builder', requiredCapabilities: ['build'], dataClassification: 'public' as const }; } },
    'pi.model': { payloadSchema: effectSchema, resourceRequest: () => ({ poolId: 'fixture-requests', unit: 'requests', upperBound: 1, consumer: 'worker' as const }) },
    'pi.write': { payloadSchema: effectSchema },
    'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() },
  };
  let plane: HostControlPlane = await openHost({ stateDirectory: join(stateDirectory, 'host'), now: () => stamp, kinds });
  plane.recordHumanAuthority({ authorityId: 'fixture-human', repositoryId: 'fixture/repository', mapNodeIds: ['a', 'b', 'c'], allowedActions: ['worker.spawn', 'worker.stop', 'pi.model', 'pi.write'], expiresAt: later, maxConcurrency: 3, maxAttemptsPerNode: 2, poolLimits: [{ poolId: 'fixture-requests', unit: 'requests', limit: 3 }], protectedReserves: [] });
  plane.recordAutonomyLease({ leaseId: 'fixture-auto', revision: 1, issuedBy: 'fixture', parentAuthorityId: 'fixture-human', scope: { repositoryId: 'fixture/repository', mapNodeIds: ['a', 'b', 'c'] }, allowedActions: ['worker.spawn', 'worker.stop', 'pi.model', 'pi.write'], issuedAt: stamp, expiresAt: later, maxConcurrency: 3, maxAttemptsPerNode: 2, poolLimits: [{ poolId: 'fixture-requests', unit: 'requests', limit: 3 }], protectedReserves: [] });
  plane.recordModelFact({ modelId: 'offline', provider: 'parallel-faux', poolId: 'fixture-requests', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp });
  plane.acquireOwnership({ runId, leaseId: 'fixture-owner-1', owner: 'fable', sessionId: context.sessionId, epoch: 1, issuedAt: stamp, expiresAt: later }, 0);
  let workspace = new WorkspaceManager({ stateRoot: join(stateDirectory, 'workspaces') });
  await mkdir(join(stateDirectory, 'worktrees'), { recursive: true });
  const worktreesRoot = await realpath(join(stateDirectory, 'worktrees'));
  const enteredCommands: Array<{ commandId: string; at: string }> = []; let release!: () => void; let rejectBarrier!: (error: Error) => void; let releasedAt = ''; const barrier = new Promise<void>((resolve, reject) => { release = resolve; rejectBarrier = reject; }); const barrierTimeout = setTimeout(() => rejectBarrier(new Error('parallel fixture barrier timed out')), 5_000);
  const response = (failure: boolean) => async (modelContext: { messages: readonly unknown[] }) => { const commandId = JSON.stringify(modelContext.messages.at(-1)).match(/spawn-worker-[0-9a-f-]+/)?.[0]; if (!commandId) throw new Error('fixture prompt did not bind a worker command'); enteredCommands.push({ commandId, at: new Date().toISOString() }); if (enteredCommands.length === 3) { releasedAt = new Date().toISOString(); clearTimeout(barrierTimeout); release(); } await barrier; if (failure) throw new Error('fixture transport failure'); return ai.fauxAssistantMessage(JSON.stringify({ status: 'succeeded', summary: 'parallel fixture completed', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'observe' })); };
  faux.setResponses([response(false), response(false), response(true)]);
  const binding = () => new PiWorkerFleet({ host: plane, workspaceManager: workspace, executor: { executorId: 'fixture-host' }, claimExpiresAt: () => later, readFact: async () => ({ state: 'known' as const, value: true, source: 'fixture', observedAt: stamp }),
    spawnCommand: (input: WorkerSpawnInput, workerId: string, attemptId: string, actual) => { const node = input.label; if (node !== 'a' && node !== 'b' && node !== 'c') throw new Error('fixture worker has no allowed Map node'); const payload = { workerId, attemptId, modelId: 'offline' as const, modelProvider: model.provider, modelApi: model.api, inputDigest: hash(input), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const }; return { schemaVersion: 1, commandId: `spawn-${workerId}`, kind: 'worker.spawn', idempotencyKey: `spawn-${workerId}`, payloadHash: hash(payload), payload, scope: { repositoryId: 'fixture/repository', mapNodeId: node }, actorId: 'fixture', runId: actual.runId, origin: 'orchestrator', leaseId: 'fixture-auto', leaseRevision: 1, orchestratorLeaseId: 'fixture-owner-1', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] } as Command; },
    inputDigest: command => (command.payload as { inputDigest: string }).inputDigest,
    stopCommand: (record, actual) => { const payload = { workerId: record.workerId }; return { schemaVersion: 1, commandId: `stop-${record.workerId}`, kind: 'worker.stop', idempotencyKey: `stop-${record.workerId}`, payloadHash: hash(payload), payload, scope: { repositoryId: 'fixture/repository', mapNodeId: 'a' }, actorId: 'fixture', runId: actual.runId, origin: 'orchestrator', leaseId: 'fixture-auto', leaseRevision: 1, orchestratorLeaseId: 'fixture-owner-1', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] } as Command; },
    attempt: (command, workerId) => ({ attemptId: (command.payload as { attemptId: string }).attemptId, mapNodeId: command.scope.mapNodeId!, mapNodeRevision: baseSha, objectiveVersion: 'fixture', acceptanceVersion: 'fixture', role: 'builder', model: 'offline', family: 'faux', provider: model.provider, capability: 'fixture', poolId: 'fixture-requests', workspace: join(worktreesRoot, workerId), baseSha, contextManifestHash: 'sha256:fixture', leaseId: 'fixture-auto', sessionIds: [], commandIds: [command.commandId], startedAt: stamp, evidenceRefs: [], usageRefs: [], findingRefs: [] }),
    workspace: (command, workerId, attempt) => ({ repository, destination: join(worktreesRoot, workerId), branch: `fixture-${workerId}`, baseSha, owner: { attemptId: attempt.attemptId, generation: 1, expiresAt: later }, policy: { writableRoots: ['.'] } }),
    start: async (command, reservation) => { const attemptId = (command.payload as { attemptId: string }).attemptId; const authority = plane.piAuthority({ attemptId, actorId: 'fixture-pi', executorId: `pi-${attemptId}`, commandForEffect: effect => { const payload = { effectId: effect.effectId, kind: effect.kind }; return { schemaVersion: 1, commandId: effect.effectId, kind: effect.kind === 'model.request' ? 'pi.model' : 'pi.write', idempotencyKey: effect.effectId, payloadHash: hash(payload), payload, scope: command.scope, actorId: 'fixture-pi', runId, origin: 'worker', leaseId: 'fixture-auto', leaseRevision: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; }, observedSettlement: effect => effect.kind === 'model.request' ? { state: 'known' as const, amount: 1 } : undefined }); return PiNativeWorker.start({ commandId: command.commandId, attemptId, workspace: reservation, owner: reservation.owner, workspaceManager: workspace, authority, journal: plane.artifactsFor(context).journalForTrustedPi(), stateRoot: join(stateDirectory, 'pi', attemptId), modelRuntime: runtime, model }); },
    prompt: command => `Return the required WorkerResult JSON without tools. Command ${command.commandId}.`, correction: () => 'Return JSON only.',
  });
  try {
  let fleet = binding(); const artifacts = plane.artifactsFor(context); const objectiveRef = await artifacts.writeText('fixture.objective', 'Parallel recovery fixture'); const acceptanceRef = await artifacts.writeText('fixture.acceptance', 'Return a result envelope.');
  const starts = await Promise.all(['a', 'b', 'c'].map(node => fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder', label: node })));
  await Promise.all(starts.map(start => fleet.waitForTerminal(start.workerId))); if (!releasedAt) throw new Error('parallel fixture did not release its barrier');
  const before = await plane.snapshot(runId); const workers: Array<{ workerId: string; attemptId: string; sessionId: string; workspace: string; state: string; evidenceRefs: readonly string[] }> = await Promise.all(starts.map(async start => { const record = await fleet.inspect(context, start.workerId); return { workerId: start.workerId, attemptId: start.attemptId, sessionId: start.sessionId, workspace: record.workspace, state: record.state, evidenceRefs: record.evidenceRefs }; }));
  const failed = workers.find(worker => worker.state === 'unknown'); if (!failed) throw new Error('controlled fixture failure was not quarantined');
  const entered = enteredCommands.map(entry => { const worker = starts.find(start => `spawn-${start.workerId}` === entry.commandId); if (!worker) throw new Error('barrier entry did not bind a spawned worker'); return Object.freeze({ workerId: worker.workerId, sessionId: worker.sessionId, commandId: entry.commandId, at: entry.at }); });
  if (new Set(entered.map(entry => entry.sessionId)).size !== 3 || entered.some(entry => Date.parse(entry.at) > Date.parse(releasedAt))) throw new Error('workers did not overlap before barrier release');
  plane.close(); workspace.close(); plane = await openHost({ stateDirectory: join(stateDirectory, 'host'), now: () => stamp, kinds });
  plane.acquireOwnership({ runId, leaseId: 'fixture-owner-2', owner: 'astra', sessionId: 'fixture-driver-2', epoch: 2, issuedAt: stamp, expiresAt: later }, 1);
  workspace = new WorkspaceManager({ stateRoot: join(stateDirectory, 'workspaces') }); fleet = binding(); await fleet.replaySupervisorEvents(runId); await fleet.replaySupervisorEvents(runId); const afterReplay = await plane.snapshot(runId);
  if (JSON.stringify(afterReplay.commands) !== JSON.stringify(before.commands) || JSON.stringify(afterReplay.reservations) !== JSON.stringify(before.reservations)) throw new Error('replaying durable fleet events changed commands or reservations');
  for (const prior of workers) { const recovered = await fleet.inspect(context, prior.workerId); const attempt = afterReplay.attempts.find(item => item.attemptId === prior.attemptId); if (!attempt || recovered.workspace !== prior.workspace || recovered.state !== prior.state || JSON.stringify(recovered.evidenceRefs) !== JSON.stringify(prior.evidenceRefs) || attempt.workspace !== recovered.workspace) throw new Error('reopened fleet projection does not match durable worker evidence'); }
  const owner = { runId, leaseId: 'fixture-owner-2', owner: 'astra' as const, sessionId: 'fixture-driver-2', epoch: 2, issuedAt: stamp, expiresAt: later }; const log = plane.createSupervisor().log().readEvents(`supervisor:${runId}`); const signals = log.filter(event => event.kind === 'supervisor.signal'); const failureSignals = signals.filter(event => (event.payload as { kind?: unknown }).kind === 'worker.failed'); const pending = new EventSupervisor(plane.createSupervisor().log(), () => stamp).pending(owner);
  const probe = (commandId: string, leaseId: string, epoch: number): Command => { const payload = { workerId: `probe-${commandId}`, attemptId: `attempt-${commandId}`, modelId: 'offline' as const, modelProvider: model.provider, modelApi: model.api, inputDigest: hash(commandId), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const }; return { schemaVersion: 1, commandId, kind: 'worker.spawn', idempotencyKey: commandId, payloadHash: hash(payload), payload, scope: { repositoryId: 'fixture/repository', mapNodeId: 'a' }, actorId: 'fixture', runId, origin: 'orchestrator', leaseId: 'fixture-auto', leaseRevision: 1, orchestratorLeaseId: leaseId, orchestratorEpoch: epoch, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; };
  const positive = plane.admitOrchestrator(probe('new-epoch-preflight', 'fixture-owner-2', 2), { runId, sessionId: 'fixture-driver-2', mode: 'primary' }, 'fixture'); if (positive.command.commandId !== 'new-epoch-preflight') throw new Error('current owner preflight was not admitted');
  let oldEpochRefused = false; try { plane.admitOrchestrator(probe('old-epoch-preflight', 'fixture-owner-1', 1), { runId, sessionId: 'fixture-driver-2', mode: 'primary' }, 'fixture'); } catch (error) { if (!(error instanceof Error) || error.message !== 'orchestrator ownership epoch is stale') throw error; oldEpochRefused = true; }
  if (!oldEpochRefused) throw new Error('old ownership epoch was admitted');
  return Object.freeze({ fixture: true, runId, entered: Object.freeze(entered), releasedAt, workers: Object.freeze(workers.map(worker => Object.freeze({ ...worker }))), failedAttemptId: failed.attemptId, retainedReservations: before.reservations.filter(item => item.state !== 'settled').length, supervisorSignalCount: signals.length, failureSignalCount: failureSignals.length, pendingJudgements: pending.length, oldEpochRefused: true, newEpochAdmitted: true, async close() { plane.close(); workspace.close(); } });
  } catch (error) { clearTimeout(barrierTimeout); plane.close(); workspace.close(); throw error; }
}
