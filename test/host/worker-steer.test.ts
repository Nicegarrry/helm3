import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod/v3';
import type { Attempt, Command } from '../../src/contracts/index.js';
import { openHost } from '../../src/host/index.js';
import { createHostGateTool, gateRunPayloadSchema } from '../../src/host/gate-tools.js';
import { PiWorkerFleet, type WorkerForkInput, type WorkerSpawnInput, type WorkerSteerInput } from '../../src/host/worker-fleet.js';
import type { HelmToolExecutionContext } from '../../src/runtime/orchestrator/index.js';
import type { PiNativeWorker, PiPersistedSession } from '../../src/runtime/pi/index.js';
import { WorkspaceManager, type WorktreeReservation } from '../../src/workspace/index.js';

const exec = promisify(execFile); const stamp = '2026-09-15T00:00:00Z'; const later = '2099-01-01T00:00:00Z';
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const session = { sessionId: 'pi-session', sessionFile: '/host-private/session.json', historyHash: `sha256:${'0'.repeat(64)}`, branchDigest: `sha256:${'1'.repeat(64)}` };
type Deferred = { release(): void; promise: Promise<void> };
function deferred(): Deferred { let release: () => void = () => undefined; const promise = new Promise<void>((resolve) => { release = resolve; }); return { release, promise }; }

function worker(id: string, wait?: Deferred, modelId = 'offline', failPersistence = false): PiNativeWorker {
  const value = { sessionId: id, isActive: true, modelIdentity: { modelId, provider: 'faux', api: 'fixture' }, contextOccupancy: { state: 'known', tokens: 1 },
    async run() { if (wait) await wait.promise; (this as { isActive: boolean }).isActive = false; return { result: { status: 'succeeded' }, artifacts: [], repaired: false }; },
    async persistedSession() { if (failPersistence) throw new Error('fixture cannot persist session'); return session; }, async stopLocal() { (this as { isActive: boolean }).isActive = false; return 'stopped' as const; }, dispose() {} };
  return value as unknown as PiNativeWorker;
}

async function setup(options: { successorWait?: Deferred; successorModel?: string; successorPersistenceFailure?: boolean; registryProvider?: string; forkReceiptFailure?: boolean; forkEventFailure?: boolean; forkSourceChangedAtEffect?: 'leaf' | 'history' | 'branch'; forkDestinationChangedAtEffect?: boolean; forkOwnerChangedAtEffect?: boolean } = {}) {
  const createdRoot = mkdtempSync(join(tmpdir(), 'helm3-worker-steer-')); const root = await realpath(createdRoot); const repo = join(root, 'repo'); const state = join(root, 'host'); let clock = stamp;
  await mkdir(repo); await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']); await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim(); const workspace = new WorkspaceManager({ stateRoot: join(root, 'workspace') });
  const spawnPayload = z.object({ workerId: z.string(), attemptId: z.string(), modelId: z.literal('offline'), modelProvider: z.literal('faux'), modelApi: z.literal('fixture'), role: z.literal('builder'), inputDigest: z.string(), baseSha: z.string(), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict();
  const steerPayload = z.object({ workerId: z.string(), attemptId: z.string(), predecessorWorkerId: z.string(), inputDigest: z.string(), modelId: z.literal('offline'), modelProvider: z.literal('faux'), modelApi: z.literal('fixture'), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only'), expectedHead: z.string() }).strict();
  const forkPayload = steerPayload.extend({ sourceSessionId: z.string(), sourceHistoryHash: z.string().regex(/^sha256:[0-9a-f]{64}$/), sourceBranchDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), sourceLeafId: z.string(), destination: z.string(), ownerAttemptId: z.string(), ownerGeneration: z.number().int(), ownerExpiresAt: z.string() }).strict();
  const kinds = { 'gate.run': { payloadSchema: gateRunPayloadSchema }, 'worker.spawn': { payloadSchema: spawnPayload, modelSelection: (value: unknown) => ({ modelId: spawnPayload.parse(value).modelId, role: 'builder', requiredCapabilities: ['build'], dataClassification: 'public' as const }) }, 'worker.steer': { payloadSchema: steerPayload, modelSelection: (value: unknown) => ({ modelId: steerPayload.parse(value).modelId, role: 'builder', requiredCapabilities: ['build'], dataClassification: 'public' as const }) }, 'worker.fork': { payloadSchema: forkPayload, modelSelection: (value: unknown) => ({ modelId: forkPayload.parse(value).modelId, role: 'builder', requiredCapabilities: ['build'], dataClassification: 'public' as const }) } };
  let plane = await openHost({ stateDirectory: state, now: () => clock, kinds });
  plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn', 'worker.steer', 'worker.fork', 'gate.run'], expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 4, poolLimits: [], protectedReserves: [] });
  plane.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn', 'worker.steer', 'worker.fork', 'gate.run'], issuedAt: stamp, expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 4, poolLimits: [], protectedReserves: [] });
  plane.recordModelFact({ modelId: 'offline', provider: options.registryProvider ?? 'faux', poolId: 'none', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp }); plane.acquireOwnership({ runId: 'run', leaseId: 'owner', owner: 'fable', sessionId: 'session', epoch: 1, issuedAt: stamp, expiresAt: later }, 0);
  const context: HelmToolExecutionContext = { runId: 'run', sessionId: 'session', mode: 'primary' }; let rehydrates = 0; let effectFault: 'head' | 'lease' | 'epoch' | undefined;
  const forkedWorkerIds = new Set<string>(); let forkSourceReads = 0; let forkConfigReads = 0; let forks = 0;
  const binding = () => ({ host: plane, workspaceManager: workspace, executor: { executorId: 'fleet' }, claimExpiresAt: () => '2200-01-01T00:00:00Z', readFact: async () => {
    const fault = effectFault; effectFault = undefined;
    if (fault === 'head') await writeFile(join(root, 'worker', 'README.md'), 'mutated after admission\n');
    if (fault === 'lease') clock = '2100-01-01T00:00:00Z';
    if (fault === 'epoch') plane.acquireOwnership({ runId: 'run', leaseId: 'effect-owner', owner: 'astra', sessionId: 'effect-session', epoch: 2, issuedAt: stamp, expiresAt: later }, 1);
    return { value: true, state: 'known' as const, source: 'fixture', observedAt: stamp };
  },
    spawnCommand(input: WorkerSpawnInput, workerId: string, attemptId: string): Command { const payload = { workerId, attemptId, modelId: input.modelId, modelProvider: 'faux' as const, modelApi: 'fixture' as const, role: input.role, inputDigest: hash({ ...input, contextRefs: [...input.contextRefs] }), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const }; return command(`spawn-${workerId}`, 'worker.spawn', payload, attemptId); },
    steerCommand(input: WorkerSteerInput, workerId: string, previous: { workerId: string; modelId?: string; modelProvider?: string; modelApi?: string; modelFactVersion?: number; dataPolicy?: string }, attemptId: string): Command { const payload = { workerId, attemptId, predecessorWorkerId: previous.workerId, inputDigest: hash({ ...input, evidenceRefs: [...input.evidenceRefs] }), modelId: previous.modelId!, modelProvider: previous.modelProvider!, modelApi: previous.modelApi!, modelFactVersion: previous.modelFactVersion!, dataPolicy: previous.dataPolicy!, expectedHead: input.expectedHead }; return command(`steer-${workerId}`, 'worker.steer', payload, attemptId); },
    forkCommand(input: WorkerForkInput, workerId: string, previous: { workerId: string; modelId?: string; modelProvider?: string; modelApi?: string; modelFactVersion?: number; dataPolicy?: string }, attemptId: string, source: { sessionId: string; historyHash: string; branchDigest: string; leafId: string }): Command { forkedWorkerIds.add(workerId); const payload = { workerId, attemptId, predecessorWorkerId: previous.workerId, inputDigest: hash(input), modelId: previous.modelId!, modelProvider: previous.modelProvider!, modelApi: previous.modelApi!, modelFactVersion: previous.modelFactVersion!, dataPolicy: previous.dataPolicy!, expectedHead: input.expectedHead, sourceSessionId: source.sessionId, sourceHistoryHash: source.historyHash, sourceBranchDigest: source.branchDigest, sourceLeafId: source.leafId, destination: join(root, 'fork-child'), ownerAttemptId: attemptId, ownerGeneration: 1, ownerExpiresAt: later }; return command(`fork-${workerId}`, 'worker.fork', payload, attemptId); },
    inputDigest: (command: Command) => (command.payload as { inputDigest: string }).inputDigest, stopCommand: () => { throw new Error('unused'); },
    attempt(command: Command, workerId: string): Attempt { const payload = command.payload as { attemptId: string; baseSha?: string; expectedHead?: string; predecessorWorkerId?: string }; return { attemptId: payload.attemptId, mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'faux', capability: 'build', poolId: 'none', workspace: command.kind === 'worker.fork' || (command.kind === 'worker.steer' && typeof payload.predecessorWorkerId === 'string' && forkedWorkerIds.has(payload.predecessorWorkerId)) ? join(root, 'fork-child') : join(root, 'worker'), baseSha: payload.baseSha ?? payload.expectedHead!, contextManifestHash: 'sha256:context', leaseId: 'auto', sessionIds: [], commandIds: [command.commandId], startedAt: stamp, evidenceRefs: [], usageRefs: [], findingRefs: [] }; },
    workspace(command: Command, _workerId: string, attempt: Attempt) { const steer = command.kind === 'worker.steer'; const fork = command.kind === 'worker.fork'; if (fork) forkConfigReads += 1; return { repository: repo, destination: fork && forkConfigReads > 1 && options.forkDestinationChangedAtEffect ? join(root, 'other-fork-child') : attempt.workspace, branch: attempt.workspace.endsWith('fork-child') ? 'fork-child' : 'worker', baseSha: attempt.baseSha, owner: { attemptId: fork && forkConfigReads > 1 && options.forkOwnerChangedAtEffect ? 'other-attempt' : attempt.attemptId, generation: steer ? 2 : 1, expiresAt: later }, policy: { writableRoots: ['.'] } }; },
    start: async () => worker('pi-session'), rehydrate: async (_command: Command, _workspace: WorktreeReservation, persisted: PiPersistedSession) => { rehydrates++; return worker(persisted.sessionId, options.successorWait, options.successorModel ?? 'offline', options.successorPersistenceFailure); },
    forkSourceSnapshot: async (persisted: PiPersistedSession) => { forkSourceReads += 1; const changed = forkSourceReads > 1 ? options.forkSourceChangedAtEffect : undefined; return { sessionId: persisted.sessionId, historyHash: changed === 'history' ? `sha256:${'2'.repeat(64)}` : persisted.historyHash, branchDigest: changed === 'branch' ? `sha256:${'3'.repeat(64)}` : persisted.branchDigest, leafId: changed === 'leaf' ? 'other-leaf' : 'leaf' }; },
    fork: async (_command: Command, _workspace: WorktreeReservation, persisted: PiPersistedSession, expectedLeafId: string) => { forks += 1; assert.equal(expectedLeafId, 'leaf'); const child = worker('pi-fork-session'); return { worker: child, successor: { ...persisted, sessionId: 'pi-fork-session', sessionFile: '/host-private/fork.json' }, leafId: 'leaf' }; }, prompt: () => 'fixture', correction: () => 'fixture' });
  const fleet = new PiWorkerFleet(binding()); const artifacts = plane.artifactsFor(context); const objectiveRef = await artifacts.writeText('objective', 'objective'); const acceptanceRef = await artifacts.writeText('acceptance', 'acceptance'); const evidenceRef = await artifacts.writeText('evidence', 'evidence');
  const started = await fleet.spawn(context, { objectiveRef, acceptanceRef, contextRefs: [], modelId: 'offline', role: 'builder' }); await fleet.waitForTerminal(started.workerId);
  if (options.forkReceiptFailure) {
    const originalArtifactsFor = plane.artifactsFor.bind(plane);
    (plane as unknown as { artifactsFor: typeof plane.artifactsFor }).artifactsFor = ((actual: HelmToolExecutionContext) => {
      const original = originalArtifactsFor(actual);
      return Object.freeze({ ...original, writeEffect: async () => { throw new Error('fixture fork receipt failure'); } });
    }) as unknown as typeof plane.artifactsFor;
  }
  if (options.forkEventFailure) {
    (plane as unknown as { appendFleetEvent: (entry: unknown) => void }).appendFleetEvent = () => { throw new Error('fixture fork event failure after receipt'); };
  }
  return { root, repo, state, workspace, get plane() { return plane; }, async reopen() { plane.close(); plane = await openHost({ stateDirectory: state, now: () => clock, kinds }); }, setClock(value: string) { clock = value; }, armEffectFault(value: 'head' | 'lease' | 'epoch') { effectFault = value; }, context, fleet, binding, baseSha, objectiveRef, evidenceRef, started, rehydrates: () => rehydrates, forks: () => forks, async cleanup() { plane.close(); workspace.close(); await rm(root, { recursive: true, force: true }); } };
  function command(id: string, kind: 'worker.spawn' | 'worker.steer' | 'worker.fork', payload: object, attemptId: string): Command { return { schemaVersion: 1, commandId: id, kind, idempotencyKey: id, payloadHash: hash(payload), payload, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'fable', runId: 'run', origin: 'orchestrator', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: stamp, notAfter: '2200-01-01T00:00:00Z', expected: kind === 'worker.steer' ? [{ authority: 'helm', subject: 'fixture-effect', predicate: 'fresh' }] : [], requiredEvidence: [] }; }
}

function steerInput(f: Awaited<ReturnType<typeof setup>>) { return { workerId: f.started.workerId, objectiveRef: f.objectiveRef, evidenceRefs: [f.evidenceRef], expectedSessionId: 'pi-session', expectedHead: f.baseSha }; }
function forkInput(f: Awaited<ReturnType<typeof setup>>) { return { workerId: f.started.workerId, expectedSessionId: 'pi-session', expectedHead: f.baseSha }; }

test('fork creates a durable idle child in a distinct worktree and steer activates it', async () => { const f = await setup(); try { const parent = await f.fleet.inspect(f.context, f.started.workerId); const fork = await f.fleet.fork(f.context, forkInput(f)); const child = await f.fleet.inspect(f.context, fork.workerId); assert.equal(child.state, 'fork_ready'); assert.notEqual(child.workspace, parent.workspace); assert.equal((await f.plane.snapshot('run')).commands.filter((item) => item.command.kind === 'pi.model').length, 0); const next = await f.fleet.steer(f.context, { workerId: fork.workerId, objectiveRef: f.objectiveRef, evidenceRefs: [f.evidenceRef], expectedSessionId: fork.sessionId, expectedHead: f.baseSha }); await f.fleet.waitForTerminal(next.workerId); assert.equal((await f.fleet.inspect(f.context, next.workerId)).state, 'terminal'); } finally { await f.cleanup(); } });

test('a succeeded fork_ready survives host reopen and only explicit steer starts its child session', async () => { const f = await setup(); try { const source = await f.workspace.read(f.workspace.reservation(join(f.root, 'worker')), 'README.md'); const fork = await f.fleet.fork(f.context, forkInput(f)); assert.equal((await f.plane.snapshot('run')).commands.filter((item) => item.command.kind === 'pi.model').length, 0); await f.reopen(); const recovered = new PiWorkerFleet(f.binding()); const idle = await recovered.inspect(f.context, fork.workerId); assert.equal(idle.state, 'fork_ready'); assert.equal(idle.live, 'unknown'); assert.equal(await f.workspace.read(f.workspace.reservation(join(f.root, 'worker')), 'README.md'), source); const next = await recovered.steer(f.context, { workerId: fork.workerId, objectiveRef: f.objectiveRef, evidenceRefs: [f.evidenceRef], expectedSessionId: fork.sessionId, expectedHead: f.baseSha }); await recovered.waitForTerminal(next.workerId); assert.equal((await recovered.inspect(f.context, next.workerId)).state, 'terminal'); } finally { await f.cleanup(); } });

test('post-receipt fork event failure is unknown, quarantined, and cannot be retried after reopen', async () => { const f = await setup({ forkEventFailure: true }); try { await assert.rejects(f.fleet.fork(f.context, forkInput(f)), /unknown.*reconcile/); const command = (await f.plane.snapshot('run')).commands.find((item) => item.command.kind === 'worker.fork'); const childId = (command?.command.payload as { workerId?: string }).workerId!; assert.equal(command?.status, 'unknown'); assert.ok(command?.observations.some((item) => item.evidenceRefs.length > 0)); const local = await f.fleet.inspect(f.context, childId).catch(() => undefined); assert.notEqual(local?.state, 'fork_ready'); await assert.rejects(f.fleet.steer(f.context, { workerId: childId, objectiveRef: f.objectiveRef, evidenceRefs: [f.evidenceRef], expectedSessionId: 'pi-fork-session', expectedHead: f.baseSha }), /recoverable/); await assert.rejects(f.fleet.fork(f.context, forkInput(f)), /fork attempt/); await f.reopen(); const recovered = new PiWorkerFleet(f.binding()); const reopened = await recovered.inspect(f.context, childId).catch(() => undefined); assert.notEqual(reopened?.state, 'fork_ready'); await assert.rejects(recovered.fork(f.context, forkInput(f)), /fork attempt/); } finally { await f.cleanup(); } });

test('changed source snapshots and child identity bindings refuse before workspace or native fork effects', async () => {
  const cases: Array<Parameters<typeof setup>[0]> = [
    { forkSourceChangedAtEffect: 'leaf' }, { forkSourceChangedAtEffect: 'history' }, { forkSourceChangedAtEffect: 'branch' },
    { forkDestinationChangedAtEffect: true }, { forkOwnerChangedAtEffect: true },
  ];
  for (const options of cases) {
    const f = await setup(options);
    try {
      await assert.rejects(f.fleet.fork(f.context, forkInput(f)), /unknown.*reconcile|source changed|destination or owner changed/);
      assert.equal(f.forks(), 0, 'a refused immutable fork must not reach native SessionManager branching');
      assert.throws(() => f.workspace.reservation(join(f.root, 'fork-child')), /no active durable worktree ownership/, 'a refused immutable fork must not create the child worktree');
    } finally { await f.cleanup(); }
  }
});

test('steer snapshots mutable input, finishes a new attempt, and remains inspectable after fleet restart', async () => { const f = await setup(); try { const input = steerInput(f); const pending = f.fleet.steer(f.context, input); input.expectedHead = 'f'.repeat(40); const next = await pending; await f.fleet.waitForTerminal(next.workerId); const snapshot = await f.plane.snapshot('run'); assert.equal(snapshot.attemptLifecycles.find((item) => item.attemptId === next.attemptId)?.state, 'finished'); assert.equal((await new PiWorkerFleet(f.binding()).inspect(f.context, next.workerId)).state, 'terminal'); assert.equal(f.rehydrates(), 1); } finally { await f.cleanup(); } });

test('a staggered stale parent cannot transfer a clean successor generation', async () => { const hold = deferred(); const f = await setup({ successorWait: hold }); try { const first = await f.fleet.steer(f.context, steerInput(f)); await assert.rejects(f.fleet.steer(f.context, steerInput(f)), /generation/); assert.equal(f.workspace.reservation(join(f.root, 'worker')).owner.attemptId, first.attemptId); assert.equal(f.rehydrates(), 1); hold.release(); await f.fleet.waitForTerminal(first.workerId); } finally { await f.cleanup(); } });

test('changed heads, foreign gate evidence, expired lease, and stale epoch refuse before rehydrate', async () => { const f = await setup(); try { await writeFile(join(f.root, 'worker', 'README.md'), 'dirty\n'); await assert.rejects(f.fleet.steer(f.context, steerInput(f)), /head/); await exec('git', ['-C', join(f.root, 'worker'), 'checkout', '--', 'README.md']); await assert.rejects(f.fleet.steer(f.context, { ...steerInput(f), gateCommandId: 'foreign-gate' }), /gate evidence/); f.setClock('2100-01-01T00:00:00Z'); await assert.rejects(f.fleet.steer(f.context, steerInput(f)), /lease|expired/); f.setClock(stamp); f.plane.acquireOwnership({ runId: 'run', leaseId: 'owner2', owner: 'astra', sessionId: 'new', epoch: 2, issuedAt: stamp, expiresAt: later }, 1); await assert.rejects(f.fleet.steer(f.context, steerInput(f)), /owner|epoch|session/); assert.equal(f.rehydrates(), 0); } finally { await f.cleanup(); } });

test('a mismatched native continuation model records unknown rather than starting a successor runner', async () => { const f = await setup({ successorModel: 'wrong' }); try { await assert.rejects(f.fleet.steer(f.context, steerInput(f)), /unknown.*reconcile/); const record = (await f.plane.snapshot('run')).commands.find((item) => item.command.kind === 'worker.steer'); assert.equal(record?.status, 'unknown'); assert.match(record?.observations.at(-1)?.detail ?? '', /identity changed/); assert.equal(f.rehydrates(), 1); } finally { await f.cleanup(); } });

test('at-effect Git, lease, and epoch rechecks prevent a successor from rehydrating', async () => { for (const fault of ['head', 'lease', 'epoch'] as const) { const f = await setup(); try { f.armEffectFault(fault); await assert.rejects(f.fleet.steer(f.context, steerInput(f)), /unknown.*reconcile|lease|owner|epoch/); const record = (await f.plane.snapshot('run')).commands.find((item) => item.command.kind === 'worker.steer'); assert.equal(f.rehydrates(), 0, `${fault} must not reach Pi rehydrate`); assert.equal(record?.status, fault === 'head' ? 'unknown' : 'refused'); } finally { await f.cleanup(); } } });

test('a continuation whose terminal persistence fails is durably marked unknown', async () => { const f = await setup({ successorPersistenceFailure: true }); try { const next = await f.fleet.steer(f.context, steerInput(f)); await f.fleet.waitForTerminal(next.workerId); assert.equal((await new PiWorkerFleet(f.binding()).inspect(f.context, next.workerId)).state, 'unknown'); const lifecycle = (await f.plane.snapshot('run')).attemptLifecycles.find((item) => item.attemptId === next.attemptId); assert.equal(lifecycle?.state, 'unknown'); } finally { await f.cleanup(); } });

test('registered provider mismatch refuses spawn before native execution', async () => {
  await assert.rejects(() => setup({ registryProvider: 'different-provider' }), /provenance.*registered|provider/i);
});

// These are two real worktrees at the same SHA. A worker label and head alone
// cannot prove that a gate inspected the worktree being continued.
test('steer accepts only gate evidence from its own canonical worktree', async () => {
  for (const foreignWorkspace of [true, false]) {
    const f = await setup();
    try {
      const gate = createHostGateTool({
        context: f.context, authorize: async () => undefined, host: f.plane,
        executor: { executorId: 'gate-fixture' }, claimExpiresAt: () => '2200-01-01T00:00:00Z',
        command: { actorId: 'fable', leaseId: 'auto', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: () => stamp, notAfter: () => later },
        catalog: { async resolve() { return {
          gateId: 'content', workerId: f.started.workerId, repositoryId: 'repo', mapNodeId: 'node',
          workspaceId: 'opaque-registered-workspace', workspace: foreignWorkspace ? f.repo : join(f.root, 'worker'),
          expectedHead: f.baseSha, acceptanceVersion: '1', environment: {},
          checks: [{ name: 'content', executable: process.execPath, args: ['-e', "if(require('fs').readFileSync('README.md','utf8') !== 'base\\n') process.exit(1)"], timeoutMs: 5000 }],
        }; } },
      });
      const gateResult = await gate.execute({ gateId: 'content', workerId: f.started.workerId, expectedHead: f.baseSha }, f.context);
      assert.equal(gateResult.state, 'succeeded');
      if (gateResult.state !== 'succeeded') throw new Error('fixture gate must complete');
      const evidence = gateResult.value as { commandId: string; gateState: string; evidenceRefs: string[] };
      assert.equal(evidence.gateState, 'succeeded');
      const input = { ...steerInput(f), gateCommandId: evidence.commandId, evidenceRefs: evidence.evidenceRefs };
      if (foreignWorkspace) {
        await assert.rejects(f.fleet.steer(f.context, input), /gate evidence/);
        assert.equal(f.rehydrates(), 0);
      } else {
        const next = await f.fleet.steer(f.context, input);
        await f.fleet.waitForTerminal(next.workerId);
        assert.equal(f.rehydrates(), 1);
        assert.equal((await f.fleet.inspect(f.context, next.workerId)).state, 'terminal');
      }
    } finally { await f.cleanup(); }
  }
});
