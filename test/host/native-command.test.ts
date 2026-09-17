import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nativeCommandIdentity, runNativeCommand, type NativeCommandConfig, type NativeCommandEnvironment } from '../../src/host/native-command.js';
import { createNativeCommandEnvironment, nativeCommandKinds } from '../../src/host/native-command.js';
import { openHost } from '../../src/host/index.js';
import { WorkspaceManager } from '../../src/workspace/index.js';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const stamp = '2026-09-17T00:00:00.000Z';
const later = '2099-01-01T00:00:00.000Z';
const modelFact = { modelId: 'offline', provider: 'fixture', poolId: 'fixture-pool', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only' as const, availability: 'known_available' as const, factVersion: 1, observedAt: stamp };
const autonomy = { leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'fixture/repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn'], issuedAt: stamp, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] };

function config(stateDirectory: string): NativeCommandConfig {
  return {
    schemaVersion: 1, runId: 'run-native', taskId: 'task-one', repositoryId: 'fixture/repo', mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1',
    stateDirectory, repository: '/tmp/fixture-repository', destination: '/tmp/fixture-worktree', branch: 'native-worker', baseSha: '0123456789012345678901234567890123456789',
    writableRoots: ['.'], objectiveRef: 'artifact:objective', acceptanceRef: 'artifact:acceptance', contextRefs: [], modelId: 'offline', modelProvider: 'fixture', modelApi: 'openai-completions', modelBaseUrl: 'https://fixture.invalid/v1', modelFamily: 'fixture', modelFactVersion: 1, requiredCapabilities: ['build'], dataClassification: 'public', credentialEnvironment: 'FIXTURE_KEY', autonomyLeaseId: 'auto', autonomyLeaseRevision: 1,
    ownershipLeaseId: 'owner', ownershipEpoch: 1, ownershipOwner: 'fable', ownershipSessionId: 'session', ownershipIssuedAt: stamp, ownershipExpiresAt: later, notAfter: later, plannedAt: stamp,
    policy: { poolId: 'fixture-pool', baseUrl: 'https://fixture.invalid/v1', authEnvironment: 'FIXTURE_KEY', contextWindow: 4096, maxOutputTokens: 128, maxBilledOutputTokens: 128, maxPacketBytes: 65536, maxRequests: 1, inputUsdPerMillion: 0, outputUsdPerMillion: 0, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, maxToolCalls: 0, timeoutMs: 10_000 },
  };
}

function environment(commands: Array<{ command: any; status: string; observations: any[] }>): NativeCommandEnvironment {
  const host = {
    readFleetProjection: () => ({ commands, attempts: [] }),
    snapshot: async () => ({ commands, attempts: [], attemptLifecycles: [], autonomyLeases: [], reservations: [], artifacts: [], recoveryRefs: [], runId: 'run-native' }),
    readFleetEffectByIdentity: async () => undefined,
    readFleetEffectRecordByIdentity: async (_runId: string, identity: string) => identity.includes('terminal-known') ? { text: JSON.stringify({ evidenceRefs: ['known-ref'], sessionId: 'pi-session' }), evidenceRef: 'known-ref' } : undefined,
    readFleetTerminalResult: async () => ({ status: 'succeeded', summary: 'fixture', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' }),
  } as unknown as NativeCommandEnvironment['host'];
  const value: NativeCommandEnvironment = {
    host, context: { runId: 'run-native', sessionId: 'session', mode: 'primary' }, autonomyLease: autonomy as any,
    ownership: { runId: 'run-native', leaseId: 'owner', owner: 'fable', sessionId: 'session', epoch: 1, issuedAt: stamp, expiresAt: later }, modelFact,
    now: () => stamp, readFact: async () => ({ value: true, state: 'known' as const, source: 'fixture', observedAt: stamp }),
    dispatch: async (plan, identity) => {
      const key = nativeCommandIdentity('run-native', 'task-one').workerId.slice('worker-native-'.length);
      assert.equal(plan.command.commandId, `native-worker-spawn-${key}`);
      commands.push({ command: plan.command, status: 'succeeded', observations: [{ evidenceRefs: [] }] });
      return { ...identity, sessionId: 'pi-session', state: 'ready' };
    },
  };
  return value;
}

test('native command binds planner identity and observes an existing command without dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-native-command-'));
  try {
    const commands: Array<{ command: any; status: string; observations: any[] }> = [];
    let dispatches = 0;
    const env = environment(commands); const original = env.dispatch;
    const dispatchEnv = { ...env, dispatch: async (...args: Parameters<typeof original>) => { dispatches += 1; return original(...args); } };
    const first = await runNativeCommand(config(root), dispatchEnv);
    assert.equal(first.state, 'succeeded'); assert.equal(dispatches, 1); assert.equal(first.configDigest.startsWith('sha256:'), true);
    const second = await runNativeCommand(config(root), { ...dispatchEnv, dispatch: async () => { throw new Error('must not dispatch a durable command twice'); } });
    assert.equal(second.commandId, first.commandId); assert.equal(second.workerId, first.workerId); assert.equal(second.state, 'succeeded');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native command refuses a manifest mismatch before any dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-native-command-'));
  try {
    const commands: Array<{ command: any; status: string; observations: any[] }> = [];
    const env = environment(commands); await runNativeCommand(config(root), env);
    await assert.rejects(runNativeCommand({ ...config(root), destination: '/tmp/changed-worktree' }, { ...env, dispatch: async () => { throw new Error('must not dispatch'); } }), /manifest/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const workerResult = JSON.stringify({ status: 'succeeded', summary: 'native fixture completed', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' });

async function nativeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'helm3-native-command-live-'));
  const repo = join(root, 'repo'); await mkdir(repo);
  await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent'); const ai = await import('@earendil-works/pi-ai');
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  const faux = ai.fauxProvider({ provider: 'native-command-faux', models: [{ id: 'offline' }] }); runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('native-command-faux', 'fixture');
  const model = faux.getModel()!;
  const stampConfig: NativeCommandConfig = {
    ...config(join(root, 'state')),
    runId: 'run-native-live', taskId: 'task-live', repositoryId: 'fixture/repo', mapNodeId: 'node', baseSha,
    repository: repo, destination: join(root, 'worktree'), modelId: model.id, modelProvider: model.provider, modelApi: model.api, modelBaseUrl: model.baseUrl,
    autonomyLeaseId: 'auto-live', autonomyLeaseRevision: 1, ownershipLeaseId: 'owner-live', ownershipEpoch: 1, ownershipOwner: 'fable', ownershipSessionId: 'session-live', ownershipIssuedAt: stamp, ownershipExpiresAt: later,
    policy: { ...config(join(root, 'state')).policy, poolId: 'native-usd', baseUrl: model.baseUrl, contextWindow: model.contextWindow, maxOutputTokens: Math.min(128, model.maxTokens), maxBilledOutputTokens: Math.min(128, model.maxTokens) },
  };
  const host = await openHost({ stateDirectory: join(root, 'host'), kinds: nativeCommandKinds(stampConfig), now: () => stamp });
  const poolLimits = [{ poolId: 'native-usd', unit: 'usd' as const, limit: 10 }];
  const autonomy = { leaseId: 'auto-live', revision: 1, issuedBy: 'human', parentAuthorityId: 'human-live', scope: { repositoryId: 'fixture/repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn', 'pi.model', 'pi.write'], issuedAt: stamp, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits, protectedReserves: [] };
  const ownership = { runId: stampConfig.runId, leaseId: 'owner-live', owner: 'fable' as const, sessionId: 'session-live', epoch: 1, issuedAt: stamp, expiresAt: later };
  host.recordHumanAuthority({ authorityId: 'human-live', repositoryId: 'fixture/repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn', 'pi.model', 'pi.write'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits, protectedReserves: [] });
  host.recordAutonomyLease(autonomy);
  host.recordModelFact({ modelId: model.id, provider: model.provider, poolId: 'native-usd', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp });
  host.acquireOwnership(ownership, 0);
  const context = { runId: stampConfig.runId, sessionId: ownership.sessionId, mode: 'primary' as const };
  const artifacts = host.artifactsFor(context);
  const objectiveRef = await artifacts.writeText('native-command.fixture.objective', 'Run the provider-free native command fixture.');
  const acceptanceRef = await artifacts.writeText('native-command.fixture.acceptance', 'Return one valid WorkerResult envelope.');
  const commandConfig = { ...stampConfig, objectiveRef, acceptanceRef };
  const workspaceManager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
  const built = createNativeCommandEnvironment(commandConfig, { host, workspaceManager, modelRuntime: runtime, model, modelFact: { modelId: model.id, provider: model.provider, poolId: 'native-usd', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: stamp }, autonomyLease: autonomy, ownership, context, executorId: 'native-command-test', readFact: async () => ({ value: true, state: 'known' as const, source: 'fixture', observedAt: stamp }) });
  return { root, host, runtime, faux, ai, config: commandConfig, environment: built, context, async close() { workspaceManager.close(); host.close(); await rm(root, { recursive: true, force: true }); } };
}

test('native command composes real Host, Kernel, Fleet, bounded runtime, and Pi faux provider end to end', async () => {
  const fixture = await nativeFixture();
  try {
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage(workerResult)]);
    const result = await runNativeCommand(fixture.config, fixture.environment);
    assert.equal(result.state, 'succeeded'); assert.equal(result.commandStatus, 'succeeded'); assert.equal((result.result as { status: string }).status, 'succeeded');
    assert.equal(fixture.faux.state.callCount, 1);
    const again = await runNativeCommand(fixture.config, { ...fixture.environment, ownership: { ...fixture.environment.ownership, epoch: 999 }, modelFact: { ...fixture.environment.modelFact, modelId: 'missing-after-restart' }, dispatch: async () => { throw new Error('existing native command must be observed without dispatch'); } });
    assert.equal(again.commandId, result.commandId); assert.equal(again.state, 'succeeded'); assert.equal(fixture.faux.state.callCount, 1);
  } finally { await fixture.close(); }
});

test('native command refuses changed durable configuration and concurrent callers keep one command identity', async () => {
  const fixture = await nativeFixture();
  try {
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage(workerResult)]);
    const [first, second] = await Promise.allSettled([runNativeCommand(fixture.config, fixture.environment), runNativeCommand(fixture.config, fixture.environment)]);
    assert.ok(first.status === 'fulfilled' || second.status === 'fulfilled');
    const snapshot = await fixture.host.snapshot(fixture.config.runId);
    assert.equal(snapshot.commands.filter(entry => entry.command.kind === 'worker.spawn').length, 1, 'concurrent native callers admit one durable spawn');
    assert.equal(fixture.faux.state.callCount, 1, 'concurrent native callers make one provider request');
    await assert.rejects(runNativeCommand({ ...fixture.config, destination: join(fixture.root, 'different-worktree') }, fixture.environment), /manifest/);
  } finally { await fixture.close(); }
});


test('native command refuses contradictory resource bounds before admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-native-invalid-'));
  try {
    const commands: Array<{ command: any; status: string; observations: any[] }> = [];
    const value = config(root);
    await assert.rejects(runNativeCommand({ ...value, policy: { ...value.policy, maxOutputTokens: 129, maxBilledOutputTokens: 128 } }, environment(commands)), /output cap/);
    await assert.rejects(runNativeCommand({ ...value, policy: { ...value.policy, baseUrl: 'https:\/\/different.invalid' } }, environment(commands)), /endpoint/);
    assert.equal(commands.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
