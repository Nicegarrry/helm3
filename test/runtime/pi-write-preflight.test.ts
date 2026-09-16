import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import { openHost } from '../../src/host/index.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ArtifactJournal } from '../../src/journal/index.js';
import { PiNativeWorker, type PiAuthority } from '../../src/runtime/pi/index.js';
import { WorkspaceManager, WorkspaceRefusal } from '../../src/workspace/index.js';

const exec = promisify(execFile);
const envelope = (files: string[]) => JSON.stringify({
  status: 'succeeded',
  summary: 'completed writes',
  changed_files: files,
  commits: [],
  decisions: [],
  discoveries: [],
  tests_claimed: [],
  acceptance_claims: [],
  risks: [],
  unresolved: [],
  artifacts: [],
  recommended_next_action: 'review',
});

async function setupEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'helm3-pi-write-preflight-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const base = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const manager = new WorkspaceManager({ stateRoot: join(root, 'ownership') });
  const owner = { attemptId: 'attempt-preflight', generation: 1, expiresAt: '2099-01-01T00:00:00Z' };
  const workspace = await manager.create(repo, join(root, 'worker'), 'worker-branch', base, owner);
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const runtime = await ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = ai.fauxProvider({ provider: 'helm-preflight', models: [{ id: 'offline' }] });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey('helm-preflight', 'local-fake');
  const journal = await ArtifactJournal.open({ root: join(root, 'journal') });
  const performedEffects: string[] = [];
  const stops: string[] = [];
  const stamp = '2026-09-16T03:00:00Z'; const end = '2099-01-01T00:00:00Z';
  const schema = z.object({ effectId: z.string(), kind: z.enum(['model.request', 'workspace.write']) }).strict();
  const host = await openHost({ stateDirectory: join(root, 'host'), now: () => stamp, kinds: { 'pi.model': { payloadSchema: schema }, 'pi.write': { payloadSchema: schema } } });
  host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['pi.model', 'pi.write'], expiresAt: end, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
  host.recordAutonomyLease({ leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['pi.model', 'pi.write'], issuedAt: stamp, expiresAt: end, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
  const kernelAuthority = host.piAuthority({ attemptId: owner.attemptId, actorId: 'trusted-test', executorId: 'native-test', commandForEffect(effect) {
    const payload = { effectId: effect.effectId, kind: effect.kind };
    return { schemaVersion: 1, commandId: effect.effectId, kind: effect.kind === 'model.request' ? 'pi.model' : 'pi.write', idempotencyKey: effect.effectId, payloadHash: 'sha256:' + createHash('sha256').update(JSON.stringify(payload)).digest('hex'), scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'trusted-test', runId: 'run', origin: 'worker', leaseId: 'auto', leaseRevision: 1, plannedAt: stamp, notAfter: end, expected: [], payload, requiredEvidence: [] };
  } });
  const authority: PiAuthority = { ...kernelAuthority,
    async perform(effect, action) { performedEffects.push(effect.kind); await kernelAuthority.perform(effect, action); },
    async reportWorkerStop(id, result) { stops.push(result); await kernelAuthority.reportWorkerStop(id, result); },
  };

  const worker = await PiNativeWorker.start({
    commandId: 'parent-cmd',
    attemptId: 'attempt-preflight',
    workspace,
    owner,
    workspaceManager: manager,
    authority,
    journal,
    stateRoot: join(root, 'pi-state'),
    modelRuntime: runtime,
    model: faux.getModel(),
  });
  return {
    root,
    repo,
    worker,
    manager,
    workspace,
    owner,
    runtime,
    faux,
    ai,
    journal,
    performedEffects,
    stops, host, authority,
    async cleanup() {
      worker.dispose();
      manager.close(); host.close();
      await journal.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('assertWriteAllowed is strictly readonly: verifies allowed and refused scopes without creating directories or mutating state', async () => {
  const env = await setupEnvironment();
  try {
    const uncreatedNestedDir = join(env.workspace.root, 'nonexistent', 'nested');
    const targetFile = 'nonexistent/nested/file.txt';
    assert.equal(existsSync(uncreatedNestedDir), false);

    // Preflight check succeeds for an allowed writable path without creating the directory.
    await env.manager.assertWriteAllowed(env.workspace, env.owner, targetFile);
    assert.equal(existsSync(uncreatedNestedDir), false, 'preflight must not create missing directories');

    // Preflight check throws WorkspaceRefusal for protected control paths and out-of-scope paths.
    await assert.rejects(
      async () => env.manager.assertWriteAllowed(env.workspace, env.owner, 'src/core/hunk.ts'),
      (err: unknown) => err instanceof WorkspaceRefusal && err.message === 'control path is protected',
    );
    await assert.rejects(
      async () => env.manager.assertWriteAllowed(env.workspace, env.owner, '../escaped.txt'),
      (err: unknown) => err instanceof WorkspaceRefusal && err.message === 'path escapes assigned worktree',
    );

    // Preflight re-verifies ownership: if ownership expires or changes, it refuses.
    const expiredOwner = { ...env.owner, expiresAt: '2020-01-01T00:00:00Z' };
    await assert.rejects(
      async () => env.manager.assertWriteAllowed(env.workspace, expiredOwner, targetFile),
      (err: unknown) => err instanceof WorkspaceRefusal,
    );
  } finally {
    await env.cleanup();
  }
});

test('native Pi tool write on protected path is refused at preflight without dispatching authority write effect', async () => {
  const env = await setupEnvironment();
  try {
    env.faux.setResponses([
      env.ai.fauxAssistantMessage(env.ai.fauxToolCall('helm_write', { path: 'src/core/secret.ts', contents: 'forbidden' })),
      env.ai.fauxAssistantMessage(env.ai.fauxToolCall('helm_write', { path: 'docs/allowed.txt', contents: 'allowed content' })),
      env.ai.fauxAssistantMessage(envelope(['docs/allowed.txt'])),
    ]);
    const result = await env.worker.run('Test write preflight refusal', 'Return a valid WorkerResult JSON.');

    // Ensure protected write was rejected before admission: authority only performed the allowed write.
    const writeEffects = env.performedEffects.filter((kind) => kind === 'workspace.write');
    assert.equal(writeEffects.length, 1, 'only the allowed write should be dispatched to authority');

    // The protected file must not exist on the filesystem.
    assert.equal(existsSync(join(env.workspace.root, 'src', 'core', 'secret.ts')), false);

    // The allowed file was successfully written.
    assert.equal(existsSync(join(env.workspace.root, 'docs', 'allowed.txt')), true);

    // Session completed normally through the loop.
    assert.equal(result.result.status, 'succeeded');
    assert.deepEqual(result.result.changed_files, ['docs/allowed.txt']);
    assert.equal(env.performedEffects.filter(kind => kind === 'model.request').length, 3);
    const batches = await Promise.all((await env.journal.metadata()).filter(entry => entry.source === 'pi.event').map(async entry => JSON.parse((await env.journal.read(entry.raw, entry.sourceIdentity)).toString('utf8'))));
    assert.ok(batches.flatMap(batch => batch.events).some(row => row.event.type === 'tool_execution_end' && row.event.isError === true), 'tool refusal remains in durable semantic events');
    assert.equal(await env.worker.stopLocal(), 'stopped');
    await env.authority.reportWorkerStop('parent-cmd', 'stopped');
    const snapshot = await env.host.snapshot('run');
    assert.equal(snapshot.commands.length, 4, 'three model requests and one permitted write; no fabricated refused write effect');
    assert.ok(snapshot.commands.every(record => record.status === 'succeeded'));
    assert.equal(snapshot.attemptLifecycles[0]?.state, 'finished', 'known refusal does not quarantine stopped attempt capacity');
  } finally {
    await env.cleanup();
  }
});

test('post-preflight ownership transfer still causes admitted write to refuse inside effect', async () => {
  const env = await setupEnvironment();
  try {
    // Assert write allowed succeeds for the current generation.
    await env.manager.assertWriteAllowed(env.workspace, env.owner, 'docs/race.txt');

    // Transfer ownership to generation 2 (e.g. host fencing / takeover).
    const nextOwner = { attemptId: 'attempt-2', generation: 2, expiresAt: '2099-01-01T00:00:00Z' };
    env.manager.transfer(env.workspace, 1, nextOwner);

    // If an admitted effect tries to execute write with stale owner, the inner check refuses.
    await assert.rejects(
      async () => env.authority.perform({ effectId: 'write-race', kind: 'workspace.write', commandId: 'parent-cmd' }, async () => {
        await env.manager.write(env.workspace, env.owner, 'docs/race.txt', 'data');
      }),
      /Pi effect was not successfully observed: unknown/,
    );
    assert.equal(existsSync(join(env.workspace.root, 'docs/race.txt')), false);
    const snapshot = await env.host.snapshot('run');
    assert.equal(snapshot.commands.find(record => record.command.commandId === 'write-race')?.status, 'unknown', 'a failure after effect admission remains uncertain');
  } finally {
    await env.cleanup();
  }
});
