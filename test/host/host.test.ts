import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod/v3';
import { type Command } from '../../src/contracts/index.js';
import { type KernelEffect } from '../../src/core/index.js';
import { FauxPiRuntime, openHost, type HostRuntime } from '../../src/host/index.js';
import { HelmToolRegistry, FableDriver } from '../../src/runtime/orchestrator/index.js';

const now = '2026-09-15T00:00:00Z';
const later = '2026-09-15T01:00:00Z';
const kinds = { 'host.effect': { payloadSchema: z.object({ value: z.string() }).strict() } };
const hash = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

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
async function startedHost(runtime: HostRuntime = new FauxPiRuntime()) {
  const directory = stateDirectory();
  const plane = await openHost({ stateDirectory: directory, kinds, now: () => now, runtime });
  plane.recordHumanAuthority(grant());
  plane.recordAutonomyLease(lease());
  const guard = plane.createSessionGuard({ runId: 'run-1', owner: 'fable', leaseId: 'orchestrator-1', expectedEpoch: 0, issuedAt: now, expiresAt: later });
  const driver = new FableDriver(plane.artifacts, new HelmToolRegistry([]), guard, plane.recoveryState(), { env: {} });
  const started = await driver.start({ runId: 'run-1', contextRefs: [], mode: 'primary' });
  return { plane, driver, sessionId: started.sessionId, directory };
}

test('host binds driver-generated ownership before recovery capture and exposes durable snapshot/recovery artifacts', async () => {
  const runtime = new FauxPiRuntime();
  const { plane, driver, sessionId } = await startedHost(runtime);
  const before = await plane.snapshot('run-1');
  assert.equal(before.ownership?.sessionId, sessionId);
  assert.equal(before.ownership?.epoch, 1);

  const admitted = plane.admitOrchestrator(command(sessionId), { runId: 'run-1', sessionId, mode: 'primary' }, 'trusted-fable');
  assert.equal(admitted.command.actorId, 'trusted-fable');
  await plane.perform('command-1', { executorId: 'faux-pi' }, '2026-09-15T00:10:00Z', async () => ({ value: true, state: 'known', source: 'fixture', observedAt: now }));
  assert.deepEqual(runtime.effects, ['command-1']);

  const { bundleRef } = await driver.checkpoint({ sessionId });
  const bundle = await plane.artifacts.loadRecoveryBundle(bundleRef);
  assert.equal(bundle.sessionId, sessionId);
  const restored = await plane.recoveryState().restore(bundle.recoveryStateRef);
  assert.equal(JSON.parse(restored).ownership.sessionId, sessionId);
  const after = await plane.snapshot('run-1');
  assert.equal(after.commands[0]?.status, 'succeeded');
  assert.equal(after.autonomyLeases[0]?.leaseId, 'autonomy-1');
  assert.equal(after.artifacts.length, 1);
  assert.ok(after.recoveryRefs.length >= 2);

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
