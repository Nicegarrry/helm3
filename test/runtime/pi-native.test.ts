import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod/v3';
import { createBoundedFleetRuntime } from '../../src/host/bounded-fleet-runtime.js';
import type { BoundedPiAccess } from '../../src/access/index.js';
import type { Command } from '../../src/contracts/index.js';
import { openKernel } from '../../src/core/index.js';
import { ArtifactJournal } from '../../src/journal/index.js';
import { PiNativeWorker, type PiAuthority } from '../../src/runtime/pi/index.js';
import { WorkspaceManager } from '../../src/workspace/index.js';

const exec = promisify(execFile);
const now = '2026-09-15T00:00:00Z';
const later = '2026-09-15T01:00:00Z';
const sha = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
type PersistedPiBatch = { events: Array<{ sequence: number; event: { type?: string; assistantMessageEvent?: { type?: string; delta?: string } } }> };

test('native Pi faux session writes through kernel-guarded narrow tool, repairs envelope, journals events and reopens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-pi-native-'));
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } = await import('@earendil-works/pi-ai');
  let host: ReturnType<typeof openKernel>['host'] | undefined;
  let worker: PiNativeWorker | undefined;
  let manager: WorkspaceManager | undefined;
  let modelEffects = 0;
  let nativeAccess: BoundedPiAccess | undefined;
  try {
    const repo = join(root, 'repo'); await mkdir(repo); await exec('git', ['init', repo]);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const base = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    manager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
    const owner = { attemptId: 'attempt-1', generation: 1, expiresAt: '2099-01-01T00:00:00Z' };
    const workspace = await manager.create(repo, join(root, 'worker'), 'pi-attempt-1', base, owner);
    const payloadSchema = z.object({ effectId: z.string(), kind: z.enum(['model.request', 'workspace.write']) }).strict();
    const kernel = openKernel({ databasePath: join(root, 'helm.sqlite'), kinds: {
      'pi.model': { payloadSchema, resourceRequest: () => ({ poolId: 'offline-requests', unit: 'requests', upperBound: 1, consumer: 'worker' }) },
      'pi.write': { payloadSchema },
    }, now: () => now }); host = kernel.host;
    const poolLimits = [{ poolId: 'offline-requests', unit: 'requests', limit: 3 }];
    host.declareHumanAuthority({ authorityId: 'approval', repositoryId: 'repo-1', mapNodeIds: ['node-1'], allowedActions: ['pi.model', 'pi.write'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits, protectedReserves: [] });
    host.issueAutonomyLease({ leaseId: 'lease-1', revision: 1, issuedBy: 'human', parentAuthorityId: 'approval', scope: { repositoryId: 'repo-1', mapNodeIds: ['node-1'] }, allowedActions: ['pi.model', 'pi.write'], issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits, protectedReserves: [] });
    const authority: PiAuthority = {
      async perform(effect, action) {
        const isModel = effect.kind === 'model.request';
        if (isModel && effect.effectId !== 'over-budget') assert.equal(nativeAccess!.reservation(effect.effectId).provider, 'helm3-faux', 'the factory attaches the real bounded provider guard before kernel effects');
        const payload = { effectId: effect.effectId, kind: effect.kind };
        host!.admit({ schemaVersion: 1, commandId: effect.effectId, kind: isModel ? 'pi.model' : 'pi.write', idempotencyKey: effect.effectId, payloadHash: sha(payload), scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'untrusted-worker', runId: 'run-1', origin: 'worker', leaseId: 'lease-1', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] }, { actorId: 'trusted-pi-runtime', attemptId: 'attempt-1', allowedOrigins: ['worker'] });
        if (isModel) modelEffects += 1;
        const claim = host!.claim(effect.effectId, { executorId: 'pi-session-1' }, later);
        const observed = await host!.perform(effect.effectId, claim, { executorId: 'pi-session-1' }, async () => { throw new Error('no precondition was admitted for this effect'); }, { effectId: `kernel:${effect.effectId}`, execute: action, observe: () => ({ commandId: effect.effectId, effectId: `kernel:${effect.effectId}`, state: 'succeeded' as const, source: 'native-pi-test', observedAt: now, evidenceRefs: ['test:kernel-observation'] }) });
        assert.equal(observed.state, 'succeeded');
        // Only the completed faux request supplies this exact unit of evidence.
        if (isModel) host!.settleResource(effect.effectId, { state: 'known', amount: 1 });
      },
      requestCancellation: async () => undefined,
      reportWorkerStop: async (_commandId, observed) => host!.reportAttemptStop('attempt-1', observed),
    };
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new InMemoryCredentialStore() });
    const faux = fauxProvider({ provider: 'helm3-faux', models: [{ id: 'offline' }], tokensPerSecond: 1_000_000, tokenSize: { min: 1, max: 1 } }); runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('helm3-faux', 'offline');
    faux.setResponses([
      fauxAssistantMessage([fauxThinking('r'.repeat(1400)), fauxToolCall('helm_write', { path: 'result.txt', contents: 'native Pi wrote this\n' })]),
      fauxAssistantMessage('not a WorkerResult'),
      fauxAssistantMessage(JSON.stringify({ status: 'succeeded', summary: 'done', changed_files: ['result.txt'], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' })),
    ]);
    const journal = await ArtifactJournal.open({ root: join(root, 'journal') });
    const model = faux.getModel();
    const lifecycle = createBoundedFleetRuntime({
      workerFor: () => ({ attemptId: owner.attemptId, owner, workspaceManager: manager!, stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model, thinking: { level: 'low' } }),
      policyFor: () => ({ poolId: 'fixture-money', provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, authEnvironment: 'FAUX_TEST_KEY', contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens, maxBilledOutputTokens: model.maxTokens, maxPacketBytes: 128 * 1024, maxRequests: 3, inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.1, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, maxToolCalls: 1, timeoutMs: 10000, allowCorrection: true }),
      authorityFor: (command, access) => { assert.ok(['attempt-command', 'continuation-command'].includes(command.commandId)); nativeAccess = access; return authority; },
      journalFor: (command) => { assert.ok(['attempt-command', 'continuation-command'].includes(command.commandId)); return journal; },
    });
    const spawn: Command = { schemaVersion: 1, commandId: 'attempt-command', kind: 'worker.spawn', idempotencyKey: 'attempt-command', payloadHash: sha({}), scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'fixture-host', runId: 'run-1', origin: 'human', leaseId: 'lease-1', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload: {}, requiredEvidence: [] };
    worker = await lifecycle.start(spawn, workspace);
    assert.deepEqual(worker.thinkingConfiguration, { requested: 'low', nativeSelected: 'off', providerEffective: 'unknown' }, 'Pi clamps an unsupported faux-model level and Helm records that native selection');
    const outcome = await worker.run('Write the requested file and finish with JSON.', 'Your terminal envelope was malformed. Return only a valid WorkerResult JSON object.');
    assert.equal(outcome.repaired, true); assert.equal(outcome.result.status, 'succeeded');
    assert.equal(modelEffects, 3, 'every native turn, including the automatic post-tool turn and correction, crosses the authority guard');
    assert.equal(await readFile(join(workspace.root, 'result.txt'), 'utf8'), 'native Pi wrote this\n');
    assert.ok(outcome.artifacts.length >= 2, 'native event stream and envelope are durable artifacts');
    const eventMetadata = (await journal.metadata()).filter(entry => entry.source === 'pi.event');
    assert.ok(eventMetadata.length > 0, 'one-character faux reasoning is durably batched rather than snapshot-journaled per update');
    const eventBatches = await Promise.all(eventMetadata.map(async entry => JSON.parse((await journal.read(entry.raw, entry.sourceIdentity)).toString('utf8')) as PersistedPiBatch));
    const persistedEvents = eventBatches
      .flatMap(batch => batch.events)
      .sort((left, right) => left.sequence - right.sequence);
    assert.deepEqual(persistedEvents.map(entry => entry.sequence), Array.from({ length: persistedEvents.length }, (_, index) => index + 1), 'Pi event batches retain exact observed ordering');
    assert.equal(persistedEvents.filter(entry => entry.event.type === 'message_update' && entry.event.assistantMessageEvent?.type === 'thinking_delta').map(entry => entry.event.assistantMessageEvent?.delta).join(''), 'r'.repeat(1400), 'one-character reasoning deltas reconstruct exactly from durable JSON batches');
    assert.equal(worker.contextOccupancy.state, 'known', 'the native SDK exposes estimated current occupancy');
    const originalSession = worker.sessionId;
    const persisted = await worker.persistedSession();
    const sourceBytes = await readFile(persisted.sessionFile);
    const forkOwner = { attemptId: 'attempt-fork', generation: 1, expiresAt: '2099-01-01T00:00:00Z' };
    const forkWorkspace = await manager.create(repo, join(root, 'fork-worker'), 'pi-attempt-fork', base, forkOwner);
    const forked = await PiNativeWorker.forkAtCurrentTip({ commandId: 'fork-command', attemptId: 'attempt-fork', workspace: forkWorkspace, owner: forkOwner, workspaceManager: manager, authority, journal, stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model: faux.getModel(), thinking: { level: 'low' } }, persisted);
    assert.notEqual(forked.successor.sessionId, persisted.sessionId, 'native fork allocates a distinct Pi session');
    assert.equal(forked.successor.branchDigest, persisted.branchDigest, 'native fork retains exactly the current source branch');
    assert.deepEqual(await readFile(persisted.sessionFile), sourceBytes, 'native fork does not rewrite source session bytes');
    assert.equal(modelEffects, 3, 'forking a session makes no provider request');
    forked.worker.dispose();
    const originalAccess = nativeAccess;
    worker.dispose();
    const reopened = await lifecycle.rehydrate!({ ...spawn, commandId: 'continuation-command' }, workspace, persisted);
    assert.equal(reopened.sessionId, originalSession, 'factory rehydrates the same native session');
    assert.notEqual(nativeAccess, originalAccess, 'new command binds a fresh request guard');
    assert.equal(reopened.contextOccupancy.state, 'known', 'reopen retains read-only occupancy inspection');
    assert.deepEqual(reopened.thinkingConfiguration, { requested: 'low', nativeSelected: 'off', providerEffective: 'unknown' });
    await assert.rejects(authority.perform({ effectId: 'over-budget', kind: 'model.request', commandId: 'attempt-command' }, async () => { throw new Error('must not reach provider'); }), /cap|budget/);
    assert.equal(modelEffects, 3, 'settled requests stay charged across reopen');
    assert.equal(await reopened.cancel(), 'stopped');
    reopened.dispose(); worker = undefined;
    await journal.close();
  } finally { worker?.dispose(); host?.close(); manager?.close(); await rm(root, { recursive: true, force: true }); }
});
