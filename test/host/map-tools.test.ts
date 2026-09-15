import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openHost } from '../../src/host/index.js';
import { appendHostMapTools, mapClosePayloadSchema, mapUpdatePayloadSchema } from '../../src/host/map-tools.js';
import { HelmToolRegistry } from '../../src/runtime/orchestrator/index.js';
import type { TrackerCommandTransport } from '../../src/tracker/index.js';

const before = '2026-09-15T00:00:00Z';
const after = '2026-09-15T00:01:00Z';
const later = '2026-09-16T00:00:00Z';
const context = { runId: 'map-run', sessionId: 'map-session', mode: 'primary' as const };

function transport(input: { failPatch?: boolean } = {}) {
  const issues = new Map<number, { number: number; title: string; body: string; state: 'open' | 'closed'; updated_at: string; html_url: string; repository_url: string }>();
  const issue = (number: number, patch = {}) => ({ number, title: `Issue ${number}`, body: `Body ${number}`, state: 'open' as const, updated_at: before, html_url: `https://github.com/owner/repo/issues/${number}`, repository_url: 'https://api.github.com/repos/owner/repo', ...patch });
  issues.set(1, issue(1)); issues.set(2, issue(2)); issues.set(9, issue(9, { state: 'closed' as const }));
  let patches = 0;
  const value: TrackerCommandTransport = async (argv) => {
    const method = argv[2]!; const path = argv[3]!; const match = path.match(/^repos\/owner\/repo\/issues\/(\d+)(?:\/(sub_issues|dependencies\/blocked_by))?/);
    if (!match) return { ok: false, stdout: '', stderr: 'unexpected' };
    const number = Number(match[1]); const relation = match[2];
    if (method === 'GET' && relation === 'sub_issues') return { ok: true, stdout: JSON.stringify(number === 1 ? [issues.get(2)] : []), stderr: '' };
    if (method === 'GET' && relation === 'dependencies/blocked_by') return { ok: true, stdout: JSON.stringify(number === 2 ? [issues.get(9)] : []), stderr: '' };
    if (method === 'GET') return { ok: true, stdout: JSON.stringify(issues.get(number)), stderr: '' };
    if (method === 'PATCH') { patches += 1; if (input.failPatch) return { ok: false, stdout: '', stderr: 'lost' }; const fields = Object.fromEntries(argv.slice(4).reduce<string[][]>((all, entry, index, values) => entry === '-f' && values[index + 1] ? [...all, values[index + 1]!.split(/=(.*)/s)] : all, [])); const current = issues.get(number)!; const next = { ...current, ...(fields.title ? { title: fields.title } : {}), ...(fields.body ? { body: fields.body } : {}), ...(fields.state ? { state: fields.state as 'open' | 'closed' } : {}), updated_at: after }; issues.set(number, next); return { ok: true, stdout: JSON.stringify(next), stderr: '' }; }
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  return { value, patches: () => patches };
}

async function fixture(input: { failPatch?: boolean; evidenceFails?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'helm3-map-tools-'));
  const plane = await openHost({ stateDirectory: directory, now: () => before, kinds: { 'map.update': { payloadSchema: mapUpdatePayloadSchema }, 'map.close': { payloadSchema: mapClosePayloadSchema } } });
  plane.recordHumanAuthority({ authorityId: 'human', repositoryId: 'owner/repo', mapNodeIds: ['2'], allowedActions: ['map.update', 'map.close'], expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
  plane.recordAutonomyLease({ leaseId: 'autonomy', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'owner/repo', mapNodeIds: ['2'] }, allowedActions: ['map.update', 'map.close'], issuedAt: before, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
  plane.acquireOwnership({ runId: context.runId, leaseId: 'owner', owner: 'fable', sessionId: context.sessionId, epoch: 1, issuedAt: before, expiresAt: later }, 0);
  const fake = transport(input); let validation = 0;
  const tools = appendHostMapTools(new HelmToolRegistry([]), { context, authorize: async (actual) => { plane.artifactsFor(actual); }, host: plane, catalog: { async resolve(node) { if (node !== 'node-2') throw new Error('foreign'); return { node, repositoryId: 'owner/repo', parentIssue: 1, issueNumber: 2 }; } }, transport: fake.value, command: { actorId: 'fable', leaseId: 'autonomy', leaseRevision: 1, orchestratorLeaseId: 'owner', orchestratorEpoch: 1, plannedAt: () => before, notAfter: () => later }, executor: { executorId: 'host-map' }, claimExpiresAt: () => later, closureEvidence: { async validate(value) { validation += 1; if (input.evidenceFails || value.target.issueNumber !== 2 || value.evidenceRefs.some((ref) => ref !== 'gate:accepted')) throw new Error('untrusted evidence'); } } });
  return { directory, plane, tools, fake, validations: () => validation };
}

test('map.update uses Core admission, mutator readback receipt, and stable durable idempotency', async () => {
  const value = await fixture();
  try {
    const first = await value.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, title: 'Renamed' }, context);
    assert.equal(first.state, 'succeeded', JSON.stringify(first)); assert.equal(value.fake.patches(), 1);
    const second = await value.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, title: 'Renamed' }, context);
    assert.equal(second.state, 'succeeded'); assert.equal(value.fake.patches(), 1, 'a replay reads the durable receipt and cannot PATCH twice');
    const snapshot = await value.plane.snapshot(context.runId); assert.equal(snapshot.commands.length, 1); assert.equal(snapshot.commands[0]?.status, 'succeeded'); assert.equal(snapshot.commands[0]?.observations[0]?.evidenceRefs.length, 1);
  } finally { value.plane.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test('map.close binds only verified evidence while invalid input and uncertain writes never become success', async () => {
  const evidence = await fixture({ evidenceFails: true }); const unknown = await fixture({ failPatch: true }); const closed = await fixture();
  try {
    const refused = await evidence.tools.invoke('map.close', { node: 'node-2', expectedRevision: before, rationale: 'Done.', evidenceRefs: ['foreign:claim'], resolvedDependencies: ['owner/repo#9'] }, context);
    assert.equal(refused.state, 'refused'); assert.equal(evidence.fake.patches(), 0);
    const malformed = await evidence.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, command: 'PATCH' }, context);
    assert.equal(malformed.state, 'refused'); assert.equal(evidence.fake.patches(), 0);
    const result = await unknown.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, title: 'Maybe' }, context);
    assert.equal(result.state, 'unknown', JSON.stringify(result)); assert.equal(unknown.fake.patches(), 1);
    const replay = await unknown.tools.invoke('map.update', { node: 'node-2', expectedRevision: before, title: 'Maybe' }, context);
    assert.equal(replay.state, 'unknown'); assert.equal(unknown.fake.patches(), 1);
    const success = await closed.tools.invoke('map.close', { node: 'node-2', expectedRevision: before, rationale: 'Verified gate passed.', evidenceRefs: ['gate:accepted'], resolvedDependencies: ['owner/repo#9'] }, context);
    assert.equal(success.state, 'succeeded', JSON.stringify(success)); assert.equal(closed.fake.patches(), 1); assert.equal(closed.validations(), 2, 'closure evidence is checked before admission and again at effect time');
  } finally { for (const value of [evidence, unknown, closed]) { value.plane.close(); await rm(value.directory, { recursive: true, force: true }); } }
});
