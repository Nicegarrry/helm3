import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { z } from 'zod/v3';
import { type Command } from '../../src/contracts/index.js';
import { type KernelEffect } from '../../src/core/index.js';
import { openHost, PiNativeRuntime, type HostRuntime } from '../../src/host/index.js';
import { HelmToolRegistry, FableDriver } from '../../src/runtime/orchestrator/index.js';
import { PiNativeWorker } from '../../src/runtime/pi/index.js';
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
  plane.revokeAutonomyLease('autonomy-1');
  assert.equal((await plane.snapshot('run-1')).autonomyLeases[0]?.revoked, true);

  const scoped = plane.artifactsFor(context);
  const textRef = await scoped.writeText('host.test.context', 'only this session may read');
  await assert.rejects(scoped.loadRecoveryBundle(textRef), /wrong kind/);
  plane.acquireOwnership({ runId: 'run-2', leaseId: 'orchestrator-run-2', owner: 'fable', sessionId: 'run-2-session', epoch: 1, issuedAt: now, expiresAt: later }, 0);
  const runTwoArtifacts = plane.artifactsFor({ runId: 'run-2', sessionId: 'run-2-session', mode: 'primary' });
  await assert.rejects(runTwoArtifacts.readText(textRef), /outside the trusted run/);
  const forged = JSON.parse(textRef) as { runId: string; sessionId: string };
  forged.runId = 'run-2'; forged.sessionId = 'run-2-session';
  await assert.rejects(runTwoArtifacts.readText(JSON.stringify(forged)), /durable scoped bytes/);

  const nextGuard = plane.createSessionGuard({ runId: 'run-1', owner: 'astra', leaseId: 'orchestrator-2', expectedEpoch: 1, issuedAt: now, expiresAt: later });
  await nextGuard.authorizeStart?.({ driver: 'astra', runId: 'run-1', sessionId: 'helm:astra:replacement', mode: 'primary' });
  assert.throws(() => plane.admitOrchestrator(command(sessionId, 'stale-command'), { runId: 'run-1', sessionId, mode: 'primary' }, 'late-fable'), /current durable owner/);
  assert.equal((await plane.snapshot('run-1')).ownership?.epoch, 2);
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

test('PiNativeRuntime runs the packaged Pi faux provider through host resource enforcement', async () => {
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
    faux.setResponses([ai.fauxAssistantMessage(JSON.stringify({ status: 'succeeded', summary: 'done', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' }))]);
    const payloadSchema = z.object({ effectId: z.string(), kind: z.enum(['model.request', 'workspace.write']) }).strict();
    const poolLimits = [{ poolId: 'offline-requests', unit: 'requests', limit: 1 }];
    const commandForPiEffect = (effect: { effectId: string; kind: 'model.request' | 'workspace.write' }) => {
      const payload = { effectId: effect.effectId, kind: effect.kind };
      return { schemaVersion: 1, commandId: effect.effectId, kind: effect.kind === 'model.request' ? 'pi.model' : 'pi.write', idempotencyKey: effect.effectId, payloadHash: hash(payload), scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'untrusted-pi', runId: 'run-1', origin: 'worker', leaseId: 'autonomy-1', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] };
    };
    const nativeRuntime = new PiNativeRuntime({
      authority: () => plane!.piAuthority({ attemptId: 'native-attempt', actorId: 'trusted-pi', executorId: 'native-pi', commandForEffect: commandForPiEffect }),
      start: async ({ command: input, journal, authority }) => PiNativeWorker.start({ commandId: input.commandId, attemptId: 'native-attempt', workspace, owner, workspaceManager: manager!, authority, journal, stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model: faux.getModel() }),
      prompt: () => 'Return the worker result JSON.', correction: () => 'Return valid worker result JSON.',
    });
    plane = await openHost({ stateDirectory: join(root, 'host-state'), now: () => now, runtime: nativeRuntime, kinds: {
      'host.effect': { payloadSchema: z.object({ value: z.string() }).strict() },
      'pi.model': { payloadSchema, resourceRequest: () => ({ poolId: 'offline-requests', unit: 'requests', upperBound: 1, consumer: 'worker' as const }) },
      'pi.write': { payloadSchema },
    } });
    plane.recordHumanAuthority({ authorityId: 'human-1', repositoryId: 'repo-1', mapNodeIds: ['node-1'], allowedActions: ['host.effect', 'pi.model', 'pi.write'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits, protectedReserves: [] });
    plane.recordAutonomyLease({ ...lease(), allowedActions: ['host.effect', 'pi.model', 'pi.write'], poolLimits });
    plane.recordAttempt({ attemptId: 'native-attempt', mapNodeId: 'node-1', mapNodeRevision: '1', objectiveVersion: '1', acceptanceVersion: '1', role: 'builder', model: 'offline', family: 'faux', provider: 'host-native-faux', capability: 'build', poolId: 'offline-requests', workspace: workspace.root, baseSha: base, contextManifestHash: 'sha256:host-native-context', leaseId: 'autonomy-1', sessionIds: [], commandIds: [], startedAt: now, evidenceRefs: [], usageRefs: [], findingRefs: [] });
    plane.acquireOwnership({ runId: 'run-1', leaseId: 'orchestrator-1', owner: 'fable', sessionId: 'fable-host-session', epoch: 1, issuedAt: now, expiresAt: later }, 0);
    plane.admitOrchestrator(command('fable-host-session'), { runId: 'run-1', sessionId: 'fable-host-session', mode: 'primary' }, 'trusted-fable');
    assert.equal((await plane.perform('command-1', { executorId: 'host-pi' }, '2026-09-15T00:10:00Z', async () => ({ value: true, state: 'known', source: 'fixture', observedAt: now }))).state, 'succeeded');
    assert.equal(faux.state.callCount, 1);
    const nativeSnapshot = await plane.snapshot('run-1');
    assert.equal(nativeSnapshot.reservations[0]?.settledActual, 1);
    assert.equal(nativeSnapshot.attempts[0]?.attemptId, 'native-attempt');
    await assert.rejects(plane.piAuthority({ attemptId: 'native-attempt', actorId: 'trusted-pi', executorId: 'native-pi', commandForEffect: commandForPiEffect }).perform({ effectId: 'over-budget', kind: 'model.request', commandId: 'command-1' }, async () => undefined), /cap|budget/);
  } finally { plane?.close(); manager?.close(); await rm(root, { recursive: true, force: true }); }
});
