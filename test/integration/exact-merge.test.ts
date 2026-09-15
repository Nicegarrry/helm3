import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGitHubIntegrationGateway, mergeIntegration, prepareIntegration, type IntegrationFacts, type IntegrationGateway } from '../../src/integration/index.js';
import type { Command, Precondition } from '../../src/contracts/index.js';
import type { Claim, CommandRecord, EffectObservation, KernelEffect } from '../../src/core/index.js';

const head = 'a'.repeat(40), changed = 'b'.repeat(40);
const receipt = { receiptId: 'trusted-receipt', pr: 8, head, verdict: 'approved' as const, builder: { attemptId: 'builder-attempt', sessionId: 'builder-session', family: 'openai' }, reviewer: { attemptId: 'reviewer-attempt', sessionId: 'reviewer-session', family: 'anthropic' } };
function facts(overrides: Partial<IntegrationFacts> = {}): IntegrationFacts { return { repository: 'acme/helm', pr: 8, head, baseRef: 'main', baseHead: 'c'.repeat(40), state: 'OPEN', mergeable: 'MERGEABLE', checks: [{ source: 'check_run', status: 'completed', conclusion: 'success' }], acceptanceEvidence: [{ ref: 'gate:8', head }], mergeCommit: null, targetHead: 'c'.repeat(40), targetContainsMerge: null, reviewReceipts: [receipt], ...overrides }; }
function command(expectedHead = head): Command {
  return { schemaVersion: 1, commandId: 'merge-command', kind: 'integration.merge', idempotencyKey: 'merge:8', payloadHash: 'payload', scope: { repositoryId: 'acme/helm' }, actorId: 'owner', runId: 'run', origin: 'human', leaseId: 'lease', leaseRevision: 1, plannedAt: '2026-09-15T00:00:00.000Z', notAfter: '2026-09-16T00:00:00.000Z', expected: [{ authority: 'github', subject: 'pr:8', version: expectedHead, predicate: 'fresh exact head facts' }], payload: { repository: 'acme/helm', pr: 8, expectedHead, expectedBaseRef: 'main', expectedBaseHead: 'c'.repeat(40), acceptanceEvidence: ['gate:8'], reviewReceiptIds: ['trusted-receipt'] }, requiredEvidence: ['review:receipt'] };
}
function record(value = command()): CommandRecord { return { command: value, status: 'queued', immutableHash: `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`, observations: [] }; }
function kernel() {
  let claimed = 0;
  return { get claimed() { return claimed; }, claim: (): Claim => { claimed++; return { commandId: 'merge-command', executorId: 'host', token: 'claim', generation: 1, expiresAt: '2026-09-15T01:00:00.000Z' }; }, perform: async (id: string, _claim: Claim, _executor: unknown, read: (p: Precondition) => Promise<{ value: boolean | null; state: string }>, effect: KernelEffect): Promise<EffectObservation> => { const result = await read(command().expected[0]); if (result.state !== 'known' || result.value !== true) throw Error('kernel precondition refused'); try { await effect.execute(command()); } catch { return { commandId: id, effectId: effect.effectId, state: 'unknown', source: 'kernel', observedAt: new Date().toISOString(), evidenceRefs: ['kernel:effect-error'] }; } return effect.observe(command()); } };
}
function gateway(initial = facts()): { gateway: IntegrationGateway; state: IntegrationFacts; mergeCalls: number } {
  const result = { state: initial, mergeCalls: 0, gateway: undefined as unknown as IntegrationGateway };
  result.gateway = { read: async () => result.state, merge: async (_pr, expected) => { result.mergeCalls++; if (expected !== result.state.head) throw Error('CAS head changed'); result.state = { ...result.state, state: 'MERGED', mergeCommit: 'd'.repeat(40), targetHead: 'd'.repeat(40), targetContainsMerge: true }; } };
  return result;
}

test('prepare binds exact fresh green CI and a trusted independent receipt', async () => {
  const fixture = gateway(); const prepared = await prepareIntegration(fixture.gateway, 8, () => '2026-09-15T00:00:00.000Z');
  assert.equal(prepared.expectedHead, head); assert.equal(prepared.facts.reviewReceipts[0].reviewer.family, 'anthropic');
  await assert.rejects(prepareIntegration(gateway(facts({ checks: [] })).gateway, 8), /CI/);
  await assert.rejects(prepareIntegration(gateway(facts({ reviewReceipts: [{ ...receipt, reviewer: { ...receipt.reviewer, family: 'openai' } }] })).gateway, 8), /independent/);
});

test('Kernel claim owns a fresh exact-head merge, authority sees JSON.stringify hash, and success requires readback', async () => {
  const fixture = gateway(); const prepared = await prepareIntegration(fixture.gateway, 8); const host = kernel(); let observedHash = '';
  const result = await mergeIntegration(prepared, { kernel: host, command: record(), executor: { executorId: 'host' }, claimExpiresAt: '2026-09-15T01:00:00.000Z', gateway: fixture.gateway, effectId: 'github-merge-8', assertIntegrationExecutor: async () => {}, assertAuthority: async (_command, immutableHash) => { observedHash = immutableHash; } });
  assert.equal(host.claimed, 1); assert.equal(fixture.mergeCalls, 1); assert.equal(result.state, 'succeeded'); assert.equal(observedHash, record().immutableHash);
});

test('a stale head, invalid immutable bytes, authority refusal, and ambiguous effect never merge or replay', async () => {
  const fixture = gateway(); const prepared = await prepareIntegration(fixture.gateway, 8); fixture.state = facts({ head: changed, reviewReceipts: [{ ...receipt, head: changed }] }); const host = kernel();
  await assert.rejects(mergeIntegration(prepared, { kernel: host, command: record(), executor: { executorId: 'host' }, claimExpiresAt: '2026-09-15T01:00:00.000Z', gateway: fixture.gateway, effectId: 'stale', assertIntegrationExecutor: async () => {}, assertAuthority: async () => {} }), /precondition/);
  assert.equal(fixture.mergeCalls, 0);
  const bad = record(); bad.immutableHash = 'sha256:not-the-command';
  await assert.rejects(mergeIntegration(prepared, { kernel: host, command: bad, executor: { executorId: 'host' }, claimExpiresAt: '2026-09-15T01:00:00.000Z', gateway: gateway().gateway, effectId: 'bad', assertIntegrationExecutor: async () => {}, assertAuthority: async () => {} }), /immutable hash/);
  const denied = gateway();
  const refusedAtEffect = await mergeIntegration(prepared, { kernel: kernel(), command: record(), executor: { executorId: 'host' }, claimExpiresAt: '2026-09-15T01:00:00.000Z', gateway: denied.gateway, effectId: 'denied', assertIntegrationExecutor: async () => {}, assertAuthority: async () => { throw Error('authority expired'); } });
  assert.equal(refusedAtEffect.state, 'unknown');
  assert.equal(denied.mergeCalls, 0);
  const ambiguous: IntegrationGateway = { read: async () => facts(), merge: async () => { /* request accepted but no conclusive changed state */ } };
  const uncertain = await mergeIntegration(prepared, { kernel: kernel(), command: record(), executor: { executorId: 'host' }, claimExpiresAt: '2026-09-15T01:00:00.000Z', gateway: ambiguous, effectId: 'unknown', assertIntegrationExecutor: async () => {}, assertAuthority: async () => {} });
  assert.equal(uncertain.state, 'unknown');
});

test('GitHub gateway pins the REST merge compare-and-swap SHA and reads CI by exact SHA', async () => {
  const calls: string[][] = [];
  const transport = async (args: readonly string[]) => { calls.push([...args]); const path = args.find(a => a.startsWith('repos/')) ?? ''; if (path.endsWith('/pulls/8')) return { ok: true, stdout: JSON.stringify({ state: 'open', merged: false, mergeable_state: 'clean', head: { sha: head }, base: { ref: 'main', sha: 'c'.repeat(40) } }), stderr: '' }; if (path.includes('/check-runs')) return { ok: true, stdout: JSON.stringify({ total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] }), stderr: '' }; if (path.includes('/status')) return { ok: true, stdout: JSON.stringify({ total_count: 1, statuses: [{ state: 'success' }] }), stderr: '' }; if (path.includes('/git/ref/')) return { ok: true, stdout: JSON.stringify({ object: { sha: 'c'.repeat(40) } }), stderr: '' }; return { ok: true, stdout: JSON.stringify({ merged: true }), stderr: '' }; };
  const live = createGitHubIntegrationGateway({ repository: 'acme/helm', receipts: () => [receipt], acceptanceEvidence: () => [{ ref: 'gate:8', head }], transport, testOnlyAllowDirectMerge: true }); const observed = await live.read(8); await live.merge(8, head);
  assert.equal(observed.state, 'OPEN');
  assert.ok(calls.some(call => call.some(arg => arg.startsWith(`repos/acme/helm/commits/${head}/check-runs?per_page=100`)))); assert.ok(calls.some(call => call.includes(`sha=${head}`) && call.includes('PUT')));
});
