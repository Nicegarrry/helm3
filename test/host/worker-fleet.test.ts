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
import { createHostWorkerToolRegistry } from '../../src/host/worker-tools.js';
import { PiWorkerFleet, type WorkerSpawnInput } from '../../src/host/worker-fleet.js';
import type { HelmToolExecutionContext } from '../../src/runtime/orchestrator/index.js';
import type { PiNativeWorker } from '../../src/runtime/pi/index.js';
import { WorkspaceManager } from '../../src/workspace/index.js';

const exec = promisify(execFile); const stamp = '2026-09-15T00:00:00Z'; const later = '2099-01-01T00:00:00Z';
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

test('worker tools create a short setup effect, remain inspectable while running, and report restart as live unknown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm3-worker-fleet-')); const repo = join(root, 'repo'); const state = join(root, 'host');
  let plane: Awaited<ReturnType<typeof openHost>> | undefined; let workspace: WorkspaceManager | undefined;
  try {
    await mkdir(repo); await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']); await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim(); workspace = new WorkspaceManager({ stateRoot: join(root, 'workspace') });
    const payload = z.object({ workerId: z.string(), attemptId: z.string(), modelId: z.literal('offline'), modelProvider: z.literal('faux'), modelApi: z.literal('fixture'), role: z.literal('builder'), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict();
    plane = await openHost({ stateDirectory: state, now: () => stamp, kinds: {
      'worker.spawn': { payloadSchema: payload, modelSelection: (value) => ({ modelId: payload.parse(value).modelId, role: payload.parse(value).role, requiredCapabilities: ['build'], dataClassification: 'public' as const }) },
      'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() },
    } });
    plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn', 'worker.stop'], expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn', 'worker.stop'], issuedAt: stamp, expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [], protectedReserves: [] });
    plane.recordModelFact({ modelId: 'offline', provider: 'faux', poolId: 'none', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp });
    plane.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'session', epoch: 1, issuedAt: stamp, expiresAt: later }, 0);
    let finish: (() => void) | undefined; const running = new Promise<void>((resolve) => { finish = resolve; });
    const fake = { sessionId: 'pi-session', isActive: true, modelIdentity: { modelId: 'offline', provider: 'faux', api: 'fixture' }, contextOccupancy: { state: 'known', tokens: 3 }, async run() { await running; (this as { isActive: boolean }).isActive = false; throw new Error('fixture abort rejects the runner'); }, async stopLocal() { (this as { isActive: boolean }).isActive = false; finish!(); return 'stopped' as const; }, dispose() {} } as unknown as PiNativeWorker;
    const context: HelmToolExecutionContext = { runId: 'run', sessionId: 'session', mode: 'primary' };
    const fleet = new PiWorkerFleet({ host: plane, workspaceManager: workspace, executor: { executorId: 'fleet' }, claimExpiresAt: () => later, readFact: async () => ({ value: true, state: 'known', source: 'fixture', observedAt: stamp }),
      spawnCommand(input: WorkerSpawnInput, workerId, attemptId): Command { const body = { workerId, attemptId, modelId: input.modelId, modelProvider: 'faux' as const, modelApi: 'fixture' as const, role: input.role, inputDigest: hash({ ...input, contextRefs: [...input.contextRefs] }), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const }; return { schemaVersion: 1, commandId: `spawn-${workerId}`, kind: 'worker.spawn', idempotencyKey: `spawn-${workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      inputDigest: (command) => (command.payload as { inputDigest: string }).inputDigest,
      stopCommand(record): Command { const body = { workerId: record.workerId }; return { schemaVersion: 1, commandId: `stop-${record.workerId}`, kind: 'worker.stop', idempotencyKey: `stop-${record.workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      attempt(command, workerId): Attempt { return { attemptId: `attempt-${workerId}`, mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'faux', capability: 'build', poolId: 'none', workspace: join(root, workerId), baseSha, contextManifestHash: 'sha256:context', leaseId: 'auto', sessionIds: [], commandIds: [command.commandId], startedAt: stamp, evidenceRefs: [], usageRefs: [], findingRefs: [] }; },
      workspace: (_command, workerId, attempt) => ({ repository: repo, destination: join(root, workerId), branch: workerId, baseSha, owner: { attemptId: attempt.attemptId, generation: 1, expiresAt: later }, policy: { writableRoots: ['.'] } }),
      start: async () => fake, prompt: () => 'fixture', correction: () => 'fixture',
    });
    const registry = createHostWorkerToolRegistry({ context, authorize: async (actual) => { plane!.artifactsFor(actual); }, host: plane, brief: { async read() { return { text: 'brief', source: 'test', observedAt: stamp }; } }, map: { async snapshot() { return { source: { repository: 'repo', parentIssue: 1 }, observedAt: stamp, completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }; } }, economy: { snapshot: () => ({ pools: [], models: [], quota: [] }) } }, fleet);
    const scoped = plane.artifactsFor(context); const objectiveRef = await scoped.writeText('fixture.objective', 'objective'); const acceptanceRef = await scoped.writeText('fixture.acceptance', 'acceptance');
    const start = await registry.invoke('worker.spawn', { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }, context);
    assert.equal(start.state, 'succeeded'); if (start.state !== 'succeeded') throw new Error('unreachable');
    const workerId = (start.value as { workerId: string }).workerId;
    const active = await registry.invoke('worker.inspect', { workerId }, context); assert.equal(active.state, 'succeeded'); assert.equal((active as { value: { live: string } }).value.live, 'known');
    const stopped = await registry.invoke('worker.stop', { workerId }, context); assert.equal(stopped.state, 'succeeded');
    await new Promise((resolve) => setImmediate(resolve));
    const stoppedAttempt = (await plane.snapshot('run')).attemptLifecycles.find((entry) => entry.attemptId === (start.value as { attemptId: string }).attemptId);
    assert.equal(stoppedAttempt?.state, 'finished', 'a confirmed native stop closes its bound attempt only after worker.stop is observed');
    plane.close(); plane = await openHost({ stateDirectory: state, now: () => stamp, kinds: { 'worker.spawn': { payloadSchema: payload }, 'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() } } });
    const recovered = await plane.recover('run'); assert.equal(recovered.commands.find((entry) => entry.command.commandId === `spawn-${workerId}`)?.status, 'succeeded');
    const restartedFleet = new PiWorkerFleet({ ...(fleet as unknown as { binding: ConstructorParameters<typeof PiWorkerFleet>[0] }).binding, host: plane });
    const afterRestart = await restartedFleet.inspect(context, workerId); assert.equal(afterRestart.state, 'terminal'); assert.equal(afterRestart.live, 'unknown');
  } finally { plane?.close(); workspace?.close(); await rm(root, { recursive: true, force: true }); }
});

test('confirmed stop evidence outranks an earlier unknown runner record after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm3-worker-stop-precedence-')); const repo = join(root, 'repo'); const state = join(root, 'host');
  let plane: Awaited<ReturnType<typeof openHost>> | undefined; let workspace: WorkspaceManager | undefined;
  try {
    await mkdir(repo); await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']); await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim(); workspace = new WorkspaceManager({ stateRoot: join(root, 'workspace') });
    const payload = z.object({ workerId: z.string(), attemptId: z.string(), modelId: z.literal('offline'), modelProvider: z.literal('faux'), modelApi: z.literal('fixture'), role: z.literal('builder'), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict();
    plane = await openHost({ stateDirectory: state, now: () => stamp, kinds: { 'worker.spawn': { payloadSchema: payload, modelSelection: (value) => ({ modelId: payload.parse(value).modelId, role: payload.parse(value).role, requiredCapabilities: ['build'], dataClassification: 'public' as const }) }, 'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() } } });
    plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn', 'worker.stop'], expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn', 'worker.stop'], issuedAt: stamp, expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [], protectedReserves: [] });
    plane.recordModelFact({ modelId: 'offline', provider: 'faux', poolId: 'none', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp }); plane.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'session', epoch: 1, issuedAt: stamp, expiresAt: later }, 0);
    let finish: (() => void) | undefined; const running = new Promise<void>((resolve) => { finish = resolve; });
    const fake = { sessionId: 'pi-session', isActive: true, modelIdentity: { modelId: 'offline', provider: 'faux', api: 'fixture' }, contextOccupancy: { state: 'known', tokens: 3 }, async run() { await running; throw new Error('runner failed but the native request remains active'); }, async stopLocal() { (this as { isActive: boolean }).isActive = false; return 'stopped' as const; }, dispose() {} } as unknown as PiNativeWorker;
    const context: HelmToolExecutionContext = { runId: 'run', sessionId: 'session', mode: 'primary' };
    const fleet = new PiWorkerFleet({ host: plane, workspaceManager: workspace, executor: { executorId: 'fleet' }, claimExpiresAt: () => later, readFact: async () => ({ value: true, state: 'known', source: 'fixture', observedAt: stamp }),
      spawnCommand(input, workerId, attemptId): Command { const body = { workerId, attemptId, modelId: input.modelId, modelProvider: 'faux' as const, modelApi: 'fixture' as const, role: input.role, inputDigest: hash({ ...input, contextRefs: [...input.contextRefs] }), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const }; return { schemaVersion: 1, commandId: `spawn-${workerId}`, kind: 'worker.spawn', idempotencyKey: `spawn-${workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      inputDigest: (command) => (command.payload as { inputDigest: string }).inputDigest,
      stopCommand(record): Command { const body = { workerId: record.workerId }; return { schemaVersion: 1, commandId: `stop-${record.workerId}`, kind: 'worker.stop', idempotencyKey: `stop-${record.workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      attempt: (_command, workerId): Attempt => ({ attemptId: `attempt-${workerId}`, mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'faux', capability: 'build', poolId: 'none', workspace: join(root, workerId), baseSha, contextManifestHash: 'sha256:context', leaseId: 'auto', sessionIds: [], commandIds: [], startedAt: stamp, evidenceRefs: [], usageRefs: [], findingRefs: [] }),
      workspace: (_command, workerId, attempt) => ({ repository: repo, destination: join(root, workerId), branch: workerId, baseSha, owner: { attemptId: attempt.attemptId, generation: 1, expiresAt: later }, policy: { writableRoots: ['.'] } }), start: async () => fake, prompt: () => 'fixture', correction: () => 'fixture' });
    const artifacts = plane.artifactsFor(context); const objectiveRef = await artifacts.writeText('fixture.objective', 'objective'); const acceptanceRef = await artifacts.writeText('fixture.acceptance', 'acceptance');
    const started = await fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }); finish!(); await fleet.waitForTerminal(started.workerId);
    const uncertain = await fleet.inspect(context, started.workerId);
    assert.equal(uncertain.state, 'unknown', 'runner failure remains durable unknown while native work may still exist');
    assert.equal(uncertain.live, 'known', 'runner failure retains the still-active native worker for explicit cancellation');
    assert.equal((await fleet.stop(context, started.workerId)).state, 'stopped'); plane.close(); plane = await openHost({ stateDirectory: state, now: () => stamp, kinds: { 'worker.spawn': { payloadSchema: payload }, 'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() } } });
    const restarted = new PiWorkerFleet({ ...(fleet as unknown as { binding: ConstructorParameters<typeof PiWorkerFleet>[0] }).binding, host: plane }); const projection = await restarted.inspect(context, started.workerId);
    assert.equal(projection.state, 'terminal'); assert.equal(projection.live, 'unknown'); assert.equal(projection.cancellationRequested, true);
  } finally { plane?.close(); workspace?.close(); await rm(root, { recursive: true, force: true }); }
});

for (const transition of ['owner-transfer', 'autonomy-expiry'] as const) test(`completion evidence survives ${transition} while new work is fenced`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm3-worker-fleet-')); const repo = join(root, 'repo'); const state = join(root, 'host');
  let plane: Awaited<ReturnType<typeof openHost>> | undefined; let workspace: WorkspaceManager | undefined;
  let clock = stamp;
  try {
    await mkdir(repo); await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']); await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim(); workspace = new WorkspaceManager({ stateRoot: join(root, 'workspace') });
    const payload = z.object({ workerId: z.string(), attemptId: z.string(), modelId: z.literal('offline'), modelProvider: z.literal('faux'), modelApi: z.literal('fixture'), role: z.literal('builder'), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict();
    plane = await openHost({ stateDirectory: state, now: () => clock, kinds: {
      'worker.spawn': { payloadSchema: payload, modelSelection: (value) => ({ modelId: payload.parse(value).modelId, role: payload.parse(value).role, requiredCapabilities: ['build'], dataClassification: 'public' as const }) },
      'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() },
    } });
    plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn', 'worker.stop'], expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn', 'worker.stop'], issuedAt: stamp, expiresAt: '2026-09-15T01:00:00Z', maxConcurrency: 2, maxAttemptsPerNode: 2, poolLimits: [], protectedReserves: [] });
    plane.recordModelFact({ modelId: 'offline', provider: 'faux', poolId: 'none', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp });
    plane.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'session', epoch: 1, issuedAt: stamp, expiresAt: later }, 0);
    let finish: (() => void) | undefined; const running = new Promise<void>((resolve) => { finish = resolve; });
    const fake = { sessionId: 'pi-session', isActive: true, modelIdentity: { modelId: 'offline', provider: 'faux', api: 'fixture' }, contextOccupancy: { state: 'known', tokens: 3 }, async run() { await running; (this as { isActive: boolean }).isActive = false; return { result: { status: 'succeeded' }, artifacts: [], repaired: false }; }, async persistedSession() { return { sessionId: 'pi-session', sessionFile: '/host-private/session.json', historyHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', branchDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }; }, async stopLocal() { (this as { isActive: boolean }).isActive = false; finish!(); return 'stopped' as const; }, dispose() {} } as unknown as PiNativeWorker;
    const context: HelmToolExecutionContext = { runId: 'run', sessionId: 'session', mode: 'primary' };
    const fleet = new PiWorkerFleet({ host: plane, workspaceManager: workspace, executor: { executorId: 'fleet' }, claimExpiresAt: () => later, readFact: async () => ({ value: true, state: 'known', source: 'fixture', observedAt: stamp }),
      spawnCommand(input: WorkerSpawnInput, workerId, attemptId): Command { const body = { workerId, attemptId, modelId: input.modelId, modelProvider: 'faux' as const, modelApi: 'fixture' as const, role: input.role, inputDigest: hash({ ...input, contextRefs: [...input.contextRefs] }), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const }; return { schemaVersion: 1, commandId: `spawn-${workerId}`, kind: 'worker.spawn', idempotencyKey: `spawn-${workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      inputDigest: (command) => (command.payload as { inputDigest: string }).inputDigest,
      stopCommand(record): Command { const body = { workerId: record.workerId }; return { schemaVersion: 1, commandId: `stop-${record.workerId}`, kind: 'worker.stop', idempotencyKey: `stop-${record.workerId}`, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] }; },
      attempt(command, workerId): Attempt { return { attemptId: `attempt-${workerId}`, mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'faux', capability: 'build', poolId: 'none', workspace: join(root, workerId), baseSha, contextManifestHash: 'sha256:context', leaseId: 'auto', sessionIds: [], commandIds: [command.commandId], startedAt: stamp, evidenceRefs: [], usageRefs: [], findingRefs: [] }; },
      workspace: (_command, workerId, attempt) => ({ repository: repo, destination: join(root, workerId), branch: workerId, baseSha, owner: { attemptId: attempt.attemptId, generation: 1, expiresAt: later }, policy: { writableRoots: ['.'] } }),
      start: async () => fake, prompt: () => 'fixture', correction: () => 'fixture',
    });
    const registry = createHostWorkerToolRegistry({ context, authorize: async (actual) => { plane!.artifactsFor(actual); }, host: plane, brief: { async read() { return { text: 'brief', source: 'test', observedAt: stamp }; } }, map: { async snapshot() { return { source: { repository: 'repo', parentIssue: 1 }, observedAt: stamp, completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }; } }, economy: { snapshot: () => ({ pools: [], models: [], quota: [] }) } }, fleet);
    const scoped = plane.artifactsFor(context); const objectiveRef = await scoped.writeText('fixture.objective', 'objective'); const acceptanceRef = await scoped.writeText('fixture.acceptance', 'acceptance');
    const start = await registry.invoke('worker.spawn', { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }, context);
    assert.equal(start.state, 'succeeded'); if (start.state !== 'succeeded') throw new Error('unreachable');
    const workerId = (start.value as { workerId: string }).workerId;
    const active = await registry.invoke('worker.inspect', { workerId }, context); assert.equal(active.state, 'succeeded'); assert.equal((active as { value: { live: string } }).value.live, 'known');
    let observationContext = context;
    if (transition === 'owner-transfer') {
      plane.acquireOwnership({ runId: 'run', leaseId: 'replacement-owner', owner: 'astra', sessionId: 'replacement', epoch: 2, issuedAt: stamp, expiresAt: later }, 1);
      observationContext = { ...context, sessionId: 'replacement' };
    } else clock = '2026-09-15T02:00:00Z';
    const refused = await registry.invoke('worker.spawn', { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }, context);
    assert.notEqual(refused.state, 'succeeded', 'authority transition must fence new effects');
    finish!(); await fleet.waitForTerminal(workerId);
    const completed = await fleet.inspect(observationContext, workerId);
    assert.equal(completed.state, 'terminal', 'observations survive the loss of controller or spend authority');
    const lifecycle = (await plane.snapshot('run')).attemptLifecycles.find((entry) => entry.attemptId === (start.value as { attemptId: string }).attemptId);
    assert.equal(lifecycle?.state, 'finished');
    plane.close(); plane = await openHost({ stateDirectory: state, now: () => clock, kinds: { 'worker.spawn': { payloadSchema: payload }, 'worker.stop': { payloadSchema: z.object({ workerId: z.string() }).strict() } } });
    const recovered = await plane.recover('run'); assert.equal(recovered.commands.find((entry) => entry.command.commandId === `spawn-${workerId}`)?.status, 'succeeded');
    const restartedFleet = new PiWorkerFleet({ ...(fleet as unknown as { binding: ConstructorParameters<typeof PiWorkerFleet>[0] }).binding, host: plane });
    const afterRestart = await restartedFleet.inspect(observationContext, workerId); assert.equal(afterRestart.state, 'terminal'); assert.equal(afterRestart.live, 'unknown');
  } finally { plane?.close(); workspace?.close(); await rm(root, { recursive: true, force: true }); }
});
