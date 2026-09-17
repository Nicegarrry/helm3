import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { NativeCommandConfig } from '../../src/host/native-command.js';
import { createNativeCommandEnvironment, nativeCommandKinds } from '../../src/host/native-command.js';
import { openHost } from '../../src/host/index.js';
import { WorkspaceManager } from '../../src/workspace/index.js';

const exec = promisify(execFile);
export const fixtureStamp = '2026-09-17T00:00:00.000Z';
export const fixtureLater = '2099-01-01T00:00:00.000Z';

export const workerEnvelope = (status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded'): string => JSON.stringify({
  status, summary: `native fixture ${status}`, changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [],
  acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review',
});

export async function createLiveNativeFixture(taskId = 'task-live', options: Readonly<{ ownershipExpiresAt?: string; hostNow?: string }> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'helm3-native-command-cli-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const baseSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  const faux = ai.fauxProvider({ provider: 'native-command-faux', models: [{ id: 'offline' }] });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey('native-command-faux', 'fixture');
  const model = faux.getModel()!;
  const stateDirectory = join(root, 'state');
  const ownershipExpiresAt = options.ownershipExpiresAt ?? fixtureLater;
  const config: NativeCommandConfig = {
    schemaVersion: 1, runId: `run-native-${taskId}`, taskId, repositoryId: 'fixture/repo', mapNodeId: 'node', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1',
    stateDirectory, repository: repo, destination: join(root, 'worktree'), branch: 'native-worker', baseSha, writableRoots: ['.'], objectiveRef: '', acceptanceRef: '', contextRefs: [],
    modelId: model.id, modelProvider: model.provider, modelApi: model.api, modelBaseUrl: model.baseUrl, modelFamily: 'fixture', modelFactVersion: 1, requiredCapabilities: ['build'], dataClassification: 'public', credentialEnvironment: 'FIXTURE_KEY',
    autonomyLeaseId: 'auto-live', autonomyLeaseRevision: 1, ownershipLeaseId: 'owner-live', ownershipEpoch: 1, ownershipOwner: 'fable', ownershipSessionId: 'session-live', ownershipIssuedAt: fixtureStamp, ownershipExpiresAt, notAfter: fixtureLater, plannedAt: fixtureStamp,
    policy: { poolId: 'native-usd', baseUrl: model.baseUrl, authEnvironment: 'FIXTURE_KEY', contextWindow: model.contextWindow, maxOutputTokens: Math.min(128, model.maxTokens), maxBilledOutputTokens: Math.min(128, model.maxTokens), maxPacketBytes: 65536, maxRequests: 1, inputUsdPerMillion: 0, outputUsdPerMillion: 0, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, maxToolCalls: 0, timeoutMs: 10_000 },
  };
  const host = await openHost({ stateDirectory, kinds: nativeCommandKinds(config), now: () => options.hostNow ?? fixtureStamp });
  const poolLimits = [{ poolId: 'native-usd', unit: 'usd' as const, limit: 10 }];
  const autonomy = { leaseId: 'auto-live', revision: 1, issuedBy: 'human', parentAuthorityId: 'human-live', scope: { repositoryId: 'fixture/repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn', 'pi.model', 'pi.write'], issuedAt: fixtureStamp, expiresAt: fixtureLater, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits, protectedReserves: [] };
  const ownership = { runId: config.runId, leaseId: 'owner-live', owner: 'fable' as const, sessionId: 'session-live', epoch: 1, issuedAt: fixtureStamp, expiresAt: ownershipExpiresAt };
  host.recordHumanAuthority({ authorityId: 'human-live', repositoryId: 'fixture/repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn', 'pi.model', 'pi.write'], expiresAt: fixtureLater, maxConcurrency: 1, maxAttemptsPerNode: 3, poolLimits, protectedReserves: [] });
  host.recordAutonomyLease(autonomy);
  host.recordModelFact({ modelId: model.id, provider: model.provider, poolId: 'native-usd', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: fixtureStamp });
  host.acquireOwnership(ownership, 0);
  const context = { runId: config.runId, sessionId: ownership.sessionId, mode: 'primary' as const };
  const artifacts = host.artifactsFor(context);
  const objectiveRef = await artifacts.writeText('native-command.fixture.objective', 'Run the provider-free native command fixture.');
  const acceptanceRef = await artifacts.writeText('native-command.fixture.acceptance', 'Return one valid WorkerResult envelope.');
  const finalConfig = { ...config, objectiveRef, acceptanceRef };
  const workspaceManager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
  const modelFact = { modelId: model.id, provider: model.provider, poolId: 'native-usd', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only' as const, availability: 'known_available' as const, factVersion: 1, observedAt: fixtureStamp };
  const environment = createNativeCommandEnvironment(finalConfig, { host, workspaceManager, modelRuntime: runtime, model, modelFact, autonomyLease: autonomy, ownership, context, executorId: 'native-command-cli-test', readFact: async () => ({ value: true, state: 'known' as const, source: 'fixture', observedAt: fixtureStamp }) });
  return {
    root, repo, stateDirectory, config: finalConfig, configPath: join(root, 'native-command.json'), host, runtime, faux, ai, environment,
    async writeConfig() { await writeFile(join(root, 'native-command.json'), JSON.stringify(finalConfig)); },
    async close(remove = true) { workspaceManager.close(); host.close(); if (remove) await rm(root, { recursive: true, force: true }); },
  };
}
