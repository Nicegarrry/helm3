import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openKernel } from '../../src/core/index.js';
import { IntegrationEvidenceRegistry } from '../../src/integration/evidence.js';
import { integrationMergePayloadSchema } from '../../src/integration/index.js';
import { ArtifactJournal } from '../../src/journal/index.js';
import { runGate } from '../../src/verification/index.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createGitHubIntegrationGateway, mergeIntegration, prepareIntegration, type IntegrationFacts, type IntegrationGateway } from '../../src/integration/index.js';
import type { Command, Precondition } from '../../src/contracts/index.js';
import type { Claim, CommandRecord, EffectObservation, KernelEffect } from '../../src/core/index.js';

const at = new Date(Date.now() - 1000).toISOString();
const expires = new Date(Date.now() + 3600000).toISOString();
const head = 'a'.repeat(40), changed = 'b'.repeat(40);
const requirements = { mergeMethod: 'squash' as const, requiredChecks: [{ name: 'gate', appId: '1', source: 'check_run' as const, conclusion: 'success' as const }], acceptanceVersion: 'acceptance-v1', leaseRevision: 1, expiresAt: expires };
const receipt = { receiptId: 'trusted-receipt', pr: 8, head, acceptanceVersion: 'acceptance-v1', verdict: 'approved' as const, builder: { attemptId: 'builder-attempt', sessionId: 'builder-session', family: 'openai' }, reviewer: { attemptId: 'reviewer-attempt', sessionId: 'reviewer-session', family: 'anthropic' } };
function facts(overrides: Partial<IntegrationFacts> = {}): IntegrationFacts { return { repository: 'acme/helm', pr: 8, head, baseRef: 'main', baseHead: 'c'.repeat(40), state: 'OPEN', mergeable: 'MERGEABLE', checks: [{ source: 'check_run', name: 'gate', appId: '1', status: 'completed', conclusion: 'success' }], acceptanceEvidence: [{ ref: 'gate:8', head, acceptanceVersion: 'acceptance-v1' }], mergeCommit: null, targetHead: 'c'.repeat(40), targetContainsMerge: null, observedMergeMethod: null, reviewReceipts: [receipt], ...overrides }; }
function command(expectedHead = head): Command {
  return { schemaVersion: 1, commandId: 'merge-command', kind: 'integration.merge', idempotencyKey: 'merge:8', payloadHash: 'payload', scope: { repositoryId: 'acme/helm' }, actorId: 'owner', runId: 'run', origin: 'human', leaseId: 'lease', leaseRevision: 1, plannedAt: at, notAfter: expires, expected: [{ authority: 'github', subject: 'pr:8', version: expectedHead, predicate: 'fresh exact head facts' }], payload: { repository: 'acme/helm', pr: 8, expectedHead, expectedBaseRef: 'main', expectedBaseHead: 'c'.repeat(40), acceptanceEvidence: ['gate:8'], reviewReceiptIds: ['trusted-receipt'], ...requirements }, requiredEvidence: ['review:receipt'] };
}
function record(value = command()): CommandRecord { return { command: value, status: 'queued', immutableHash: `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`, observations: [] }; }
function kernel() {
  let claimed = 0;
  return { get claimed() { return claimed; }, claim: (): Claim => { claimed++; return { commandId: 'merge-command', executorId: 'host', token: 'claim', generation: 1, expiresAt: expires }; }, perform: async (id: string, _claim: Claim, _executor: unknown, read: (p: Precondition) => Promise<{ value: boolean | null; state: string }>, effect: KernelEffect): Promise<EffectObservation> => { const result = await read(command().expected[0]); if (result.state !== 'known' || result.value !== true) throw Error('kernel precondition refused'); try { await effect.execute(command()); } catch { return { commandId: id, effectId: effect.effectId, state: 'unknown', source: 'kernel', observedAt: new Date().toISOString(), evidenceRefs: ['kernel:effect-error'] }; } return effect.observe(command()); } };
}
function gateway(initial = facts()): { gateway: IntegrationGateway; state: IntegrationFacts; mergeCalls: number } {
  const result = { state: initial, mergeCalls: 0, gateway: undefined as unknown as IntegrationGateway };
  result.gateway = { read: async () => result.state, merge: async certificate => { result.mergeCalls++; if (certificate.expectedHead !== result.state.head) throw Error('CAS head changed'); result.state = { ...result.state, state: 'MERGED', mergeCommit: 'd'.repeat(40), targetHead: 'd'.repeat(40), targetContainsMerge: true, observedMergeMethod: certificate.mergeMethod }; } };
  return result;
}

test('prepare binds exact fresh green CI and a trusted independent receipt', async () => {
  const fixture = gateway(); const prepared = await prepareIntegration(fixture.gateway, 8, requirements, () => at);
  assert.equal(prepared.expectedHead, head); assert.equal(prepared.facts.reviewReceipts[0].reviewer.family, 'anthropic');
  await assert.rejects(prepareIntegration(gateway(facts({ checks: [] })).gateway, 8, requirements), /CI/);
  await assert.rejects(prepareIntegration(gateway(facts({ reviewReceipts: [{ ...receipt, reviewer: { ...receipt.reviewer, family: 'openai' } }] })).gateway, 8, requirements), /independent/);
});

test('Kernel claim owns a fresh exact-head merge, authority sees JSON.stringify hash, and success requires readback', async () => {
  const fixture = gateway(); const prepared = await prepareIntegration(fixture.gateway, 8, requirements); const host = kernel(); let observedHash = '';
  const result = await mergeIntegration(prepared, { kernel: host, command: record(), executor: { executorId: 'host' }, claimExpiresAt: expires, gateway: fixture.gateway, effectId: 'github-merge-8', assertIntegrationExecutor: async () => {}, assertAuthority: async (_command, immutableHash) => { observedHash = immutableHash; } });
  assert.equal(host.claimed, 1); assert.equal(fixture.mergeCalls, 1); assert.equal(result.state, 'succeeded'); assert.equal(observedHash, record().immutableHash);
});

test('a stale head, invalid immutable bytes, authority refusal, and ambiguous effect never merge or replay', async () => {
  const fixture = gateway(); const prepared = await prepareIntegration(fixture.gateway, 8, requirements); fixture.state = facts({ head: changed, acceptanceEvidence: [{ ref: 'gate:8', head: changed, acceptanceVersion: 'acceptance-v1' }], reviewReceipts: [{ ...receipt, head: changed }] }); const host = kernel();
  await assert.rejects(mergeIntegration(prepared, { kernel: host, command: record(), executor: { executorId: 'host' }, claimExpiresAt: expires, gateway: fixture.gateway, effectId: 'stale', assertIntegrationExecutor: async () => {}, assertAuthority: async () => {} }), /precondition/);
  assert.equal(fixture.mergeCalls, 0);
  const bad = record(); bad.immutableHash = 'sha256:not-the-command';
  await assert.rejects(mergeIntegration(prepared, { kernel: host, command: bad, executor: { executorId: 'host' }, claimExpiresAt: expires, gateway: gateway().gateway, effectId: 'bad', assertIntegrationExecutor: async () => {}, assertAuthority: async () => {} }), /immutable hash/);
  const denied = gateway();
  const refusedAtEffect = await mergeIntegration(prepared, { kernel: kernel(), command: record(), executor: { executorId: 'host' }, claimExpiresAt: expires, gateway: denied.gateway, effectId: 'denied', assertIntegrationExecutor: async () => {}, assertAuthority: async () => { throw Error('authority expired'); } });
  assert.equal(refusedAtEffect.state, 'unknown');
  assert.equal(denied.mergeCalls, 0);
  const ambiguous: IntegrationGateway = { read: async () => facts(), merge: async () => { /* request accepted but no conclusive changed state */ } };
  const uncertain = await mergeIntegration(prepared, { kernel: kernel(), command: record(), executor: { executorId: 'host' }, claimExpiresAt: expires, gateway: ambiguous, effectId: 'unknown', assertIntegrationExecutor: async () => {}, assertAuthority: async () => {} });
  assert.equal(uncertain.state, 'unknown');
});

test('GitHub gateway pins the REST merge compare-and-swap SHA and reads CI by exact SHA', async () => {
  const calls: string[][] = [];
  const transport = async (args: readonly string[]) => { calls.push([...args]); const path = args.find(a => a.startsWith('repos/')) ?? ''; if (path.endsWith('/pulls/8')) return { ok: true, stdout: JSON.stringify({ state: 'open', merged: false, mergeable_state: 'clean', head: { sha: head }, base: { ref: 'main', sha: 'c'.repeat(40) } }), stderr: '' }; if (path.includes('/check-runs')) return { ok: true, stdout: JSON.stringify({ total_count: 1, check_runs: [{ name: 'gate', app: { id: 1 }, status: 'completed', conclusion: 'success' }] }), stderr: '' }; if (path.includes('/status')) return { ok: true, stdout: JSON.stringify({ total_count: 0, statuses: [] }), stderr: '' }; if (path.includes('/git/ref/')) return { ok: true, stdout: JSON.stringify({ object: { sha: 'c'.repeat(40) } }), stderr: '' }; return { ok: true, stdout: JSON.stringify({ merged: true }), stderr: '' }; };
  const live = createGitHubIntegrationGateway({ repository: 'acme/helm', receipts: () => [receipt], acceptanceEvidence: () => [{ ref: 'gate:8', head, acceptanceVersion: 'acceptance-v1' }], transport, testOnlyAllowDirectMerge: true }); const observed = await live.read(8); await live.merge(command().payload as any);
  assert.equal(observed.state, 'OPEN');
  assert.ok(calls.some(call => call.some(arg => arg.startsWith(`repos/acme/helm/commits/${head}/check-runs?per_page=100`)))); assert.ok(calls.some(call => call.includes(`sha=${head}`) && call.includes('PUT')));
});

test('certificate expiry and changed acceptance version refuse before an effect', async () => {
  await assert.rejects(prepareIntegration(gateway().gateway, 8, { ...requirements, expiresAt: 'not-a-time' }), /invalid/);
  const fixture = gateway(); const prepared = await prepareIntegration(fixture.gateway, 8, requirements);
  fixture.state = facts({ acceptanceEvidence: [{ ref: 'gate:8', head, acceptanceVersion: 'acceptance-v2' }], reviewReceipts: [{ ...receipt, acceptanceVersion: 'acceptance-v2' }] });
  await assert.rejects(mergeIntegration(prepared, { kernel: kernel(), command: record(), executor: { executorId: 'host' }, claimExpiresAt: expires, gateway: fixture.gateway, effectId: 'version', assertIntegrationExecutor: async () => {}, assertAuthority: async () => {} }), /precondition/);
});

test('a target-only move and a callback-time CI mutation refuse before merge', async () => {
  await assert.rejects(prepareIntegration(gateway(facts({ targetHead: 'd'.repeat(40) })).gateway, 8, requirements), /target/);
  const fixture = gateway(); const prepared = await prepareIntegration(fixture.gateway, 8, requirements);
  const result = await mergeIntegration(prepared, { kernel: kernel(), command: record(), executor: { executorId: 'host' }, claimExpiresAt: expires, gateway: fixture.gateway, effectId: 'callback-mutation', assertAuthority: async () => { fixture.state = facts({ checks: [{ source: 'check_run', name: 'gate', appId: '1', status: 'completed', conclusion: 'failure' }] }); }, assertIntegrationExecutor: async () => {} });
  assert.equal(result.state, 'unknown'); assert.equal(fixture.mergeCalls, 0);
});

test('production direct REST merge refuses before transport', async () => {
  let calls = 0; const live = createGitHubIntegrationGateway({ repository: 'acme/helm', receipts: () => [receipt], acceptanceEvidence: () => [{ ref: 'gate:8', head, acceptanceVersion: 'acceptance-v1' }], transport: async () => { calls++; return { ok: true, stdout: '{}', stderr: '' }; } });
  await assert.rejects(live.merge(command().payload as any), /lacks atomic target-ref/); assert.equal(calls, 0);
});


test('real Core admission, claim and observation persist a single certified merge and refuse replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helm-integration-core-'));
  const databasePath = join(directory, 'kernel.sqlite');
  const opened = openKernel({ databasePath, kinds: { 'integration.merge': { payloadSchema: integrationMergePayloadSchema } }, now: () => at });
  try {
    opened.host.declareHumanAuthority({ authorityId: 'approval', repositoryId: 'acme/helm', mapNodeIds: ['node'], allowedActions: ['integration.merge'], expiresAt: expires, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
    opened.host.issueAutonomyLease({ leaseId: 'lease', revision: 1, issuedBy: 'human', parentAuthorityId: 'approval', scope: { repositoryId: 'acme/helm', mapNodeIds: ['node'] }, allowedActions: ['integration.merge'], issuedAt: at, expiresAt: expires, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
    const cmd = command();
    cmd.scope.mapNodeId = 'node';
    cmd.payloadHash = `sha256:${createHash('sha256').update(JSON.stringify(cmd.payload)).digest('hex')}`;
    opened.host.admit(cmd, { actorId: 'owner', allowedOrigins: ['human'] });
    const admitted = opened.kernel.getCommand(cmd.commandId)!;
    const fixture = gateway();
    const prepared = await prepareIntegration(fixture.gateway, 8, requirements);
    let checked = 0;
    const input = { kernel: opened.host, command: admitted, executor: { executorId: 'coordinator' }, claimExpiresAt: expires, gateway: fixture.gateway, effectId: 'merge-effect', assertAuthority: async (_cmd: Command, hash: string) => { assert.equal(hash, admitted.immutableHash); checked++; }, assertIntegrationExecutor: async (_cmd: Command, executor: { executorId: string }) => { assert.equal(executor.executorId, 'coordinator'); } };
    const observed = await mergeIntegration(prepared, input);
    assert.equal(observed.state, 'succeeded');
    assert.equal(checked, 1);
    assert.equal(fixture.mergeCalls, 1);
    assert.equal(fixture.state.observedMergeMethod, 'squash');
    assert.equal(opened.kernel.getCommand(cmd.commandId)?.status, 'succeeded');
    await assert.rejects(mergeIntegration(prepared, input), /not claimable/);
    assert.equal(fixture.mergeCalls, 1);
  } finally { opened.host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('registry preserves actual gate evidence and review provenance across reopen and refuses invalid claims', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helm-integration-registry-'));
  const workspace = join(directory, 'repo');
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const commit = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const journal = await ArtifactJournal.open({ root: join(directory, 'journal'), hostPolicy: { allowSensitiveWrites: true } });
  const path = join(directory, 'evidence.sqlite');
  let registry = new IntegrationEvidenceRegistry(path);
  try {
    const gate = await runGate({ gateId: 'machine', workspace, expectedHead: commit, checks: [{ name: 'oracle', executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }], journal, env: { PATH: process.env.PATH ?? '' }, assertAuthority: async () => {} });
    const trusted = { ...receipt, head: commit };
    registry.recordGate('gate:8', 8, 'acceptance-v1', gate.result);
    registry.recordReview(trusted);
    assert.throws(() => registry.recordGate('empty', 8, 'acceptance-v1', { ...gate.result, checks: [] }), /successful machine/);
    assert.throws(() => registry.recordReview({ ...trusted, receiptId: 'bad-family', reviewer: { ...trusted.reviewer, family: '' } }), /provenance/);
    assert.throws(() => registry.recordReview({ ...trusted, receiptId: 'self', reviewer: trusted.builder }), /provenance/);
    registry.close();
    registry = new IntegrationEvidenceRegistry(path);
    assert.deepEqual(registry.acceptanceEvidence(8, commit), [{ ref: 'gate:8', head: commit, acceptanceVersion: 'acceptance-v1' }]);
    assert.deepEqual(registry.reviewReceipts(8, commit), [trusted]);
    assert.deepEqual(registry.acceptanceEvidence(9, commit), []);
    assert.deepEqual(registry.reviewReceipts(8, changed), []);
    await assert.rejects(prepareIntegration(gateway(facts({ head: commit, acceptanceEvidence: registry.acceptanceEvidence(8, commit), reviewReceipts: registry.reviewReceipts(8, commit) })).gateway, 8, { ...requirements, acceptanceVersion: 'acceptance-v2' }), /acceptance version/);
  } finally { registry.close(); journal.close(); await rm(directory, { recursive: true, force: true }); }
});


test('merge success requires the certified method in observed readback', async () => {
  const fixture = gateway();
  const prepared = await prepareIntegration(fixture.gateway, 8, requirements);
  let actualMethod = '';
  const wrong: IntegrationGateway = { read: fixture.gateway.read, merge: async certificate => {
    actualMethod = certificate.mergeMethod;
    await fixture.gateway.merge(certificate);
    fixture.state = { ...fixture.state, observedMergeMethod: 'merge' };
  } };
  const result = await mergeIntegration(prepared, { kernel: kernel(), command: record(), executor: { executorId: 'host' }, claimExpiresAt: expires, gateway: wrong, effectId: 'wrong-method', assertIntegrationExecutor: async () => {}, assertAuthority: async () => {} });
  assert.equal(actualMethod, 'squash');
  assert.equal(result.state, 'unknown');
  assert.equal(fixture.mergeCalls, 1);
});
