import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import type { Command } from '../../src/contracts/index.js';
import type { EffectObservation, KernelEffect, TrustedExecutor } from '../../src/core/index.js';
import { HostArtifactStore, openHost } from '../../src/host/index.js';
import { appendHostGateTool, createHostGateTool, gateConfigDigest, gateRunPayloadSchema, type GateToolHost, type RegisteredGate } from '../../src/host/gate-tools.js';
import { ArtifactJournal } from '../../src/journal/index.js';
import { HelmToolRegistry, type HelmToolExecutionContext } from '../../src/runtime/orchestrator/index.js';

const exec = promisify(execFile);
const now = '2026-09-16T00:00:00.000Z';
const later = '2026-09-16T01:00:00.000Z';
const context = { runId: 'gate-run', sessionId: 'gate-session', mode: 'primary' as const };
const executor: TrustedExecutor = { executorId: 'gate-host' };

function configuredGate(input: RegisteredGate): RegisteredGate { return input; }

async function repository(root: string) {
  const workspace = join(root, 'workspace'); await mkdir(workspace, { recursive: true });
  await exec('git', ['init', workspace]); await exec('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.invalid']); await exec('git', ['-C', workspace, 'config', 'user.name', 'Helm fixture']);
  await writeFile(join(workspace, 'README.md'), 'gate fixture\n'); await exec('git', ['-C', workspace, 'add', '.']); await exec('git', ['-C', workspace, 'commit', '-m', 'fixture']);
  return { workspace, head: (await exec('git', ['-C', workspace, 'rev-parse', 'HEAD'])).stdout.trim() };
}

async function fixture(check: readonly string[] = ['process.exit(0)']) {
  const root = mkdtempSync(join(tmpdir(), 'helm3-gate-tools-')); const repo = await repository(root);
  const journal = await ArtifactJournal.open({ root: join(root, 'journal'), hostPolicy: { allowSensitiveWrites: true } });
  const artifacts = new HostArtifactStore(journal, () => context);
  let admitted: Command | undefined; let admissionError: Error | undefined; let forceUnknown = false; let journalFailure = false;
  const originalJournal = artifacts.journalForTrustedPi.bind(artifacts);
  (artifacts as unknown as { journalForTrustedPi(): ArtifactJournal }).journalForTrustedPi = () => journalFailure
    ? ({ async append() { throw new Error('synthetic journal failure'); } } as unknown as ArtifactJournal)
    : originalJournal();
  const target = configuredGate({
    gateId: 'fixture.gate', workerId: 'fixture-worker', repositoryId: 'fixture-repository', mapNodeId: 'fixture-node', workspaceId: 'fixture-workspace', workspace: repo.workspace,
    expectedHead: repo.head, acceptanceVersion: 'acceptance-v1',
    checks: [{ name: 'fixture check', executable: process.execPath, args: ['-e', check.join(';')], timeoutMs: 5000 }], environment: { PATH: process.env.PATH ?? '' },
  });
  const host: GateToolHost = {
    artifactsFor: () => artifacts,
    admitOrchestrator(intent) { if (admissionError) throw admissionError; admitted = intent as Command; return { command: admitted }; },
    assertEffectAuthority() {},
    async performAdmitted(commandId, _executor, _expires, readFact, effect) {
      const fact = await readFact(admitted!.expected[0]!);
      if (fact.state !== 'known' || fact.value !== true) return { commandId, effectId: effect.effectId, state: 'unknown', source: 'fixture-host', observedAt: now, evidenceRefs: ['fixture:precondition'] };
      try { await effect.execute(admitted!); }
      catch { return { commandId, effectId: effect.effectId, state: 'unknown', source: 'fixture-host', observedAt: now, evidenceRefs: ['fixture:effect-error'] }; }
      if (forceUnknown) return { commandId, effectId: effect.effectId, state: 'unknown', source: 'fixture-host', observedAt: now, evidenceRefs: ['fixture:forced-unknown'] };
      return effect.observe(admitted!);
    },
  };
  const options: Parameters<typeof createHostGateTool>[0] = {
    context, authorize: async (actual) => { if (actual.sessionId !== context.sessionId) throw new Error('stale'); }, host,
    catalog: { async resolve(gateId, workerId) { if (gateId !== target.gateId || workerId !== target.workerId) throw new Error('missing'); return target; } },
    command: { actorId: 'fixture-fable', leaseId: 'fixture-autonomy', leaseRevision: 1, orchestratorLeaseId: 'fixture-owner', orchestratorEpoch: 1, plannedAt: () => now, notAfter: () => later, commandId: () => 'fixture-gate-command' },
    executor, claimExpiresAt: () => later,
  };
  const tool = createHostGateTool(options);
  return { root, journal, tool, options, target, get admitted() { return admitted; }, expire: () => { admissionError = new Error('expired lease'); }, stale: () => { admissionError = new Error('stale epoch'); }, unknown: () => { forceUnknown = true; }, failEvidence: () => { journalFailure = true; } };
}

test('gate.run binds a host-registered gate to exact head, checks, and raw evidence', async () => {
  const value = await fixture();
  try {
    const result = await value.tool.execute({ gateId: value.target.gateId, workerId: value.target.workerId, expectedHead: value.target.expectedHead }, context);
    assert.equal(result.state, 'succeeded');
    assert.equal((result as { value: { gateState: string } }).value.gateState, 'succeeded');
    assert.equal(value.admitted?.kind, 'gate.run');
    const workspace = await realpath(value.target.workspace);
    const digest = gateConfigDigest({ ...value.target, workspace });
    const workspaceDigest = `sha256:${createHash('sha256').update(workspace).digest('hex')}`;
    assert.deepEqual(value.admitted?.payload, { gateId: 'fixture.gate', workerId: 'fixture-worker', workspaceId: 'fixture-workspace', workspaceDigest, expectedHead: value.target.expectedHead, acceptanceVersion: 'acceptance-v1', gateConfigDigest: digest, trustedDefinitionRef: `gate-definition:${digest}` });
    assert.deepEqual(value.admitted?.expected, [{ authority: 'git', subject: 'fixture-workspace', version: value.target.expectedHead, predicate: 'registered workspace is clean at the exact expected head' }]);
    const metadata = await value.journal.metadata(); assert.deepEqual(new Set(metadata.map((entry) => entry.source)), new Set(['helm.gate.started', 'helm.gate.check', 'helm.gate.completed']));
  } finally { value.journal.close(); await rm(value.root, { recursive: true, force: true }); }
});

test('a red gate is an evidence-bearing result, while head changes, expired leases, and stale epochs are refused or unknown', async () => {
  const red = await fixture(['process.exit(7)']); const changed = await fixture(); const expired = await fixture(); const stale = await fixture();
  try {
    const redResult = await red.tool.execute({ gateId: red.target.gateId, workerId: red.target.workerId, expectedHead: red.target.expectedHead }, context);
    assert.deepEqual((redResult as { value: { gateState: string } }).value.gateState, 'failed');
    await writeFile(join(changed.root, 'workspace', 'README.md'), 'changed\n');
    assert.equal((await changed.tool.execute({ gateId: changed.target.gateId, workerId: changed.target.workerId, expectedHead: changed.target.expectedHead }, context)).state, 'unknown');
    expired.expire(); assert.equal((await expired.tool.execute({ gateId: expired.target.gateId, workerId: expired.target.workerId, expectedHead: expired.target.expectedHead }, context)).state, 'refused');
    stale.stale(); assert.equal((await stale.tool.execute({ gateId: stale.target.gateId, workerId: stale.target.workerId, expectedHead: stale.target.expectedHead }, context)).state, 'refused');
  } finally { for (const value of [red, changed, expired, stale]) { value.journal.close(); await rm(value.root, { recursive: true, force: true }); } }
});

test('gate.run refuses arbitrary command/path/config input, reports evidence-write failure as unknown, and preserves the shared registry', async () => {
  const value = await fixture(); const evidenceFailure = await fixture();
  try {
    const invalid = await value.tool.execute({ gateId: value.target.gateId, workerId: value.target.workerId, expectedHead: value.target.expectedHead, command: 'rm -rf /', workspace: '/tmp', budget: 0 }, context);
    assert.equal(invalid.state, 'refused');
    evidenceFailure.failEvidence();
    assert.equal((await evidenceFailure.tool.execute({ gateId: evidenceFailure.target.gateId, workerId: evidenceFailure.target.workerId, expectedHead: evidenceFailure.target.expectedHead }, context)).state, 'unknown');
    const tampered = createHostGateTool({ ...value.options, catalog: { async resolve() { return { ...value.target, checks: [{ ...value.target.checks[0]!, args: ['-e', 'process.exit(7)'] }] }; } } });
    // The independently resolved definition is valid at plan time; mutation
    // after admission is separately rejected by the at-effect reread below.
    assert.equal((await tampered.execute({ gateId: value.target.gateId, workerId: value.target.workerId, expectedHead: value.target.expectedHead }, context)).state, 'succeeded');
    const marker = 'synthetic-host-detail-must-not-escape';
    const throwing = createHostGateTool({ ...value.options, host: { ...value.options.host, async performAdmitted() { throw new Error(marker); } } });
    const thrown = await throwing.execute({ gateId: value.target.gateId, workerId: value.target.workerId, expectedHead: value.target.expectedHead }, context);
    assert.deepEqual(thrown, { state: 'unknown', reason: 'gate effect outcome is unavailable' }); assert.ok(!JSON.stringify(thrown).includes(marker));
    const base = new HelmToolRegistry([{ name: 'brief.get', description: 'fixture', input: {}, execute: async () => ({ state: 'succeeded', value: {} }) }]);
    const registry = appendHostGateTool(base, value.options);
    assert.deepEqual(registry.all().map((entry) => entry.name), ['brief.get', 'gate.run']);
  } finally { for (const item of [value, evidenceFailure]) { item.journal.close(); await rm(item.root, { recursive: true, force: true }); } }
});

test('a mutable catalog definition is re-read at effect time and cannot replace the planned checks', async () => {
  const value = await fixture(); let calls = 0;
  try {
    const tool = createHostGateTool({ ...value.options, catalog: { async resolve() {
      calls++;
      return calls === 1 ? value.target : { ...value.target, checks: [{ ...value.target.checks[0]!, args: ['-e', 'process.exit(7)'] }] };
    } } });
    assert.equal((await tool.execute({ gateId: value.target.gateId, workerId: value.target.workerId, expectedHead: value.target.expectedHead }, context)).state, 'unknown');
    assert.equal(calls, 2);
  } finally { value.journal.close(); await rm(value.root, { recursive: true, force: true }); }
});

test('gate.run traverses the real Host Core admission, current-owner fence, claim, and exact-head evidence path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm3-gate-core-')); const repo = await repository(root); let plane: Awaited<ReturnType<typeof openHost>> | undefined;
  try {
    let clock = now;
    plane = await openHost({ stateDirectory: join(root, 'host'), now: () => clock, kinds: { 'gate.run': { payloadSchema: gateRunPayloadSchema } } });
    plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['gate.run'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
    plane.recordAutonomyLease({ leaseId: 'autonomy', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['gate.run'], issuedAt: now, expiresAt: '2026-09-16T00:30:00.000Z', maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
    plane.acquireOwnership({ runId: context.runId, leaseId: 'owner', owner: 'fable', sessionId: context.sessionId, epoch: 1, issuedAt: now, expiresAt: later }, 0);
    const target = configuredGate({
      gateId: 'core.gate', workerId: 'core-worker', repositoryId: 'repo', mapNodeId: 'node', workspaceId: 'core-workspace', workspace: repo.workspace, expectedHead: repo.head,
      acceptanceVersion: 'v1', checks: [{ name: 'green', executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }], environment: { PATH: process.env.PATH ?? '' },
    });
    const tool = createHostGateTool({ context, authorize: async (actual) => { plane!.artifactsFor(actual); }, host: plane, catalog: { async resolve() { return target; } },
      command: { actorId: 'fable', leaseId: 'autonomy', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: () => now, notAfter: () => later, commandId: () => 'core-gate-command' }, executor, claimExpiresAt: () => later });
    const result = await tool.execute({ gateId: target.gateId, workerId: target.workerId, expectedHead: target.expectedHead }, context);
    assert.equal(result.state, 'succeeded');
    const snapshot = await plane.snapshot(context.runId); const command = snapshot.commands.find((entry) => entry.command.commandId === 'core-gate-command');
    assert.equal(command?.status, 'succeeded'); assert.equal(command?.observations[0]?.state, 'succeeded'); assert.equal(command?.observations[0]?.evidenceRefs.length, 2);
    const marker = join(root, 'second-check-marker'); const midTarget = configuredGate({ ...target, acceptanceVersion: 'v2', checks: [
      { name: 'first', executable: process.execPath, args: ['-e', 'require("node:fs").appendFileSync(process.env.MARKER, "x")'], timeoutMs: 5000 },
      { name: 'second', executable: process.execPath, args: ['-e', 'require("node:fs").appendFileSync(process.env.MARKER, "y")'], timeoutMs: 5000 },
    ], environment: { PATH: process.env.PATH ?? '', MARKER: marker } });
    let guards = 0; const originalGuard = plane.assertEffectAuthority.bind(plane);
    (plane as unknown as { assertEffectAuthority(commandId: string, value: HelmToolExecutionContext): void }).assertEffectAuthority = (commandId, value) => {
      guards++; if (guards === 4) clock = '2026-09-16T00:45:00.000Z'; originalGuard(commandId, value);
    };
    const midExpiry = createHostGateTool({ context, authorize: async (actual) => { plane!.artifactsFor(actual); }, host: plane, catalog: { async resolve() { return midTarget; } },
      command: { actorId: 'fable', leaseId: 'autonomy', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: () => now, notAfter: () => later, commandId: () => 'mid-expiry-gate-command' }, executor, claimExpiresAt: () => later });
    assert.equal((await midExpiry.execute({ gateId: midTarget.gateId, workerId: midTarget.workerId, expectedHead: midTarget.expectedHead }, context)).state, 'unknown');
    assert.equal(await readFile(marker, 'utf8'), 'x');
    clock = now;
    const stale = createHostGateTool({ context, authorize: async (actual) => { plane!.artifactsFor(actual); }, host: plane, catalog: { async resolve() { return target; } },
      command: { actorId: 'fable', leaseId: 'autonomy', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 2, plannedAt: () => now, notAfter: () => later, commandId: () => 'stale-gate-command' }, executor, claimExpiresAt: () => later });
    assert.equal((await stale.execute({ gateId: target.gateId, workerId: target.workerId, expectedHead: target.expectedHead }, context)).state, 'refused');
    clock = '2026-09-16T00:45:00.000Z';
    const expiredTarget = configuredGate({ ...target, acceptanceVersion: 'v2' });
    const expired = createHostGateTool({ context, authorize: async (actual) => { plane!.artifactsFor(actual); }, host: plane, catalog: { async resolve() { return expiredTarget; } },
      command: { actorId: 'fable', leaseId: 'autonomy', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: () => now, notAfter: () => later, commandId: () => 'expired-gate-command' }, executor, claimExpiresAt: () => later });
    assert.equal((await expired.execute({ gateId: target.gateId, workerId: target.workerId, expectedHead: target.expectedHead }, context)).state, 'refused');
  } finally { plane?.close(); await rm(root, { recursive: true, force: true }); }
});
