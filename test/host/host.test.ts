import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod/v3';
import { BoundedPiAccess } from '../../src/access/index.js';
import { createBoundedPiWorkerBinding, settlementForBoundedPiEffect } from '../../src/access/live.js';
import { type Command } from '../../src/contracts/index.js';
import { type KernelEffect } from '../../src/core/index.js';
import { openHost, PiNativeRuntime, type HostRuntime } from '../../src/host/index.js';
import { ArtifactJournal } from '../../src/journal/index.js';
import { HelmToolRegistry, FableDriver } from '../../src/runtime/orchestrator/index.js';
import { WorkspaceManager } from '../../src/workspace/index.js';

const now = '2026-09-15T00:00:00Z';
const later = '2026-09-15T01:00:00Z';
const kinds = { 'host.effect': { payloadSchema: z.object({ value: z.string() }).strict() } };
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const exec = promisify(execFile);

function stateDirectory(): string { return mkdtempSync(join(tmpdir(), 'helm3-host-')); }
function grant() {
  return { authorityId: 'human-1', repositoryId: 'repo-1', mapNodeIds: ['node-1'], allowedActions: ['host.effect'], expiresAt: later,
    maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] };
}
function lease() {
  return { leaseId: 'autonomy-1', revision: 1, issuedBy: 'human', parentAuthorityId: 'human-1', scope: { repositoryId: 'repo-1', mapNodeIds: ['node-1'] },
    allowedActions: ['host.effect'], issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] };
}
function command(sessionId: string, id = 'command-1'): Command {
  const payload = { value: 'provider-free' };
  return { schemaVersion: 1, commandId: id, kind: 'host.effect', idempotencyKey: id, payloadHash: hash(payload), scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' },
    actorId: 'untrusted-model', runId: 'run-1', origin: 'orchestrator', leaseId: 'autonomy-1', leaseRevision: 1,
    orchestratorLeaseId: 'orchestrator-1', orchestratorEpoch: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] };
}
function receiptFixture(effects: string[]): HostRuntime {
  return { createEffect: async ({ command: input, artifacts }): Promise<KernelEffect> => {
    const effectId = `fixture:${input.commandId}`; let receiptRef: string | undefined;
    return { effectId, execute: async () => { receiptRef = await artifacts.writeEffect('host.test.effect', input.commandId); effects.push(input.commandId); },
      observe: async () => ({ commandId: input.commandId, effectId, state: 'succeeded', source: 'host-test-fixture', observedAt: now, evidenceRefs: [receiptRef!] }) };
  } };
}
async function startedHost(runtime: HostRuntime) {
  const directory = stateDirectory();
  const plane = await openHost({ stateDirectory: directory, kinds, now: () => now, runtime });
  plane.recordHumanAuthority(grant());
  plane.recordAutonomyLease(lease());
  const authority = { runId: 'run-1' as const, owner: 'fable' as const, leaseId: 'orchestrator-1', expectedEpoch: 0, issuedAt: now, expiresAt: later };
  const guard = plane.createSessionGuard(authority);
  const driver = new FableDriver(plane.artifactsForStart(authority), new HelmToolRegistry([]), guard, plane.recoveryStateForStart(authority), { env: {} });
  const started = await driver.start({ runId: 'run-1', contextRefs: [], mode: 'primary' });
  return { plane, driver, sessionId: started.sessionId, directory };
}

test('host binds driver-generated ownership before recovery capture and exposes durable snapshot/recovery artifacts', async () => {
  const effects: string[] = []; const runtime = receiptFixture(effects);
  const { plane, driver, sessionId } = await startedHost(runtime);
  const before = await plane.snapshot('run-1');
  assert.equal(before.ownership?.sessionId, sessionId);
  assert.equal(before.ownership?.epoch, 1);

  const admitted = plane.admitOrchestrator(command(sessionId), { runId: 'run-1', sessionId, mode: 'primary' }, 'trusted-fable');
  assert.equal(admitted.command.actorId, 'trusted-fable');
  await plane.perform('command-1', { executorId: 'faux-pi' }, '2026-09-15T00:10:00Z', async () => ({ value: true, state: 'known', source: 'fixture', observedAt: now }));
  assert.deepEqual(effects, ['command-1']);

  const { bundleRef } = await driver.checkpoint({ sessionId });
  const context = { runId: 'run-1', sessionId, mode: 'primary' as const };
  const bundle = await plane.artifactsFor(context).loadRecoveryBundle(bundleRef);
  assert.equal(bundle.sessionId, sessionId);
  const restored = await plane.recoveryStateFor(context).restore(bundle.recoveryStateRef);
  const restoredState = JSON.parse(restored) as { sessionId: string; contextRefs: string[]; snapshot: { ownership: { sessionId: string } } };
  assert.equal(restoredState.sessionId, sessionId);
  assert.deepEqual(restoredState.contextRefs, []);
  assert.equal(restoredState.snapshot.ownership.sessionId, sessionId);
  const after = await plane.snapshot('run-1');
  assert.equal(after.commands[0]?.status, 'succeeded');
  assert.equal(after.autonomyLeases[0]?.lease.leaseId, 'autonomy-1');
  assert.equal(after.artifacts.length, 1);
  assert.ok(after.recoveryRefs.length >= 2);
  const originalArtifactRef = after.artifacts[0]!.ref;
  const originalRecoveryRef = after.recoveryRefs[0]!;
  plane.revokeAutonomyLease('autonomy-1');
  assert.equal((await plane.snapshot('run-1')).autonomyLeases[0]?.revoked, true);

  const mutableContext = { runId: 'run-1', sessionId, mode: 'primary' as const };
  const immutableArtifacts = plane.artifactsFor(mutableContext);
  mutableContext.runId = 'run-2'; mutableContext.sessionId = 'caller-edited';
  const immutableRef = await immutableArtifacts.writeText('host.test.immutable-context', 'bound before caller mutation');
  assert.equal((JSON.parse(immutableRef) as { runId: string; sessionId: string }).runId, 'run-1');
  assert.equal((JSON.parse(immutableRef) as { runId: string; sessionId: string }).sessionId, sessionId);

  const scoped = plane.artifactsFor(context);
  const textRef = await scoped.writeText('host.test.context', 'only this session may read');
  await assert.rejects(scoped.loadRecoveryBundle(textRef), /wrong kind/);
  const malformedRefs = await scoped.saveRecoveryBundle({ driver: 'fable', runId: 'run-1', sessionId, mode: 'primary', contextRefs: ['context', 7] as unknown as string[], eventRefs: [], recoveryStateRef: bundle.recoveryStateRef });
  await assert.rejects(scoped.loadRecoveryBundle(malformedRefs), /invalid durable recovery bundle/);
  const wrongStateKind = await scoped.saveRecoveryBundle({ driver: 'fable', runId: 'run-1', sessionId, mode: 'primary', contextRefs: ['context'], eventRefs: ['event'], recoveryStateRef: textRef });
  await assert.rejects(scoped.loadRecoveryBundle(wrongStateKind), /wrong kind/);
  plane.acquireOwnership({ runId: 'run-2', leaseId: 'orchestrator-run-2', owner: 'fable', sessionId: 'run-2-session', epoch: 1, issuedAt: now, expiresAt: later }, 0);
  const runTwoArtifacts = plane.artifactsFor({ runId: 'run-2', sessionId: 'run-2-session', mode: 'primary' });
  await assert.rejects(runTwoArtifacts.readText(textRef), /outside the trusted run/);
  const forged = JSON.parse(textRef) as { runId: string; sessionId: string };
  forged.runId = 'run-2'; forged.sessionId = 'run-2-session';
  await assert.rejects(runTwoArtifacts.readText(JSON.stringify(forged)), /durable scoped bytes/);

  const nextGuard = plane.createSessionGuard({ runId: 'run-1', owner: 'astra', leaseId: 'orchestrator-2', expectedEpoch: 1, issuedAt: now, expiresAt: later });
  await nextGuard.authorizeStart?.({ driver: 'astra', runId: 'run-1', sessionId: 'helm:astra:replacement', mode: 'primary' });
  assert.throws(() => plane.admitOrchestrator(command(sessionId, 'stale-command'), { runId: 'run-1', sessionId, mode: 'primary' }, 'late-fable'), /current durable owner/);
  const takeover = await plane.snapshot('run-1');
  assert.equal(takeover.ownership?.epoch, 2);
  assert.equal((JSON.parse(takeover.artifacts.find((item) => item.ref === originalArtifactRef)!.ref) as { sessionId: string }).sessionId, sessionId);
  assert.equal((JSON.parse(takeover.recoveryRefs.find((ref) => ref === originalRecoveryRef)!) as { sessionId: string }).sessionId, sessionId);
  plane.close();
});

test('restart restores durable state and refuses a retry after an unobserved faux Pi effect', async () => {
  const effects: string[] = [];
  const interrupted: HostRuntime = {
    createEffect: async ({ command: input }): Promise<KernelEffect> => ({
      effectId: `interrupted:${input.commandId}`,
      execute: async () => { effects.push(input.commandId); throw new Error('fixture died after effect'); },
      observe: async () => ({ commandId: input.commandId, effectId: `interrupted:${input.commandId}`, state: 'succeeded', source: 'unreachable', observedAt: now, evidenceRefs: ['fixture:unreachable'] }),
    }),
  };
  const { plane, sessionId, directory } = await startedHost(interrupted);
  plane.admitOrchestrator(command(sessionId), { runId: 'run-1', sessionId, mode: 'primary' }, 'trusted-fable');
  assert.equal((await plane.perform('command-1', { executorId: 'faux-pi' }, '2026-09-15T00:10:00Z', async () => ({ value: true, state: 'known', source: 'fixture', observedAt: now }))).state, 'unknown');
  assert.deepEqual(effects, ['command-1']);
  plane.close();
  const restarted = await openHost({ stateDirectory: directory, kinds, now: () => now, runtime: interrupted });
  const recovered = await restarted.recover('run-1');
  assert.equal(recovered.commands[0]?.status, 'unknown');
  await assert.rejects(restarted.perform('command-1', { executorId: 'retry' }, '2026-09-15T00:20:00Z', async () => ({ value: true, state: 'known', source: 'fixture', observedAt: now })), /not claimable/);
  assert.deepEqual(effects, ['command-1']);
  restarted.close();
});

test('host guard delegates run, epoch, and active-time fencing to core', async () => {
  let clock = now;
  const plane = await openHost({ stateDirectory: stateDirectory(), kinds, now: () => clock, runtime: receiptFixture([]) });
  plane.recordHumanAuthority(grant()); plane.recordAutonomyLease(lease());
  const mutableAuthority = { runId: 'run-2', owner: 'fable' as const, leaseId: 'orchestrator-mutable', expectedEpoch: 0, issuedAt: now, expiresAt: later };
  const copiedGuard = plane.createSessionGuard(mutableAuthority);
  mutableAuthority.runId = 'caller-edited-run';
  await copiedGuard.authorizeStart?.({ driver: 'fable', runId: 'run-2', sessionId: 'copied-session', mode: 'primary' });
  await copiedGuard.assertCurrent({ runId: 'run-2', sessionId: 'copied-session', mode: 'primary' });
  const authority = { runId: 'run-1' as const, owner: 'fable' as const, leaseId: 'orchestrator-1', expectedEpoch: 0, issuedAt: now, expiresAt: later };
  const guard = plane.createSessionGuard(authority);
  await guard.authorizeStart?.({ driver: 'fable', runId: 'run-1', sessionId: 'same-session', mode: 'primary' });
  await assert.rejects(guard.assertCurrent({ runId: 'wrong-run', sessionId: 'same-session', mode: 'primary' }), /current durable owner/);
  plane.acquireOwnership({ runId: 'run-1', leaseId: 'orchestrator-2', owner: 'astra', sessionId: 'same-session', epoch: 2, issuedAt: now, expiresAt: later }, 1);
  await assert.rejects(guard.assertCurrent({ runId: 'run-1', sessionId: 'same-session', mode: 'primary' }), /stale/);
  const expiredGuard = plane.createSessionGuard({ runId: 'run-1', owner: 'fable', leaseId: 'orchestrator-3', expectedEpoch: 2, issuedAt: now, expiresAt: later });
  await expiredGuard.authorizeStart?.({ driver: 'fable', runId: 'run-1', sessionId: 'expired-session', mode: 'primary' });
  clock = later;
  await assert.rejects(expiredGuard.assertCurrent({ runId: 'run-1', sessionId: 'expired-session', mode: 'primary' }), /inactive/);
  plane.close();
});

test('recover(runId) leaves another run\'s active effect untouched', async () => {
  let unblock: (() => void) | undefined;
  let effectStarted: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { effectStarted = resolve; });
  const release = new Promise<void>((resolve) => { unblock = resolve; });
  const runtime: HostRuntime = { createEffect: async ({ command: input }) => ({
    effectId: `blocked:${input.commandId}`,
    execute: async () => { effectStarted!(); await release; },
    observe: async () => ({ commandId: input.commandId, effectId: `blocked:${input.commandId}`, state: 'succeeded', source: 'blocked-fixture', observedAt: now, evidenceRefs: ['blocked:receipt'] }),
  }) };
  const plane = await openHost({ stateDirectory: stateDirectory(), kinds, now: () => now, runtime });
  try {
    plane.recordHumanAuthority(grant()); plane.recordAutonomyLease(lease());
    plane.acquireOwnership({ runId: 'run-2', leaseId: 'orchestrator-run-2', owner: 'fable', sessionId: 'run-2-session', epoch: 1, issuedAt: now, expiresAt: later }, 0);
    const runTwo = { ...command('run-2-session', 'run-2-command'), runId: 'run-2', orchestratorLeaseId: 'orchestrator-run-2' };
    plane.admitOrchestrator(runTwo, { runId: 'run-2', sessionId: 'run-2-session', mode: 'primary' }, 'trusted-fable');
    const performing = plane.perform('run-2-command', { executorId: 'faux-pi' }, '2026-09-15T00:10:00Z', async () => ({ value: true, state: 'known', source: 'fixture', observedAt: now }));
    await entered;
    assert.equal((await plane.snapshot('run-2')).commands[0]?.status, 'effect_started');
    await plane.recover('run-1');
    assert.equal((await plane.snapshot('run-2')).commands[0]?.status, 'effect_started');
    unblock!(); await performing;
  } finally { plane.close(); }
});

type NativeFixtureCase = 'success' | 'provider-error' | 'timeout' | 'iterator-error';

async function runNativeFixture(testCase: NativeFixtureCase): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'helm3-host-native-pi-'));
  let plane: Awaited<ReturnType<typeof openHost>> | undefined;
  let manager: WorkspaceManager | undefined;
  try {
    const repo = join(root, 'repo'); await mkdir(repo); await exec('git', ['init', repo]);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const base = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    manager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
    const owner = { attemptId: 'native-attempt', generation: 1, expiresAt: '2099-01-01T00:00:00Z' };
    const workspace = await manager.create(repo, join(root, 'worker'), 'native-attempt', base, owner);
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const ai = await import('@earendil-works/pi-ai');
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
    const faux = ai.fauxProvider({ provider: 'host-native-faux', models: [{ id: 'offline' }] }); runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('host-native-faux', 'offline');
    if (testCase === 'iterator-error') runtime.streamSimple = (() => ({
      async *[Symbol.asyncIterator]() { throw new Error('provider-body-must-not-escape'); },
      result: async () => { throw new Error('provider-body-must-not-escape'); },
    })) as unknown as typeof runtime.streamSimple;
    const fauxModel = faux.getModel();
    const access = new BoundedPiAccess({ poolId: 'overnight-api-usd', provider: fauxModel.provider, model: fauxModel.id, api: fauxModel.api, baseUrl: fauxModel.baseUrl, authEnvironment: 'TEST_ONLY_NO_KEY',
      contextWindow: fauxModel.contextWindow, maxOutputTokens: 32, maxBilledOutputTokens: fauxModel.maxTokens, maxPacketBytes: 8_000, maxRequests: 1, maxToolCalls: 0, timeoutMs: testCase === 'timeout' ? 20 : 1_000,
      inputUsdPerMillion: 1, outputUsdPerMillion: 1, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 1 });
    const envelope = JSON.stringify({ status: 'succeeded', summary: 'done', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' });
    faux.setResponses([testCase === 'success' ? ai.fauxAssistantMessage(envelope)
      : testCase === 'provider-error' ? async () => { throw new Error('provider-body-must-not-escape'); }
        : async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return ai.fauxAssistantMessage('longtext'); }]);
    const payloadSchema = z.object({ effectId: z.string(), kind: z.enum(['model.request', 'workspace.write']) }).strict();
    const poolLimits = [{ poolId: 'overnight-api-usd', unit: 'usd', limit: 10 }];
    const commandForPiEffect = (effect: { effectId: string; kind: 'model.request' | 'workspace.write' }) => {
      const payload = { effectId: effect.effectId, kind: effect.kind };
      return { schemaVersion: 1, commandId: effect.effectId, kind: effect.kind === 'model.request' ? 'pi.model' : 'pi.write', idempotencyKey: effect.effectId, payloadHash: hash(payload), scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'untrusted-pi', runId: 'run-1', origin: 'worker', leaseId: 'autonomy-1', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] };
    };
    const observedSettlement = (effect: { effectId: string; kind: 'model.request' | 'workspace.write' }) => settlementForBoundedPiEffect(access, effect);
    const nativeRuntime = new PiNativeRuntime(createBoundedPiWorkerBinding({
      access,
      authority: () => plane!.piAuthority({ attemptId: 'native-attempt', actorId: 'trusted-pi', executorId: 'native-pi', commandForEffect: commandForPiEffect, observedSettlement }),
      workerFor: (input) => ({ commandId: input.commandId, attemptId: 'native-attempt', workspace, owner, workspaceManager: manager!, stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model: fauxModel }),
      prompt: () => 'Return the worker result JSON.', correction: () => 'Return valid worker result JSON.',
    }));
    plane = await openHost({ stateDirectory: join(root, 'host-state'), now: () => now, runtime: nativeRuntime, kinds: {
      'host.effect': { payloadSchema: z.object({ value: z.string() }).strict() },
      'pi.model': { payloadSchema, resourceRequest: (payload) => {
        const parsed = payloadSchema.parse(payload);
        const reservation = access.reservation(parsed.effectId);
        return { poolId: reservation.poolId, unit: reservation.unit, upperBound: reservation.upperBound, consumer: 'worker' as const };
      } },
      'pi.write': { payloadSchema },
    } });
    plane.recordHumanAuthority({ authorityId: 'human-1', repositoryId: 'repo-1', mapNodeIds: ['node-1'], allowedActions: ['host.effect', 'pi.model', 'pi.write'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits, protectedReserves: [] });
    plane.recordAutonomyLease({ ...lease(), allowedActions: ['host.effect', 'pi.model', 'pi.write'], poolLimits });
    plane.recordAttempt({ attemptId: 'native-attempt', mapNodeId: 'node-1', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'host-native-faux', capability: 'build', poolId: 'overnight-api-usd', workspace: workspace.root, baseSha: base, contextManifestHash: 'sha256:host-native-context', leaseId: 'autonomy-1', sessionIds: [], commandIds: [], startedAt: now, evidenceRefs: [], usageRefs: [], findingRefs: [] });
    plane.acquireOwnership({ runId: 'run-1', leaseId: 'orchestrator-1', owner: 'fable', sessionId: 'fable-host-session', epoch: 1, issuedAt: now, expiresAt: later }, 0);
    plane.admitOrchestrator(command('fable-host-session'), { runId: 'run-1', sessionId: 'fable-host-session', mode: 'primary' }, 'trusted-fable');
    const outcome = await plane.perform('command-1', { executorId: 'host-pi' }, '2026-09-15T00:10:00Z', async () => ({ value: true, state: 'known', source: 'fixture', observedAt: now }));
    assert.equal(outcome.state, testCase === 'success' ? 'succeeded' : 'unknown');
    assert.equal(faux.state.callCount, testCase === 'iterator-error' ? 0 : 1);
    const nativeSnapshot = await plane.snapshot('run-1');
    if (testCase === 'success') {
      assert.ok((nativeSnapshot.reservations[0]?.settledActual ?? 0) > 0, 'validated faux usage settles through the same host ledger');
    } else {
      assert.equal(nativeSnapshot.reservations[0]?.settledActual, undefined, 'unusable provider telemetry keeps the full reservation charged');
    }
    assert.equal(nativeSnapshot.attempts[0]?.attemptId, 'native-attempt');
    if (testCase === 'success') {
      assert.equal(nativeSnapshot.attemptLifecycles[0]?.state, 'active');
      await assert.rejects(plane.piAuthority({ attemptId: 'native-attempt', actorId: 'trusted-pi', executorId: 'native-pi', commandForEffect: commandForPiEffect, observedSettlement }).perform({ effectId: 'over-budget', kind: 'model.request', commandId: 'command-1' }, async () => undefined), /reservation is absent/);
      await assert.rejects(plane.piAuthority({ attemptId: 'native-attempt', actorId: 'trusted-pi', executorId: 'native-pi', commandForEffect: commandForPiEffect, observedSettlement }).perform({ effectId: 'unobserved-write', kind: 'workspace.write', commandId: 'command-1' }, async () => { throw new Error('worker lost its observation'); }), /not successfully observed/);
      await plane.piAuthority({ attemptId: 'native-attempt', actorId: 'trusted-pi', executorId: 'native-pi', commandForEffect: commandForPiEffect }).reportWorkerStop('command-1', 'unknown');
      assert.equal((await plane.snapshot('run-1')).attemptLifecycles[0]?.state, 'unknown');
    } else {
      assert.equal(nativeSnapshot.attemptLifecycles[0]?.state, 'unknown', 'the failed native session must not remain active after its provider stream has ended');
      assert.equal(nativeSnapshot.commands[0]?.observations[0]?.detail, 'Pi worker invocation failed');
      if (testCase === 'provider-error' || testCase === 'iterator-error') assert.ok(!JSON.stringify(nativeSnapshot).includes('provider-body-must-not-escape'));
    }
  } finally { plane?.close(); manager?.close(); await rm(root, { recursive: true, force: true }); }
}

test('PiNativeRuntime runs the packaged Pi faux provider through host resource enforcement', async () => runNativeFixture('success'));
test('PiNativeRuntime fails closed after a native Pi provider error and quarantines the attempt', async () => runNativeFixture('provider-error'));
test('PiNativeRuntime quarantines a partial stream timeout without issuing a second request', async () => runNativeFixture('timeout'));

test('PiNativeRuntime redacts thrown stream exceptions before Core observation', async () => runNativeFixture('iterator-error'));

async function nativeCompactionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'helm3-host-native-compaction-'));
  const journal = await ArtifactJournal.open({ root: join(root, 'journal') });
  let plane: Awaited<ReturnType<typeof openHost>> | undefined;
  let manager: WorkspaceManager | undefined;
  let worker: Awaited<ReturnType<ReturnType<typeof createBoundedPiWorkerBinding>['start']>> | undefined;
  let clock = now;
  try {
    const repo = join(root, 'repo'); await mkdir(repo); await exec('git', ['init', repo]);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README.md'), 'base\n'); await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
    const base = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
    manager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
    const owner = { attemptId: 'compact-attempt', generation: 1, expiresAt: '2099-01-01T00:00:00Z' };
    const workspace = await manager.create(repo, join(root, 'worker'), 'compact-attempt', base, owner);
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const ai = await import('@earendil-works/pi-ai');
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
    const faux = ai.fauxProvider({ provider: 'host-native-compact-faux', models: [{ id: 'offline' }] });
    runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('host-native-compact-faux', 'offline');
    const model = faux.getModel();
    const access = new BoundedPiAccess({ poolId: 'overnight-api-usd', provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, authEnvironment: 'TEST_ONLY_NO_KEY',
      contextWindow: model.contextWindow, maxOutputTokens: 32, maxBilledOutputTokens: model.maxTokens, maxPacketBytes: 200_000, maxRequests: 1, maxToolCalls: 0, timeoutMs: 1_000,
      inputUsdPerMillion: 1, outputUsdPerMillion: 1, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 1 });
    const modelPayload = z.object({ effectId: z.string(), kind: z.literal('model.request') }).strict();
    const compactPayload = z.object({ effectId: z.string(), commandId: z.string() }).strict();
    const piCommand = (effectId: string, kind: 'pi.model' | 'pi.compact', payload: unknown): Command => ({
      schemaVersion: 1, commandId: effectId, kind, idempotencyKey: effectId, payloadHash: hash(payload), scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'trusted-pi',
      runId: 'run-1', origin: 'worker', leaseId: 'autonomy-1', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [],
    });
    const binding = createBoundedPiWorkerBinding({
      access,
      authority: () => plane!.piAuthority({
        attemptId: 'compact-attempt', actorId: 'trusted-pi', executorId: 'native-pi',
        commandForEffect: (effect) => piCommand(effect.effectId, 'pi.model', { effectId: effect.effectId, kind: effect.kind }),
        compactCommandForEffect: (effect) => piCommand(effect.effectId, 'pi.compact', { effectId: effect.effectId, commandId: effect.commandId }),
        observedSettlement: (effect) => settlementForBoundedPiEffect(access, effect),
      }),
      workerFor: (input) => ({ commandId: input.commandId, attemptId: 'compact-attempt', workspace, owner, workspaceManager: manager!, stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model }),
      prompt: () => 'unused', correction: () => 'unused',
    });
    plane = await openHost({ stateDirectory: join(root, 'host-state'), now: () => clock, kinds: {
      'pi.model': { payloadSchema: modelPayload, resourceRequest: (payload) => {
        const parsed = modelPayload.parse(payload); const reservation = access.reservation(parsed.effectId);
        return { poolId: reservation.poolId, unit: reservation.unit, upperBound: reservation.upperBound, consumer: 'worker' as const };
      } },
      'pi.compact': { payloadSchema: compactPayload },
    } });
    const poolLimits = [{ poolId: 'overnight-api-usd', unit: 'usd' as const, limit: 10 }];
    plane.recordHumanAuthority({ authorityId: 'human-1', repositoryId: 'repo-1', mapNodeIds: ['node-1'], allowedActions: ['pi.model', 'pi.compact'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits, protectedReserves: [] });
    plane.recordAutonomyLease({ ...lease(), allowedActions: ['pi.model', 'pi.compact'], poolLimits });
    plane.recordAttempt({ attemptId: 'compact-attempt', mapNodeId: 'node-1', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: model.id, family: 'faux', provider: model.provider, capability: 'build', poolId: 'overnight-api-usd', workspace: workspace.root, baseSha: base, contextManifestHash: 'sha256:native-compact-context', leaseId: 'autonomy-1', sessionIds: [], commandIds: [], startedAt: now, evidenceRefs: [], usageRefs: [], findingRefs: [] });
    plane.acquireOwnership({ runId: 'run-1', leaseId: 'orchestrator-1', owner: 'fable', sessionId: 'fable-host-session', epoch: 1, issuedAt: now, expiresAt: later }, 0);
    worker = await binding.start({ command: command('fable-host-session', 'compact-parent-command'), journal, authority: binding.authority() });
    const artifact = async (sourceIdentity: string) => ({ sourceIdentity, raw: await journal.append({ source: 'host.native.compact.fixture', sourceIdentity, mediaType: 'application/json', bytes: Buffer.from('{}') }) });
    const checkpoint = async () => ({ objective: await artifact('objective'), acceptance: await artifact('acceptance'), brief: await artifact('brief'), map: await artifact('map'), decisions: [], handoffs: [await artifact('handoff')] });
    const seedCompactionContext = () => {
      const session = worker as unknown as { session: { sessionManager: { appendMessage(message: { role: 'user'; content: string; timestamp: number }): string } } };
      session.session.sessionManager.appendMessage({ role: 'user', content: 'context '.repeat(8_000), timestamp: Date.now() });
      session.session.sessionManager.appendMessage({ role: 'user', content: 'continued context '.repeat(8_000), timestamp: Date.now() });
    };
    const checkpointArtifactCount = async () => {
      const files = await readdir(join(root, 'journal', 'metadata'));
      const metadata = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(root, 'journal', 'metadata', file), 'utf8')) as { source: string }));
      return metadata.filter((entry) => entry.source === 'pi.checkpoint').length;
    };
    return { root, journal, plane, manager, worker, faux, ai, access, checkpoint, seedCompactionContext, checkpointArtifactCount, expire: () => { clock = later; }, async cleanup() { worker?.dispose(); manager?.close(); plane?.close(); await journal.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    worker?.dispose(); manager?.close(); plane?.close(); await journal.close(); await rm(root, { recursive: true, force: true }); throw error;
  }
}

test('manual Pi compaction binds a Core control command to one bounded native summary and durable checkpoint evidence', async () => {
  const fixture = await nativeCompactionFixture();
  try {
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage('summary')]);
    fixture.seedCompactionContext();
    const checkpoint = await fixture.checkpoint();
    const refs = await fixture.worker.manualCompact({ commandId: 'compact-command', effectId: 'compact-effect', checkpoint });
    assert.equal(fixture.faux.state.callCount, 1, 'the compact summary is the only provider request');
    assert.equal(refs.length, 2);
    const snapshot = await fixture.plane.snapshot('run-1');
    const control = snapshot.commands.find((entry) => entry.command.kind === 'pi.compact');
    const model = snapshot.commands.find((entry) => entry.command.kind === 'pi.model');
    assert.equal(control?.status, 'succeeded'); assert.equal(model?.status, 'succeeded');
    assert.deepEqual(control?.observations[0]?.evidenceRefs, refs.map((ref) => ref.ref), 'Core records the actual durable checkpoint and completion evidence, not a placeholder');
    assert.equal(snapshot.reservations.length, 1); assert.ok((snapshot.reservations[0]?.settledActual ?? 0) > 0, 'the one native summary settled its Core reservation');
    const outcome = JSON.parse((await fixture.journal.read(refs[1]!, 'pi-compaction:compact-attempt:compact-command')).toString());
    assert.deepEqual(outcome.checkpointRef, refs[0], 'compaction evidence links to the prepared immutable checkpoint');
  } finally { await fixture.cleanup(); }
});

test('a failed terminal compaction write leaves the admitted Core control command unknown', async () => {
  const fixture = await nativeCompactionFixture();
  const append = fixture.journal.append.bind(fixture.journal);
  try {
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage('summary')]);
    fixture.seedCompactionContext();
    fixture.journal.append = async (input) => {
      if (input.source === 'pi.compaction') throw new Error('fixture terminal evidence write failed');
      return append(input);
    };
    await assert.rejects(fixture.worker.manualCompact({ commandId: 'compact-write-failure', effectId: 'compact-write-failure-effect', checkpoint: await fixture.checkpoint() }), /not successfully observed: unknown/);
    fixture.journal.append = append;
    const control = (await fixture.plane.snapshot('run-1')).commands.find((entry) => entry.command.kind === 'pi.compact');
    assert.equal(control?.status, 'unknown', 'Core cannot report a successful control action without its terminal durable evidence');
  } finally { fixture.journal.append = append; await fixture.cleanup(); }
});

test('manual Pi compaction holds the worker operation slot across native summary and rejects concurrent run, reopen and compact calls', async () => {
  const fixture = await nativeCompactionFixture();
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    fixture.seedCompactionContext();
    fixture.faux.setResponses([async () => { entered(); await gate; return fixture.ai.fauxAssistantMessage('summary'); }]);
    const pending = fixture.worker.manualCompact({ commandId: 'compact-first', effectId: 'compact-first-effect', checkpoint: await fixture.checkpoint() });
    await started;
    await assert.rejects(fixture.worker.run('nope', 'nope'), /active invocation/);
    await assert.rejects(fixture.worker.reopen(), /active Pi session/);
    await assert.rejects(fixture.worker.manualCompact({ commandId: 'compact-second', effectId: 'compact-second-effect', checkpoint: await fixture.checkpoint() }), /idle owned worker/);
    assert.equal((await fixture.plane.snapshot('run-1')).commands.filter((entry) => entry.command.kind === 'pi.compact').length, 1);
    release(); await pending;
  } finally { release?.(); await fixture.cleanup(); }
});

test('manual Pi compaction refuses incomplete checkpoint evidence before Core admission or provider fetch', async () => {
  const fixture = await nativeCompactionFixture();
  try {
    const entry = await fixture.checkpoint();
    await assert.rejects(fixture.worker.manualCompact({ commandId: 'compact-refused', effectId: 'compact-refused-effect', checkpoint: { ...entry, handoffs: [] } }), /handoff/);
    assert.equal(fixture.faux.state.callCount, 0);
    assert.equal((await fixture.plane.snapshot('run-1')).commands.length, 0);
    assert.equal(await fixture.checkpointArtifactCount(), 0, 'invalid checkpoint input cannot be persisted before Core admission');
  } finally { await fixture.cleanup(); }
});

test('an expired manual Pi compaction binding admits neither control nor checkpoint and makes no provider fetch', async () => {
  const fixture = await nativeCompactionFixture();
  try {
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage('summary')]);
    fixture.expire();
    await assert.rejects(fixture.worker.manualCompact({ commandId: 'compact-expired', effectId: 'compact-expired-effect', checkpoint: await fixture.checkpoint() }), /inactive|expired|outside/);
    assert.equal(fixture.faux.state.callCount, 0);
    assert.equal((await fixture.plane.snapshot('run-1')).commands.length, 0);
    assert.equal(await fixture.checkpointArtifactCount(), 0, 'an expired Core control binding cannot persist a checkpoint');
  } finally { await fixture.cleanup(); }
});
