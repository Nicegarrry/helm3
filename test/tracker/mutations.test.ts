import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GitHubMapMutator, type MapMutationAuthority } from '../../src/tracker/mutations.js';
import type { Command } from '../../src/contracts/index.js';
import type { TrackerCommandResult, TrackerCommandTransport } from '../../src/tracker/index.js';
import { openKernel } from '../../src/core/index.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod/v3';

const before = '2026-09-15T00:00:00Z';
const after = '2026-09-15T00:01:00Z';
type Issue = { number: number; title: string; body: string; state: 'open' | 'closed'; updated_at: string; html_url: string; repository_url: string };
function issue(number: number, patch: Partial<Issue> = {}): Issue {
  return { number, title: `Issue ${number}`, body: `Body ${number}`, state: 'open', updated_at: before, html_url: `https://github.com/owner/repo/issues/${number}`, repository_url: 'https://api.github.com/repos/owner/repo', ...patch };
}
function hash(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function command(kind: 'map.update' | 'map.close', payload: Record<string, unknown>): Command {
  return {
    schemaVersion: 1, commandId: `${kind}:1`, kind, idempotencyKey: `${kind}:1`, payloadHash: hash(payload),
    scope: { repositoryId: 'owner/repo', mapNodeId: '2' }, actorId: 'orchestrator', runId: 'run-1', origin: 'orchestrator',
    leaseId: 'lease-1', leaseRevision: 1, orchestratorLeaseId: 'owner-1', orchestratorEpoch: 1,
    plannedAt: before, notAfter: '2026-09-16T00:00:00Z', expected: [{ authority: 'github', subject: 'repos/owner/repo/issues/2', version: before, predicate: 'issue revision matches' }], payload, requiredEvidence: ['evidence:gate'],
  };
}

function fixture(input: { blockerState?: 'open' | 'closed'; failPatch?: boolean; throwPatch?: boolean; foreign?: boolean; changeTargetDuringDependencies?: boolean }) {
  const entries = new Map<number, Issue>([[1, issue(1)], [2, issue(2, input.foreign ? { repository_url: 'https://api.github.com/repos/other/repo', html_url: 'https://github.com/other/repo/issues/2' } : {})], [9, issue(9, { state: input.blockerState ?? 'closed' })]]);
  const calls: string[] = []; let dependencyReads = 0;
  const transport: TrackerCommandTransport = async (argv): Promise<TrackerCommandResult> => {
    const method = argv[2]; const path = argv[3]!; calls.push(`${method} ${path}`);
    const match = path.match(/^repos\/owner\/repo\/issues\/(\d+)(?:\/(sub_issues|dependencies\/blocked_by))?/);
    if (!match) return { ok: false, stdout: '', stderr: 'unexpected path' };
    const number = Number(match[1]); const relation = match[2];
    if (method === 'GET' && relation === 'sub_issues') return { ok: true, stdout: JSON.stringify(number === 1 ? [entries.get(2)] : []), stderr: '' };
    if (method === 'GET' && relation === 'dependencies/blocked_by') {
      dependencyReads += 1; if (number === 2 && input.changeTargetDuringDependencies && dependencyReads > 2) entries.set(2, { ...entries.get(2)!, updated_at: after });
      return { ok: true, stdout: JSON.stringify(number === 2 ? [entries.get(9)] : []), stderr: '' };
    }
    if (method === 'GET') return { ok: true, stdout: JSON.stringify(entries.get(number)), stderr: '' };
    if (method === 'PATCH') {
      if (input.throwPatch) throw new Error('socket destroyed');
      if (input.failPatch) return { ok: false, stdout: '', stderr: 'connection reset' };
      const current = entries.get(number)!; const fields = Object.fromEntries(argv.slice(4).reduce<string[][]>((all, value, index, values) => value === '-f' && values[index + 1] ? [...all, values[index + 1]!.split(/=(.*)/s)] : all, []));
      const next = { ...current, ...(fields.title ? { title: fields.title } : {}), ...(fields.body ? { body: fields.body } : {}), ...(fields.state ? { state: fields.state as 'open' | 'closed' } : {}), updated_at: after };
      entries.set(number, next); return { ok: true, stdout: JSON.stringify(next), stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected method' };
  };
  return { transport, calls };
}

function mutator(transport: TrackerCommandTransport) { return new GitHubMapMutator({ repo: 'owner/repo', parentIssue: 1, transport, now: () => after }); }
function permit(input: Parameters<MapMutationAuthority>[0], verifiedEvidenceRefs?: readonly string[]) { return { commandId: input.command.commandId, idempotencyKey: input.command.idempotencyKey, commandHash: input.commandHash, ...(verifiedEvidenceRefs ? { verifiedEvidenceRefs } : {}) }; }

test('update fresh-reads membership and exact revision, calls authority before PATCH, and returns a frozen command-bound receipt', async () => {
  const f = fixture({}); const order: string[] = [];
  const authority: MapMutationAuthority = async (input) => { order.push(`authority:${input.target.revision}`); return permit(input); };
  const result = await mutator(f.transport).mutate(command('map.update', { issueNumber: 2, expectedRevision: before, title: 'Renamed' }), authority);
  assert.equal(result.state, 'succeeded'); assert.equal(result.target?.revision, after); assert.equal(result.commandId, 'map.update:1'); assert.match(result.commandHash, /^sha256:/);
  assert.equal(Object.isFrozen(result), true); assert(f.calls.filter((call) => call === 'GET repos/owner/repo/issues/2').length >= 2);
  const patch = f.calls.findIndex((call) => call.startsWith('PATCH ')); assert(patch > -1); assert.deepEqual(order, [`authority:${before}`]);
  assert.equal(result.concurrency, 'read_before_write_not_atomic');
});

test('stale revision, foreign identity, and authority refusal do not attempt a write', async () => {
  const stale = fixture({}); const staleResult = await mutator(stale.transport).mutate(command('map.update', { issueNumber: 2, expectedRevision: '2020-01-01T00:00:00Z', title: 'Nope' }), async () => { throw new Error('should not run'); });
  assert.equal(staleResult.state, 'refused'); assert.equal(stale.calls.some((call) => call.startsWith('PATCH ')), false);
  const foreign = fixture({ foreign: true }); const foreignResult = await mutator(foreign.transport).mutate(command('map.update', { issueNumber: 2, expectedRevision: before, title: 'Nope' }), async (input) => permit(input));
  assert.equal(foreignResult.state, 'refused'); assert.equal(foreign.calls.some((call) => call.startsWith('PATCH ')), false);
  const denied = fixture({}); const deniedResult = await mutator(denied.transport).mutate(command('map.update', { issueNumber: 2, expectedRevision: before, title: 'Nope' }), async () => { throw new Error('authority expired'); });
  assert.equal(deniedResult.state, 'refused'); assert.match(deniedResult.reason!, /authority expired/); assert.equal(denied.calls.some((call) => call.startsWith('PATCH ')), false);
});

test('an ambiguous PATCH produces unknown and is never replayed', async () => {
  const f = fixture({ failPatch: true }); const result = await mutator(f.transport).mutate(command('map.update', { issueNumber: 2, expectedRevision: before, title: 'Maybe' }), async (input) => permit(input));
  assert.equal(result.state, 'unknown'); assert.equal(f.calls.filter((call) => call.startsWith('PATCH ')).length, 1); assert.match(result.reason!, /write transport failed/);
});

test('a transport exception after PATCH begins is unknown, while a mismatched payload hash refuses before a write', async () => {
  const thrown = fixture({ throwPatch: true }); const unknown = await mutator(thrown.transport).mutate(command('map.update', { issueNumber: 2, expectedRevision: before, title: 'Maybe' }), async (input) => permit(input));
  assert.equal(unknown.state, 'unknown'); assert.match(unknown.reason!, /transport threw/); assert.equal(thrown.calls.filter((call) => call.startsWith('PATCH ')).length, 1);
  const bad = command('map.update', { issueNumber: 2, expectedRevision: before, title: 'Bad hash' }); bad.payloadHash = 'sha256:wrong'; const refused = fixture({});
  const result = await mutator(refused.transport).mutate(bad, async (input) => permit(input)); assert.equal(result.state, 'refused'); assert.match(result.reason!, /payload hash/); assert.equal(refused.calls.some((call) => call.startsWith('PATCH ')), false);
});

test('a callback must return the kernel one-shot permit for this exact command before PATCH', async () => {
  const f = fixture({}); const result = await mutator(f.transport).mutate(command('map.update', { issueNumber: 2, expectedRevision: before, title: 'Denied' }), async (input) => ({ ...permit(input), commandHash: 'sha256:other' }));
  assert.equal(result.state, 'refused'); assert.match(result.reason!, /kernel authority permit/); assert.equal(f.calls.some((call) => call.startsWith('PATCH ')), false);
});

test('closure requires evidence, a recorded rationale, and fresh resolved dependencies', async () => {
  const blocked = fixture({ blockerState: 'open' });
  const blockedResult = await mutator(blocked.transport).mutate(command('map.close', { issueNumber: 2, expectedRevision: before, evidenceRefs: ['evidence:gate'], resolvedDependencies: ['owner/repo#9'], rationale: 'The acceptance evidence satisfies the intended outcome.' }), async (input) => permit(input, ['evidence:gate']));
  assert.equal(blockedResult.state, 'refused'); assert.match(blockedResult.reason!, /unresolved dependency/); assert.equal(blocked.calls.some((call) => call.startsWith('PATCH ')), false);
  const f = fixture({ blockerState: 'closed' });
  const result = await mutator(f.transport).mutate(command('map.close', { issueNumber: 2, expectedRevision: before, evidenceRefs: ['evidence:gate'], resolvedDependencies: ['owner/repo#9'], rationale: 'The acceptance evidence satisfies the intended outcome.' }), async (input) => permit(input, ['evidence:gate']));
  assert.equal(result.state, 'succeeded'); assert.equal(result.target?.state, 'CLOSED');
});

test('a target revision change during closure dependency verification refuses before PATCH', async () => {
  const f = fixture({ blockerState: 'closed', changeTargetDuringDependencies: true });
  const result = await mutator(f.transport).mutate(command('map.close', { issueNumber: 2, expectedRevision: before, evidenceRefs: ['evidence:gate'], resolvedDependencies: ['owner/repo#9'], rationale: 'The acceptance evidence satisfies the intended outcome.' }), async (input) => permit(input, ['evidence:gate']));
  assert.equal(result.state, 'refused'); assert.match(result.reason!, /changed during dependency verification/); assert.equal(f.calls.some((call) => call.startsWith('PATCH ')), false);
});

test('closure traverses a full dependency page before accepting all 100 resolved dependencies', async () => {
  const dependencies = Array.from({ length: 100 }, (_, index) => issue(index + 9, { state: 'closed' })); const calls: string[] = []; let closed = false;
  const transport: TrackerCommandTransport = async (argv) => {
    const method = argv[2]!; const path = argv[3]!; calls.push(`${method} ${path}`); const match = path.match(/^repos\/owner\/repo\/issues\/(\d+)(?:\/(sub_issues|dependencies\/blocked_by))?/); if (!match) return { ok: false, stdout: '', stderr: 'unexpected' };
    const number = Number(match[1]); const relation = match[2]; const page = path.match(/[?&]page=(\d+)/)?.[1];
    if (method === 'PATCH') { closed = true; return { ok: true, stdout: JSON.stringify(issue(2, { state: 'closed', updated_at: after })), stderr: '' }; }
    if (relation === 'sub_issues') return { ok: true, stdout: JSON.stringify(number === 1 ? [issue(2)] : []), stderr: '' };
    if (relation === 'dependencies/blocked_by') return { ok: true, stdout: JSON.stringify(number === 2 && page === '1' ? dependencies : []), stderr: '' };
    if (number === 1 || number === 2) return { ok: true, stdout: JSON.stringify(number === 2 && closed ? issue(2, { state: 'closed', updated_at: after }) : issue(number)), stderr: '' };
    return { ok: true, stdout: JSON.stringify(dependencies.find((entry) => entry.number === number)), stderr: '' };
  };
  const result = await mutator(transport).mutate(command('map.close', { issueNumber: 2, expectedRevision: before, evidenceRefs: ['evidence:gate'], resolvedDependencies: dependencies.map((entry) => `owner/repo#${entry.number}`), rationale: 'All actual dependencies and acceptance evidence were verified.' }), async (input) => permit(input, ['evidence:gate']));
  assert.equal(result.state, 'succeeded'); assert(calls.some((call) => call.startsWith('PATCH '))); assert(calls.some((call) => call.endsWith('/dependencies/blocked_by?per_page=100&page=2')));
});

test('a Kernel-admitted nonalphabetic payload interoperates with the mutator byte hashes', async () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'helm3-map-mutation-')), 'kernel.sqlite');
  const { host } = openKernel({ databasePath, now: () => before, kinds: { 'map.update': { payloadSchema: z.object({ issueNumber: z.number().int(), expectedRevision: z.string(), title: z.string() }).strict() } } });
  host.declareHumanAuthority({ authorityId: 'human', repositoryId: 'owner/repo', mapNodeIds: ['2'], allowedActions: ['map.update'], expiresAt: '2026-09-16T00:00:00Z', maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
  host.issueAutonomyLease({ leaseId: 'lease-1', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'owner/repo', mapNodeIds: ['2'] }, allowedActions: ['map.update'], issuedAt: before, expiresAt: '2026-09-16T00:00:00Z', maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
  host.acquireOwnership({ runId: 'run-1', leaseId: 'owner-1', owner: 'astra', sessionId: 'session-1', epoch: 1, issuedAt: before, expiresAt: '2026-09-16T00:00:00Z' }, 0);
  const input = command('map.update', { issueNumber: 2, expectedRevision: before, title: 'Kernel update' });
  const admitted = host.admit(input, { actorId: 'trusted', allowedOrigins: ['orchestrator'], sessionId: 'session-1' });
  assert.equal(admitted.immutableHash, hash(admitted.command));
  const result = await mutator(fixture({}).transport).mutate(admitted.command, async (input) => permit(input));
  assert.equal(result.state, 'succeeded'); assert.equal(result.commandHash, admitted.immutableHash); host.close();
});
