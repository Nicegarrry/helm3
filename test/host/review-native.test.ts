import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod/v3';
import type { Attempt, Command } from '../../src/contracts/index.js';
import { openHost } from '../../src/host/index.js';
import { createFleetIndependentReviewService } from '../../src/host/review.js';
import { JournalReviewDurabilityStore } from '../../src/host/review-store.js';
import { createHostReviewToolRegistry } from '../../src/host/review-tools.js';
import { PiWorkerFleet, type WorkerSpawnInput } from '../../src/host/worker-fleet.js';
import type { HelmToolExecutionContext } from '../../src/runtime/orchestrator/index.js';
import { PiNativeWorker } from '../../src/runtime/pi/index.js';
import { WorkspaceManager } from '../../src/workspace/index.js';
import { BoundedPiAccess } from '../../src/access/index.js';

const exec = promisify(execFile);
const stamp = '2026-09-16T00:00:00Z';
const later = '2099-01-01T00:00:00Z';
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

test('native fleet builder commits a new head and review.request starts an isolated readonly Pi review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-native-review-'));
  let plane: Awaited<ReturnType<typeof openHost>> | undefined;
  let workspace: WorkspaceManager | undefined;
  const workers: PiNativeWorker[] = [];
  try {
    const repo = join(root, 'repo'); await mkdir(join(repo, 'src', 'core'), { recursive: true });
    await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'src', 'core', 'authority.ts'), 'export const authority = true;\n');
    await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    let currentHead = baseSha;
    workspace = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
    const spawnPayload = z.object({ workerId: z.string(), attemptId: z.string(), modelId: z.enum(['builder', 'reviewer']), modelProvider: z.literal('faux'), modelApi: z.string(), role: z.enum(['builder', 'reviewer']), mode: z.enum(['worker', 'review-readonly']).optional(), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict();
    const modelPayload = z.object({ effectId: z.string(), kind: z.literal('model.request'), upperBound: z.number().positive() }).strict();
    const writePayload = z.object({ effectId: z.string(), kind: z.literal('workspace.write') }).strict();
    plane = await openHost({ stateDirectory: join(root, 'host'), now: () => stamp, kinds: {
      'worker.spawn': { payloadSchema: spawnPayload, modelSelection: value => { const payload = spawnPayload.parse(value); return { modelId: payload.modelId, role: payload.role, requiredCapabilities: [payload.role === 'builder' ? 'build' : 'review'], dataClassification: 'public' as const }; } },
      'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() },
      'pi.model': { payloadSchema: modelPayload, resourceRequest: value => ({ poolId: 'offline-usd', unit: 'usd', upperBound: modelPayload.parse(value).upperBound, consumer: 'worker' }) },
      'pi.write': { payloadSchema: writePayload },
    } });
    plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn', 'worker.stop', 'pi.model', 'pi.write'], expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 3, poolLimits: [{ poolId: 'offline-usd', unit: 'usd', limit: 10 }], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn', 'worker.stop', 'pi.model', 'pi.write'], issuedAt: stamp, expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 3, poolLimits: [{ poolId: 'offline-usd', unit: 'usd', limit: 10 }], protectedReserves: [] });
    plane.recordModelFact({ modelId: 'builder', provider: 'faux', poolId: 'offline-usd', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp });
    plane.recordModelFact({ modelId: 'reviewer', provider: 'faux', poolId: 'offline-usd', enabled: true, capabilities: ['review'], roles: ['reviewer'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp });
    plane.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'controller', epoch: 1, issuedAt: stamp, expiresAt: later }, 0);
    const context: HelmToolExecutionContext = { runId: 'run', sessionId: 'controller', mode: 'primary' };
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent'); const ai = await import('@earendil-works/pi-ai');
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
    const faux = ai.fauxProvider({ provider: 'faux', models: [{ id: 'builder' }, { id: 'reviewer' }], tokensPerSecond: 1_000_000, tokenSize: { min: 1, max: 1 } }); runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('faux', 'offline');
    const builder = faux.getModel('builder')!; const reviewer = faux.getModel('reviewer')!;
    const accessByWorker = new Map<string, BoundedPiAccess>();
    const spawnInputs = new Map<string, WorkerSpawnInput>();
    const prompts = new Map<string, string>();
    let reviewerRequest = '';
    const builderResult = JSON.stringify({ status: 'succeeded', summary: 'Created the review target.', changed_files: ['review-target.ts'], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'commit and request independent review' });
    const finding = JSON.stringify({ status: 'succeeded', summary: 'Found a defect through the readonly review tool.', changed_files: [], commits: [], decisions: [], discoveries: ['finding: review-target.ts exports defect=true'], tests_claimed: [], acceptance_claims: [], risks: ['review finding requires builder follow-up'], unresolved: [], artifacts: [], recommended_next_action: 'return finding to controller' });
    faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'review-target.ts', contents: 'export const defect = true;\n' })), ai.fauxAssistantMessage(builderResult), (request, _options, _state, model) => { if (model.id === 'reviewer') reviewerRequest = JSON.stringify(request); return ai.fauxAssistantMessage(ai.fauxToolCall('helm_read', { path: 'review-target.ts' })); }, ai.fauxAssistantMessage(finding)]);
    const fleet = new PiWorkerFleet({ host: plane, workspaceManager: workspace, executor: { executorId: 'fleet' }, claimExpiresAt: () => later, readFact: async () => ({ value: true, state: 'known', source: 'fixture', observedAt: stamp }),
      spawnCommand(input: WorkerSpawnInput, workerId, attemptId): Command { const role = input.role as 'builder' | 'reviewer'; spawnInputs.set(workerId, Object.freeze({ ...input, contextRefs: Object.freeze([...input.contextRefs]) })); const body = { workerId, attemptId, modelId: input.modelId as 'builder' | 'reviewer', modelProvider: 'faux' as const, modelApi: role === 'builder' ? builder.api : reviewer.api, role, ...(role === 'reviewer' ? { mode: 'review-readonly' as const } : { mode: 'worker' as const }), inputDigest: hash({ ...input, contextRefs: [...input.contextRefs] }), baseSha: currentHead, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const }; return { schemaVersion: 1, commandId: `spawn-${workerId}`, kind: 'worker.spawn', idempotencyKey: `spawn-${workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      inputDigest: command => (command.payload as { inputDigest: string }).inputDigest,
      stopCommand(record): Command { const body = { workerId: record.workerId }; return { schemaVersion: 1, commandId: `stop-${record.workerId}`, kind: 'worker.stop', idempotencyKey: `stop-${record.workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      attempt(command, workerId): Attempt { const payload = command.payload as { role: 'builder' | 'reviewer'; modelId: string; baseSha: string }; return { attemptId: `attempt-${workerId}`, mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: payload.role, model: payload.modelId, family: payload.role === 'builder' ? 'fable' : 'terra', provider: 'faux', capability: payload.role === 'builder' ? 'build' : 'review', poolId: 'offline-usd', workspace: join(root, workerId), baseSha: payload.baseSha, contextManifestHash: 'sha256:context', leaseId: 'auto', sessionIds: [], commandIds: [command.commandId], startedAt: stamp, evidenceRefs: [], usageRefs: [], findingRefs: [] }; },
      workspace: (command, workerId, attempt) => { const payload = command.payload as { baseSha: string; role: string }; return { repository: repo, destination: join(root, workerId), branch: workerId, baseSha: payload.baseSha, owner: { attemptId: attempt.attemptId, generation: 1, expiresAt: later }, policy: payload.role === 'reviewer' ? { writableRoots: [], readableRoots: ['.'] } : { writableRoots: ['.'] } }; },
      start: async (command, reservation) => { const payload = command.payload as { workerId: string; attemptId: string; role: 'builder' | 'reviewer'; modelId: 'builder' | 'reviewer' }; const model = payload.modelId === 'builder' ? builder : reviewer; const access = new BoundedPiAccess({ poolId: 'offline-usd', provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, authEnvironment: 'FIXTURE_NO_SECRET', contextWindow: model.contextWindow, maxOutputTokens: Math.min(1024, model.maxTokens), maxBilledOutputTokens: model.maxTokens, maxPacketBytes: 1_000_000, maxRequests: 2, inputUsdPerMillion: 1, outputUsdPerMillion: 1, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, maxToolCalls: payload.role === 'builder' ? 1 : 0, timeoutMs: 10_000 }); accessByWorker.set(payload.workerId, access); const worker = await PiNativeWorker.start({ commandId: command.commandId, attemptId: payload.attemptId, workspace: reservation, owner: reservation.owner, workspaceManager: workspace!, authority: plane!.piAuthority({ attemptId: payload.attemptId, actorId: 'trusted-pi', executorId: 'pi', observedSettlement: effect => effect.kind === 'model.request' ? access.settlement(effect.effectId) ?? { state: 'unknown' } : undefined, commandForEffect: effect => { const body = effect.kind === 'model.request' ? { effectId: effect.effectId, kind: effect.kind, upperBound: access.reservation(effect.effectId).upperBound } : { effectId: effect.effectId, kind: effect.kind }; return { schemaVersion: 1, commandId: effect.effectId, kind: effect.kind === 'model.request' ? 'pi.model' : 'pi.write', idempotencyKey: effect.effectId, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: payload.role, runId: 'run', origin: 'worker', leaseId: 'auto', leaseRevision: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; } }), journal: plane!.artifactsFor(context).journalForTrustedPi(), stateRoot: join(root, 'pi-state', payload.workerId), modelRuntime: runtime, model, access, mode: payload.role === 'reviewer' ? 'review-readonly' : 'worker' }); workers.push(worker); return worker; },
      prompt: async command => {
        const payload = command.payload as { workerId: string; role: string };
        const input = spawnInputs.get(payload.workerId); if (!input) throw new Error('prompt has no captured spawn manifest');
        const bytes = await Promise.all([input.objectiveRef, input.acceptanceRef, ...input.contextRefs].map(ref => plane!.artifactsFor(context).readText(ref)));
        const prompt = `${payload.role === 'builder' ? 'Build' : 'Review'} only the captured manifest:\n${bytes.join('\n')}\nReturn only a valid WorkerResult JSON object.`;
        prompts.set(payload.workerId, prompt); return prompt;
      }, correction: () => 'Return only a valid WorkerResult JSON object.' });
    const artifacts = plane.artifactsFor(context); const objectiveRef = await artifacts.writeText('review.objective', 'Review the pinned change.'); const acceptanceRef = await artifacts.writeText('review.acceptance', 'Report a structured finding.'); const codeRef = await artifacts.writeText('review.code-ref', 'review-target.ts');
    const builderLaunch = await fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [codeRef], modelId: 'builder', role: 'builder' }); await fleet.waitForTerminal(builderLaunch.workerId);
    const built = await fleet.inspect(context, builderLaunch.workerId); assert.equal(built.state, 'terminal', JSON.stringify(await plane.snapshot('run'))); assert.equal(await workspace.read(workspace.reservation(built.workspace), 'review-target.ts'), 'export const defect = true;\n');
    await exec('git', ['-C', built.workspace, 'add', 'review-target.ts']); await exec('git', ['-C', built.workspace, 'commit', '-m', 'builder target']); currentHead = (await exec('git', ['-C', built.workspace, 'rev-parse', 'HEAD'])).stdout.trim(); assert.notEqual(currentHead, baseSha, 'trusted host commit advances the builder head');
    const beforeRef = await artifacts.writeText('review.git.before', JSON.stringify({ head: currentHead, status: (await exec('git', ['-C', built.workspace, 'status', '--porcelain', '--untracked-files=all'])).stdout }));
    const callsBeforeRejectedReview = faux.state.callCount;
    await assert.rejects(fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [codeRef], modelId: 'reviewer', role: 'reviewer', reviewConstraint: { repository: join(root, 'foreign-repository'), expectedHead: currentHead, mode: 'review-readonly' } }), /worker setup was not durably observed/);
    assert.equal(faux.state.callCount, callsBeforeRejectedReview, 'a foreign review repository is refused before native model dispatch');
    const service = createFleetIndependentReviewService({ host: plane, fleet, workspaceManager: workspace, context, authorize: async (source, modelId) => { assert.equal(source.family, 'fable'); assert.equal(modelId, 'reviewer'); }, durability: new JournalReviewDurabilityStore(artifacts.journalForTrustedPi(), context.runId) });
    const reviewRegistry = createHostReviewToolRegistry({ context, host: plane, authorize: async () => undefined, brief: { read: async () => ({ text: 'brief', source: 'fixture', observedAt: stamp }) }, map: { snapshot: async () => ({ source: { repository: 'repo', parentIssue: 1 }, observedAt: stamp, completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }) }, economy: { snapshot: () => ({ pools: [], models: [], quota: [] }) } }, service);
    const started = await reviewRegistry.invoke('review.request', { sourceWorkerId: builderLaunch.workerId, expectedHead: currentHead, objectiveRef, acceptanceRef, contextRefs: [codeRef], reviewerModelId: 'reviewer' }, context); assert.equal(started.state, 'succeeded'); if (started.state !== 'succeeded') throw new Error('review request was refused');
    const launch = started.value as Awaited<ReturnType<typeof service.request>>; assert.notEqual(launch.reviewer.attemptId, builderLaunch.attemptId); assert.notEqual(launch.reviewer.sessionId, builderLaunch.sessionId);
    await fleet.waitForTerminal(launch.reviewer.workerId!); const reviewed = await fleet.inspect(context, launch.reviewer.workerId!); assert.equal(reviewed.state, 'terminal');
    const git = await Promise.all([exec('git', ['-C', reviewed.workspace, 'rev-parse', 'HEAD']), exec('git', ['-C', reviewed.workspace, 'status', '--porcelain', '--untracked-files=all'])]); assert.equal(git[0].stdout.trim(), currentHead); assert.equal(git[1].stdout, ''); assert.notEqual(reviewed.workspace, built.workspace, 'reviewer receives a distinct readonly worktree'); assert.equal(await workspace.read(workspace.reservation(reviewed.workspace), 'review-target.ts'), 'export const defect = true;\n');
    const afterRef = await artifacts.writeText('review.git.after', JSON.stringify({ head: git[0].stdout.trim(), status: git[1].stdout }));
    assert.match(prompts.get(launch.reviewer.workerId!)!, /Review the pinned change\./); assert.match(reviewerRequest, /Review the pinned change\./); assert.match(reviewerRequest, /Report a structured finding\./); assert.match(reviewerRequest, /review-target\.ts/); assert.ok(!reviewerRequest.includes(builderResult) && !reviewerRequest.includes('Created the review target.'), 'the actual reviewer request excludes builder session history');
    const access = accessByWorker.get(launch.reviewer.workerId!)!; assert.throws(() => access.prepare('third-request', reviewer, { messages: [] }, undefined), /count cap/); assert.ok((await plane.snapshot('run')).reservations.every(entry => entry.state === 'settled'));
    const metadata = await artifacts.journalForTrustedPi().metadata();
    const envelope = metadata.find(entry => entry.source === 'pi.envelope' && entry.sourceIdentity.includes(launch.reviewer.attemptId!)); assert.ok(envelope, 'review terminal envelope is durable');
    const rawEventRefs = metadata.filter(entry => entry.source === 'pi.event' && entry.sourceIdentity.includes(launch.reviewer.sessionId!)).map(entry => entry.raw.ref); assert.ok(rawEventRefs.length > 0, 'review raw event evidence is durable');
    const findingBytes = await artifacts.journalForTrustedPi().read(envelope.raw, envelope.sourceIdentity); assert.match(findingBytes.toString('utf8'), /review-target\.ts exports defect=true/);
    const terminal = await service.recordTerminal(launch.reviewId, launch.idempotencyKey, { resultRef: envelope.raw.ref, rawEventRefs, readonlyObservation: { beforeRef, afterRef } }); assert.equal(terminal.state, 'terminal'); assert.equal(terminal.requestedHead, currentHead); assert.deepEqual(terminal.outcome?.rawEventRefs, rawEventRefs); assert.equal(terminal.outcome?.resultRef, envelope.raw.ref); assert.notEqual(terminal.source.attemptId, terminal.reviewer.attemptId);
  } finally { workers.forEach(worker => worker.dispose()); plane?.close(); workspace?.close(); await rm(root, { recursive: true, force: true }); }
});
