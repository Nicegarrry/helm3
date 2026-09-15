import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod';
import { openKernel } from '../../src/core/index.js';
import { ArtifactJournal } from '../../src/journal/index.js';
import { PiNativeWorker, type PiAuthority } from '../../src/runtime/pi/index.js';
import { WorkspaceManager } from '../../src/workspace/index.js';

const exec = promisify(execFile);
const now = '2026-09-15T00:00:00Z';
const later = '2026-09-15T01:00:00Z';
const sha = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

test('native Pi faux session writes through kernel-guarded narrow tool, repairs envelope, journals events and reopens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-pi-native-'));
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import('@earendil-works/pi-ai');
  let host: ReturnType<typeof openKernel>['host'] | undefined;
  let worker: PiNativeWorker | undefined;
  let modelEffects = 0;
  try {
    const repo = join(root, 'repo'); await mkdir(repo); await exec('git', ['init', repo]);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const base = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    const manager = new WorkspaceManager();
    const owner = { attemptId: 'attempt-1', generation: 1, expiresAt: '2099-01-01T00:00:00Z' };
    const workspace = await manager.create(repo, join(root, 'worker'), 'pi-attempt-1', base, owner);
    const kernel = openKernel({ databasePath: join(root, 'helm.sqlite'), kinds: { 'pi.effect': { payloadSchema: z.object({ effectId: z.string(), kind: z.string() }).strict() } }, now: () => now }); host = kernel.host;
    host.issueAutonomyLease({ leaseId: 'lease-1', revision: 1, issuedBy: 'human', parentAuthorityId: 'approval', scope: { repositoryId: 'repo-1', mapNodeIds: ['node-1'] }, allowedActions: ['pi.effect'], issuedAt: now, expiresAt: later, maxConcurrency: 4, maxAttemptsPerNode: 4, poolLimits: [], protectedReserves: [] });
    const authority: PiAuthority = {
      async perform(effect, action) {
        if (effect.kind === 'model.request') modelEffects += 1;
        const payload = { effectId: effect.effectId, kind: effect.kind };
        host!.admit({ schemaVersion: 1, commandId: effect.effectId, kind: 'pi.effect', idempotencyKey: effect.effectId, payloadHash: sha(payload), scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'untrusted-worker', runId: 'run-1', origin: 'worker', leaseId: 'lease-1', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] }, { actorId: 'trusted-pi-runtime', allowedOrigins: ['worker'] });
        const claim = host!.claim(effect.effectId, { executorId: 'pi-session-1' }, later);
        const observed = await host!.perform(effect.effectId, claim, { executorId: 'pi-session-1' }, async () => { throw new Error('no precondition was admitted for this effect'); }, { effectId: `kernel:${effect.effectId}`, execute: action, observe: () => ({ commandId: effect.effectId, effectId: `kernel:${effect.effectId}`, state: 'succeeded' as const, source: 'native-pi-test', observedAt: now, evidenceRefs: ['test:kernel-observation'] }) });
        assert.equal(observed.state, 'succeeded');
      },
      requestCancellation: async () => undefined,
      reportWorkerStop: async (_commandId, observed) => assert.equal(observed, 'stopped'),
    };
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json'), credentials: new InMemoryCredentialStore() });
    const faux = fauxProvider({ provider: 'helm3-faux', models: [{ id: 'offline' }] }); runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('helm3-faux', 'offline');
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('helm_write', { path: 'result.txt', contents: 'native Pi wrote this\n' })),
      fauxAssistantMessage('not a WorkerResult'),
      fauxAssistantMessage(JSON.stringify({ status: 'succeeded', summary: 'done', changed_files: ['result.txt'], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' })),
    ]);
    const journal = await ArtifactJournal.open({ root: join(root, 'journal') });
    worker = await PiNativeWorker.start({ commandId: 'attempt-command', attemptId: 'attempt-1', workspace, owner, workspaceManager: manager, authority, journal, stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model: faux.getModel() });
    const outcome = await worker.run('Write the requested file and finish with JSON.', 'Your terminal envelope was malformed. Return only a valid WorkerResult JSON object.');
    assert.equal(outcome.repaired, true); assert.equal(outcome.result.status, 'succeeded');
    assert.equal(modelEffects, 3, 'every native turn, including the automatic post-tool turn and correction, crosses the authority guard');
    assert.equal(await readFile(join(workspace.root, 'result.txt'), 'utf8'), 'native Pi wrote this\n');
    assert.ok(outcome.artifacts.length >= 2, 'native event stream and envelope are durable artifacts');
    const reopened = await worker.reopen(); assert.equal(reopened.sessionId, worker.sessionId); reopened.dispose(); worker = undefined;
    await journal.close();
  } finally { worker?.dispose(); host?.close(); await rm(root, { recursive: true, force: true }); }
});
