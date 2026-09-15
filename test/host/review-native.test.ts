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
import { IndependentReviewService, type DurableReviewRecord, type ReviewSource } from '../../src/host/review.js';
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

test('native faux independent review uses only helm_read in a fresh readonly Pi worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-native-review-'));
  let plane: Awaited<ReturnType<typeof openHost>> | undefined;
  let workspace: WorkspaceManager | undefined;
  let worker: PiNativeWorker | undefined;
  try {
    const repo = join(root, 'repo'); await mkdir(join(repo, 'src', 'core'), { recursive: true });
    await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'review-target.ts'), 'export const defect = true;\n'); await writeFile(join(repo, 'src', 'core', 'authority.ts'), 'export const authority = true;\n');
    await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'review target']);
    const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    workspace = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
    const spawnPayload = z.object({ workerId: z.string(), attemptId: z.string(), modelId: z.literal('reviewer'), modelProvider: z.literal('faux'), modelApi: z.string(), role: z.literal('reviewer'), mode: z.literal('review-readonly'), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict();
    const modelPayload = z.object({ effectId: z.string(), kind: z.literal('model.request'), upperBound: z.number().positive() }).strict();
    plane = await openHost({ stateDirectory: join(root, 'host'), now: () => stamp, kinds: {
      'worker.spawn': { payloadSchema: spawnPayload, modelSelection: (value) => ({ modelId: spawnPayload.parse(value).modelId, role: 'reviewer', requiredCapabilities: ['review'], dataClassification: 'public' as const }) },
      'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() },
      'pi.model': { payloadSchema: modelPayload, resourceRequest: value => ({ poolId: 'offline-usd', unit: 'usd', upperBound: modelPayload.parse(value).upperBound, consumer: 'worker' }) },
    } });
    plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn', 'worker.stop', 'pi.model'], expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 3, poolLimits: [{ poolId: 'offline-usd', unit: 'usd', limit: 10 }], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn', 'worker.stop', 'pi.model'], issuedAt: stamp, expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 3, poolLimits: [{ poolId: 'offline-usd', unit: 'usd', limit: 10 }], protectedReserves: [] });
    plane.recordModelFact({ modelId: 'reviewer', provider: 'faux', poolId: 'offline-usd', enabled: true, capabilities: ['review'], roles: ['reviewer'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp });
    plane.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'controller', epoch: 1, issuedAt: stamp, expiresAt: later }, 0);
    const context: HelmToolExecutionContext = { runId: 'run', sessionId: 'controller', mode: 'primary' };
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const ai = await import('@earendil-works/pi-ai');
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
    const faux = ai.fauxProvider({ provider: 'faux', models: [{ id: 'reviewer' }], tokensPerSecond: 1_000_000, tokenSize: { min: 1, max: 1 } }); runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('faux', 'offline');
    const model = faux.getModel();
    const access = new BoundedPiAccess({ poolId: 'offline-usd', provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, authEnvironment: 'FIXTURE_NO_SECRET', contextWindow: model.contextWindow, maxOutputTokens: Math.min(1024, model.maxTokens), maxBilledOutputTokens: model.maxTokens, maxPacketBytes: 1_000_000, maxRequests: 2, inputUsdPerMillion: 1, outputUsdPerMillion: 1, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, maxToolCalls: 0, timeoutMs: 10_000 });
    const finding = JSON.stringify({ status: 'succeeded', summary: 'Found a defect through the readonly review tool.', changed_files: [], commits: [], decisions: [], discoveries: ['finding: review-target.ts exports defect=true'], tests_claimed: [], acceptance_claims: [], risks: ['review finding requires builder follow-up'], unresolved: [], artifacts: [], recommended_next_action: 'return finding to controller' });
    faux.setResponses([ai.fauxAssistantMessage(ai.fauxToolCall('helm_read', { path: 'review-target.ts' })), ai.fauxAssistantMessage(finding)]);
    let prompt = ''; let modelEffects = 0;
    const fleet = new PiWorkerFleet({ host: plane, workspaceManager: workspace, executor: { executorId: 'fleet' }, claimExpiresAt: () => later,
      readFact: async () => ({ value: true, state: 'known', source: 'fixture', observedAt: stamp }),
      spawnCommand(input: WorkerSpawnInput, workerId, attemptId): Command {
        // This is trusted host configuration, deliberately absent from the
        // public worker.spawn/review.request JSON schemas.
        assert.equal(input.role, 'reviewer');
        const body = { workerId, attemptId, modelId: input.modelId, modelProvider: 'faux' as const, modelApi: model.api, role: 'reviewer' as const, mode: 'review-readonly' as const, inputDigest: hash({ ...input, contextRefs: [...input.contextRefs] }), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const };
        return { schemaVersion: 1, commandId: `spawn-${workerId}`, kind: 'worker.spawn', idempotencyKey: `spawn-${workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] };
      },
      inputDigest: command => (command.payload as { inputDigest: string }).inputDigest,
      stopCommand(record): Command { const body = { workerId: record.workerId }; return { schemaVersion: 1, commandId: `stop-${record.workerId}`, kind: 'worker.stop', idempotencyKey: `stop-${record.workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      attempt(command, workerId): Attempt { return { attemptId: `attempt-${workerId}`, mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'reviewer', model: 'reviewer', family: 'faux-review', provider: 'faux', capability: 'review', poolId: 'offline-usd', workspace: join(root, workerId), baseSha, contextManifestHash: 'sha256:review-manifest', leaseId: 'auto', sessionIds: [], commandIds: [command.commandId], startedAt: stamp, evidenceRefs: [], usageRefs: [], findingRefs: [] }; },
      workspace: (_command, workerId, attempt) => ({ repository: repo, destination: join(root, workerId), branch: workerId, baseSha, owner: { attemptId: attempt.attemptId, generation: 1, expiresAt: later }, policy: { writableRoots: [], readableRoots: ['.'] } }),
      start: async (command, reservation) => {
        assert.equal((command.payload as { mode: string }).mode, 'review-readonly');
        worker = await PiNativeWorker.start({ commandId: command.commandId, attemptId: `attempt-${(command.payload as { workerId: string }).workerId}`, workspace: reservation, owner: reservation.owner, workspaceManager: workspace!, authority: plane!.piAuthority({ attemptId: `attempt-${(command.payload as { workerId: string }).workerId}`, actorId: 'trusted-pi', executorId: 'pi', observedSettlement: effect => access.settlement(effect.effectId) ?? { state: 'unknown' }, commandForEffect: effect => { modelEffects += 1; const upperBound = access.reservation(effect.effectId).upperBound; const payload = { effectId: effect.effectId, kind: effect.kind, upperBound }; return { schemaVersion: 1, commandId: effect.effectId, kind: 'pi.model', idempotencyKey: effect.effectId, payloadHash: hash(payload), payload, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'reviewer', runId: 'run', origin: 'worker', leaseId: 'auto', leaseRevision: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; } }), journal: plane!.artifactsFor(context).journalForTrustedPi(), stateRoot: join(root, 'pi-state', (command.payload as { workerId: string }).workerId), modelRuntime: runtime, model, access, mode: 'review-readonly' });
        return worker;
      },
      prompt: () => { prompt = 'Review review-target.ts and return only a WorkerResult JSON finding.'; return prompt; }, correction: () => 'Return only a valid WorkerResult JSON object.',
    });
    const artifacts = plane.artifactsFor(context); const objectiveRef = await artifacts.writeText('review.objective', 'Review the pinned change.'); const acceptanceRef = await artifacts.writeText('review.acceptance', 'Report a structured finding.'); const codeRef = await artifacts.writeText('review.code-ref', 'review-target.ts');
    const source: ReviewSource = { workerId: 'builder-1', attemptId: 'attempt-builder', sessionId: 'builder-session', modelId: 'builder', family: 'fable', provider: 'faux', api: 'fixture', repository: repo, workspace: join(root, 'builder-worktree'), runId: 'run', head: baseSha, clean: true, contextRefs: ['builder-transcript-forbidden', 'primary-conclusion-forbidden'] };
    const reviews = new Map<string, DurableReviewRecord>();
    const service = new IndependentReviewService({ source: async id => id === source.workerId ? source : undefined, readArtifact: ref => artifacts.readText(ref), inspectSource: async value => ({ head: value.head, clean: true }), authorize: async (value, modelId) => { assert.equal(value.family, 'fable'); assert.equal(modelId, 'reviewer'); }, spawn: input => fleet.spawn(context, input), durability: { reopen: async key => reviews.get(key), prepare: async record => { if (reviews.has(record.idempotencyKey)) throw new Error('duplicate review'); reviews.set(record.idempotencyKey, record); }, append: async record => { reviews.set(record.idempotencyKey, record); } } });
    const reviewRegistry = createHostReviewToolRegistry({ context, host: plane, authorize: async () => undefined, brief: { read: async () => ({ text: 'brief', source: 'fixture', observedAt: stamp }) }, map: { snapshot: async () => ({ source: { repository: 'repo', parentIssue: 1 }, observedAt: stamp, completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }) }, economy: { snapshot: () => ({ pools: [], models: [], quota: [] }) } }, service);
    assert.equal((await reviewRegistry.invoke('integration.approve', {}, context)).state, 'unsupported');
    const launch = await service.request({ sourceWorkerId: source.workerId, expectedHead: baseSha, objectiveRef, acceptanceRef, contextRefs: [codeRef], reviewerModelId: 'reviewer' });
    assert.notEqual(launch.reviewer.attemptId, source.attemptId); assert.notEqual(launch.reviewer.sessionId, source.sessionId);
    await fleet.waitForTerminal(launch.reviewer.workerId!);
    const inspected = await fleet.inspect(context, launch.reviewer.workerId!); assert.equal(inspected.state, 'terminal', JSON.stringify((await plane.snapshot('run')).commands.map(item => ({ kind: item.command.kind, status: item.status, observations: item.observations })))); const beforeAfter = await Promise.all([exec('git', ['-C', inspected.workspace, 'rev-parse', 'HEAD']), exec('git', ['-C', inspected.workspace, 'status', '--porcelain', '--untracked-files=all'])]);
    assert.equal(beforeAfter[0].stdout.trim(), baseSha); assert.equal(beforeAfter[1].stdout, '');
    assert.equal(await workspace.read(workspace.reservation(inspected.workspace), 'src/core/authority.ts'), 'export const authority = true;\n');
    assert.match(prompt, /review-target\.ts/); assert.ok(!prompt.includes('builder-transcript-forbidden') && !prompt.includes('primary-conclusion-forbidden'));
    assert.equal(modelEffects, 2, 'the faux native session made bounded tool/result model turns through Core'); assert.throws(() => access.prepare('third-request', model, { messages: [] }, undefined), /count cap/); assert.ok((await plane.snapshot('run')).reservations.every(entry => entry.state === 'settled'));
  } finally { worker?.dispose(); plane?.close(); workspace?.close(); await rm(root, { recursive: true, force: true }); }
});
