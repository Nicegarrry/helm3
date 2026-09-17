import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nativeCommandIdentity, runNativeCommand, type NativeCommandConfig, type NativeCommandEnvironment } from '../../src/host/native-command.js';

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
    readFleetTerminalResult: async () => ({ status: 'succeeded', summary: 'fixture', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' }),
  } as unknown as NativeCommandEnvironment['host'];
  const value: NativeCommandEnvironment = {
    host, context: { runId: 'run-native', sessionId: 'session', mode: 'primary' }, autonomyLease: autonomy as any,
    ownership: { runId: 'run-native', leaseId: 'owner', owner: 'fable', sessionId: 'session', epoch: 1, issuedAt: stamp, expiresAt: later }, modelFact,
    now: () => stamp,
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
