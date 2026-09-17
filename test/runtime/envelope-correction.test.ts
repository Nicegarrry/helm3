import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod/v3';
import { BoundedPiAccess } from '../../src/access/index.js';
import { openKernel } from '../../src/core/index.js';
import { ArtifactJournal } from '../../src/journal/index.js';
import { PiNativeWorker, type PiAuthority } from '../../src/runtime/pi/index.js';
import { selectTrustedEnvelopeLineage } from '../../src/host/envelope-lineage.js';
import { WorkspaceManager } from '../../src/workspace/index.js';

const exec = promisify(execFile);
const stamp = '2026-09-17T00:00:00.000Z';
const later = '2099-01-01T00:00:00.000Z';
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

type Harness = {
  root: string;
  repo: string;
  workspace: Awaited<ReturnType<WorkspaceManager['create']>>;
  manager: WorkspaceManager;
  journal: ArtifactJournal;
  worker: PiNativeWorker;
  access: BoundedPiAccess;
  host: ReturnType<typeof openKernel>['host'];
  providerCalls: () => number;
};

const result = (files: string[]) => JSON.stringify({
  status: 'succeeded', summary: 'completed', changed_files: files, commits: [], decisions: [], discoveries: [],
  tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'report',
});

async function harness(responses: unknown[], maxRequests = 4, options: { readonly?: boolean; expireAfterFirst?: boolean } = {}): Promise<Harness> {
  let clock = stamp;
  const root = await mkdtemp(join(tmpdir(), 'helm3-envelope-correction-'));
  const repo = join(root, 'repo'); await mkdir(repo); await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const base = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const manager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
  const owner = { attemptId: 'attempt-correction', generation: 1, expiresAt: later };
  const workspace = await manager.create(repo, join(root, 'worker'), 'worker-correction', base, owner, { writableRoots: options.readonly ? [] : ['.'], readableRoots: ['.'] });
  const kernel = openKernel({ databasePath: join(root, 'helm.sqlite'), kinds: {
    'pi.model': { payloadSchema: z.object({ effectId: z.string(), kind: z.literal('model.request') }).strict(), resourceRequest: () => ({ poolId: 'offline', unit: 'requests', upperBound: 1, consumer: 'worker' }) },
    'pi.write': { payloadSchema: z.object({ effectId: z.string(), kind: z.literal('workspace.write') }).strict() },
  }, now: () => clock });
  const host = kernel.host;
  const limits = [{ poolId: 'offline', unit: 'requests', limit: maxRequests }];
  host.declareHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['pi.model', 'pi.write'], expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 4, poolLimits: limits, protectedReserves: [] });
  host.issueAutonomyLease({ leaseId: 'lease', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['pi.model', 'pi.write'], issuedAt: stamp, expiresAt: later, maxConcurrency: 2, maxAttemptsPerNode: 4, poolLimits: limits, protectedReserves: [] });
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  const faux = ai.fauxProvider({ provider: 'helm3-faux', models: [{ id: 'offline' }], tokensPerSecond: 1_000_000, tokenSize: { min: 1, max: 1 } });
  runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('helm3-faux', 'offline'); faux.setResponses(responses as never[]);
  const model = faux.getModel()!;
  const access = new BoundedPiAccess({ poolId: 'offline', provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, authEnvironment: 'FIXTURE', contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens, maxBilledOutputTokens: model.maxTokens, maxPacketBytes: 128 * 1024, maxRequests, inputUsdPerMillion: 1, outputUsdPerMillion: 1, cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, maxToolCalls: 2, timeoutMs: 10_000, allowCorrection: true });
  const authority: PiAuthority = {
    async perform(effect, action) {
      const isModel = effect.kind === 'model.request';
      if (isModel) assert.ok(access.reservation(effect.effectId), 'bounded access reserves before kernel admission');
      const body = { effectId: effect.effectId, kind: effect.kind };
      const command = { schemaVersion: 1 as const, commandId: effect.effectId, kind: isModel ? 'pi.model' as const : 'pi.write' as const, idempotencyKey: effect.effectId, payloadHash: hash(body), payload: body, scope: { repositoryId: 'repo', mapNodeId: 'node' }, actorId: 'worker', runId: 'run', origin: 'worker' as const, leaseId: 'lease', leaseRevision: 1, plannedAt: stamp, notAfter: later, expected: [], requiredEvidence: [] };
      host.admit(command, { actorId: 'trusted-pi', attemptId: 'attempt-correction', allowedOrigins: ['worker'] });
      const claim = host.claim(effect.effectId, { executorId: 'native' }, later);
      await host.perform(effect.effectId, claim, { executorId: 'native' }, async () => { throw new Error('no preconditions'); }, { effectId: `kernel:${effect.effectId}`, execute: action, observe: () => ({ commandId: effect.effectId, effectId: `kernel:${effect.effectId}`, state: 'succeeded' as const, source: 'test', observedAt: stamp, evidenceRefs: ['test:effect'] }) });
      if (isModel) {
        host.settleResource(effect.effectId, { state: 'known', amount: 1 });
        if (options.expireAfterFirst) clock = '2100-01-01T00:00:00.000Z';
      }
    }, requestCancellation: async () => undefined, reportWorkerStop: async () => undefined,
  };
  const journal = await ArtifactJournal.open({ root: join(root, 'journal') });
  const worker = await PiNativeWorker.start({ commandId: 'attempt-correction', attemptId: 'attempt-correction', workspace, owner, workspaceManager: manager, authority, journal, stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model, access, mode: options.readonly ? 'review-readonly' : 'worker' });
  return { root, repo, workspace, manager, journal, worker, access, host, providerCalls: () => faux.state.callCount };
}

async function close(h: Harness): Promise<void> { h.worker.dispose(); h.journal.close(); h.host.close(); h.manager.close(); await rm(h.root, { recursive: true, force: true }); }

test('schema-valid initial changed_files mismatch gets one same-session correction and preserves both raw envelopes', async () => {
  const ai = await import('@earendil-works/pi-ai');
  const h = await harness([ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'result.txt', contents: 'changed\n' })), ai.fauxAssistantMessage(result([])), ai.fauxAssistantMessage(result(['result.txt']))]);
  try {
    const outcome = await h.worker.run('write and report', 'correct changed_files');
    assert.equal(outcome.repaired, true); assert.equal(outcome.result.changed_files[0], 'result.txt'); assert.equal(h.providerCalls(), 3);
    const envelopes = (await h.journal.metadata()).filter(e => e.source === 'pi.envelope');
    assert.equal(envelopes.length, 2); assert.ok(envelopes.every(e => e.sourceIdentity.includes('attempt-correction')));
    assert.equal(await readFile(join(h.workspace.root, 'result.txt'), 'utf8'), 'changed\n');
  } finally { await close(h); }
});

test('a schema-valid correction that still claims the wrong changed_files fails closed', async () => {
  const ai = await import('@earendil-works/pi-ai');
  const h = await harness([ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'result.txt', contents: 'changed\n' })), ai.fauxAssistantMessage(result([])), ai.fauxAssistantMessage(result(['other.txt']))]);
  try { await assert.rejects(h.worker.run('write and report', 'correct changed_files'), /changed_files|envelope|terminal/); assert.equal(h.providerCalls(), 3); } finally { await close(h); }
});

test('schema-invalid initial followed by mechanical-invalid correction consumes one correction slot and fails', async () => {
  const ai = await import('@earendil-works/pi-ai');
  const invalid = JSON.stringify({ status: 'succeeded', summary: 'bad', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [{ leaked: 'value' }], unresolved: [], artifacts: [], recommended_next_action: 'stop' });
  const h = await harness([ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'result.txt', contents: 'changed\n' })), ai.fauxAssistantMessage(invalid), ai.fauxAssistantMessage(result([]))]);
  try { await assert.rejects(h.worker.run('write and report', 'correct schema'), /changed_files|envelope|terminal/); assert.equal(h.providerCalls(), 3); } finally { await close(h); }
});

test('bounded maxRequests=1 prevents a correction from admitting a second provider request', async () => {
  const ai = await import('@earendil-works/pi-ai');
  const invalid = JSON.stringify({ status: 'succeeded', summary: 'bad', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [{ leaked: 'value' }], unresolved: [], artifacts: [], recommended_next_action: 'stop' });
  const h = await harness([ai.fauxAssistantMessage(result(['README.md'])), ai.fauxAssistantMessage(result([]))], 1, { readonly: true });
  try { await assert.rejects(h.worker.run('report', 'correct schema'), /cap|budget|envelope|terminal/); assert.equal(h.providerCalls(), 1); assert.equal(h.host.readRun('run').commands.filter(c => c.command.kind === 'pi.model').length, 1, 'no second reserved command'); } finally { await close(h); }
});

test('fresh Git recheck catches a file added during correction even when the correction schema validates', async () => {
  const ai = await import('@earendil-works/pi-ai');
  const h = await harness([ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'first.txt', contents: 'first\n' })), ai.fauxAssistantMessage(result([])), ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'second.txt', contents: 'second\n' })), ai.fauxAssistantMessage(result(['first.txt']))]);
  try { await assert.rejects(h.worker.run('write and report', 'correct changed_files'), /changed_files|envelope|terminal/); assert.equal(await readFile(join(h.workspace.root, 'second.txt'), 'utf8'), 'second\n'); } finally { await close(h); }
});


test('read-only reviewer corrects inspected files without replacing its native session', async () => {
  const ai = await import('@earendil-works/pi-ai');
  const h = await harness([ai.fauxAssistantMessage(result(['README.md'])), ai.fauxAssistantMessage(result([]))], 2, { readonly: true });
  try {
    const sessionId = h.worker.sessionId;
    const outcome = await h.worker.run('review without writing', 'correct the file claim');
    assert.equal(h.worker.sessionId, sessionId);
    assert.equal(outcome.repaired, true);
    assert.deepEqual(outcome.result.changed_files, []);
    assert.equal(h.providerCalls(), 2);
    const records = await h.journal.metadata();
    const envelopes = records.filter(e => e.source === 'pi.envelope');
    assert.equal(envelopes.length, 2);
    assert.deepEqual((await Promise.all(envelopes.map(e => h.journal.read(e.raw, e.sourceIdentity)))).map(x => x.toString()).sort(), [result(['README.md']), result([])].sort());
    const dispositions = await Promise.all(records.filter(e => e.source === 'pi.envelope_disposition').map(async e => JSON.parse((await h.journal.read(e.raw, e.sourceIdentity)).toString())));
    assert.equal(dispositions.filter(d => d.status === 'accepted').length, 1);
    assert.equal(dispositions.filter(d => d.status === 'rejected' && d.reason === 'changed_files_mismatch').length, 1);
    assert.ok(dispositions.every(d => d.sessionId === sessionId && d.attemptId === 'attempt-correction'));
  } finally { await close(h); }
});

test('lease expiry after initial bad claim prevents a second provider effect', async () => {
  const ai = await import('@earendil-works/pi-ai');
  const h = await harness([ai.fauxAssistantMessage(result(['README.md'])), ai.fauxAssistantMessage(result([]))], 2, { readonly: true, expireAfterFirst: true });
  try {
    await assert.rejects(h.worker.run('review', 'correct claim'));
    assert.equal(h.providerCalls(), 1);
    assert.equal(h.host.readRun('run').commands.filter(c => c.command.kind === 'pi.model').length, 1, 'expired lease admits no second effect');
    assert.ok((await h.journal.metadata()).some(e => e.source === 'pi.envelope'));
  } finally { await close(h); }
});


test('identical report bytes remain distinct phases when correction restores the workspace', async () => {
  const ai = await import('@earendil-works/pi-ai');
  const report = result([]);
  const h = await harness([
    ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'README.md', contents: 'changed\n' })),
    ai.fauxAssistantMessage(report),
    ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'README.md', contents: 'base\n' })),
    ai.fauxAssistantMessage(report),
  ]);
  try {
    const outcome = await h.worker.run('write and report', 'correct');
    assert.equal(outcome.repaired, true);
    const selected = await selectTrustedEnvelopeLineage({ attemptId: 'attempt-correction', commandId: 'attempt-correction', sessionId: h.worker.sessionId, evidenceRefs: outcome.artifacts.map(a => a.ref), metadata: await h.journal.metadata(), read: (raw, identity) => h.journal.read(raw, identity) });
    assert.deepEqual(selected?.result, outcome.result);
    const envelopes = (await h.journal.metadata()).filter(e => e.source === 'pi.envelope');
    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[0]!.raw.ref, envelopes[1]!.raw.ref);
    assert.notEqual(envelopes[0]!.sourceIdentity, envelopes[1]!.sourceIdentity);
  } finally { await close(h); }
});

test('unavailable Git observation preserves raw evidence and spends no correction request', async () => {
  const ai = await import('@earendil-works/pi-ai');
  let h: Harness;
  h = await harness([async () => {
    await rename(join(h.workspace.root, '.git'), join(h.workspace.root, '.git-unavailable'));
    return ai.fauxAssistantMessage(result([]));
  }, ai.fauxAssistantMessage(result([]))], 2, { readonly: true });
  try {
    await assert.rejects(h.worker.run('review', 'correct'));
    assert.equal(h.providerCalls(), 1);
    const records = await h.journal.metadata();
    const envelopes = records.filter(e => e.source === 'pi.envelope');
    assert.ok(envelopes.length > 0);
    assert.equal((await h.journal.read(envelopes[0]!.raw, envelopes[0]!.sourceIdentity)).toString(), result([]));
    const dispositions = await Promise.all(records.filter(e => e.source === 'pi.envelope_disposition').map(async e => JSON.parse((await h.journal.read(e.raw, e.sourceIdentity)).toString())));
    assert.ok(dispositions.every(d => d.status !== 'accepted' && d.reason !== 'changed_files_mismatch'));
  } finally {
    await rename(join(h.workspace.root, '.git-unavailable'), join(h.workspace.root, '.git'));
    await close(h);
  }
});

test('interrupted correction preserves its assistant report and never records it accepted', async () => {
  const ai = await import('@earendil-works/pi-ai');
  const h = await harness([ai.fauxAssistantMessage(result(['README.md'])), ai.fauxAssistantMessage(result([]))], 2, { readonly: true });
  const append = h.journal.append.bind(h.journal);
  h.journal.append = async (input, access) => {
    if (input.source === 'pi.envelope_disposition' && input.sourceIdentity.endsWith(':correction')) throw new Error('injected disposition persistence failure');
    return append(input, access);
  };
  try {
    await assert.rejects(h.worker.run('review', 'correct'), /injected disposition persistence failure/);
    assert.equal(h.providerCalls(), 2);
    const records = await h.journal.metadata();
    const interrupted = records.find(e => e.source === 'pi.envelope' && e.sourceIdentity.endsWith(':interrupted'));
    assert.ok(interrupted);
    assert.equal((await h.journal.read(interrupted.raw, interrupted.sourceIdentity)).toString(), result([]));
    const dispositions = await Promise.all(records.filter(e => e.source === 'pi.envelope_disposition').map(async e => JSON.parse((await h.journal.read(e.raw, e.sourceIdentity)).toString())));
    assert.ok(dispositions.every(d => d.status !== 'accepted'));
    assert.ok(dispositions.some(d => d.reason === 'interrupted'));
  } finally { h.journal.append = append; await close(h); }
});
