import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitHubMapTracker, ghCommandTransport, type TrackerCommandResult, type TrackerCommandTransport } from '../../src/tracker/index.js';

type Issue = { number: number; title?: string; state?: 'OPEN' | 'CLOSED'; updated_at?: string; html_url?: string; labels?: string[] };
const timestamp = '2026-09-15T00:00:00Z';
function issue(number: number, overrides: Partial<Issue> = {}): Issue { return { number, title: `Issue ${number}`, state: 'OPEN', updated_at: timestamp, html_url: `https://example.test/issues/${number}`, labels: ['wayfinder:task', 'complexity:high'], ...overrides }; }

function transportFixture(input: { issues: Issue[]; children?: Record<number, unknown[]>; blockers?: Record<number, unknown[]>; fail?: (path: string) => boolean }): { transport: TrackerCommandTransport; calls: string[] } {
  const issues = new Map(input.issues.map((entry) => [entry.number, entry])); const calls: string[] = [];
  const transport: TrackerCommandTransport = async (argv): Promise<TrackerCommandResult> => {
    const path = argv[3]; assert.equal(typeof path, 'string'); calls.push(path);
    if (input.fail?.(path)) return { ok: false, stdout: '', stderr: 'fixture failure' };
    const match = path.match(/\/issues\/(\d+)(?:\/(sub_issues|dependencies\/blocked_by))?(?:\?.*)?$/);
    if (!match) return { ok: false, stdout: '', stderr: 'unexpected path' };
    const number = Number(match[1]); const relation = match[2];
    if (relation === 'sub_issues') return { ok: true, stdout: JSON.stringify(input.children?.[number] ?? []), stderr: '' };
    if (relation === 'dependencies/blocked_by') return { ok: true, stdout: JSON.stringify(input.blockers?.[number] ?? []), stderr: '' };
    const value = issues.get(number); return value ? { ok: true, stdout: JSON.stringify(value), stderr: '' } : { ok: false, stdout: '', stderr: 'not found' };
  };
  return { transport, calls };
}

function tracker(fixture: ReturnType<typeof transportFixture>, options: Partial<{ parentIssue: number; pageLimit: number }> = {}) {
  return new GitHubMapTracker({ repo: 'owner/repo', parentIssue: options.parentIssue ?? 1, transport: fixture.transport, now: () => timestamp, pageLimit: options.pageLimit });
}

test('snapshot follows native recursive sub-issue membership, fresh external blockers, and never reads legacy labels', async () => {
  const f = transportFixture({
    issues: [issue(1, { labels: ['not-a-task'] }), issue(2), issue(3), issue(9, { state: 'CLOSED' }), issue(10, { state: 'OPEN' })],
    children: { 1: [issue(2), issue(3)] }, blockers: { 2: [issue(9, { state: 'CLOSED' })], 3: [issue(10)] },
  });
  const snapshot = await tracker(f).snapshot();
  assert.equal(snapshot.completeness, 'complete');
  assert.deepEqual(snapshot.nodes.map((node) => ({ number: node.number, parent: node.parentIssue, children: node.subIssues, blockers: node.blockedBy.map((blocker) => [blocker.number, blocker.state]) })), [
    { number: 1, parent: null, children: [2, 3], blockers: [] }, { number: 2, parent: 1, children: [], blockers: [[9, 'CLOSED']] }, { number: 3, parent: 1, children: [], blockers: [[10, 'OPEN']] },
  ]);
  assert.deepEqual(snapshot.frontier.map((node) => node.number), [2], 'the parent and externally blocked child are not actionable');
  assert(f.calls.some((path) => path.includes('/issues/9')), 'blocker state is freshly observed');
  assert(f.calls.some((path) => path.includes('/sub_issues')), 'membership uses native subissues');
  assert(f.calls.every((path) => !path.includes('wayfinder') && !path.includes('labels')));
});

test('a malformed native page produces an explicit incomplete snapshot and no frontier', async () => {
  const f = transportFixture({ issues: [issue(1)], children: { 1: [{ number: 'not-an-issue' }] } });
  const snapshot = await tracker(f).snapshot();
  assert.equal(snapshot.completeness, 'incomplete'); assert.deepEqual(snapshot.frontier, []);
  assert.deepEqual(snapshot.incomplete, [{ code: 'invalid_response', subject: 'repos/owner/repo/issues/1/sub_issues:page:1' }]);
});

test('transport failure and bounded pagination fail closed instead of presenting a partial empty Map', async () => {
  const failed = transportFixture({ issues: [issue(1)], fail: (path) => path.includes('/sub_issues') });
  const unavailable = await tracker(failed).snapshot();
  assert.equal(unavailable.completeness, 'incomplete'); assert.deepEqual(unavailable.frontier, []);
  assert.deepEqual(unavailable.incomplete, [{ code: 'transport_failed', subject: 'repos/owner/repo/issues/1/sub_issues?per_page=100&page=1' }]);
  const paged = transportFixture({ issues: [issue(1)], children: { 1: Array.from({ length: 100 }, () => issue(2)) } });
  const limited = await tracker(paged, { pageLimit: 1 }).snapshot();
  assert.equal(limited.completeness, 'incomplete'); assert.deepEqual(limited.frontier, []);
  assert.deepEqual(limited.incomplete, [{ code: 'page_limit', subject: 'repos/owner/repo/issues/1/sub_issues' }]);
});

test('native membership cycles are explicit incomplete observations', async () => {
  const f = transportFixture({ issues: [issue(1), issue(2)], children: { 1: [issue(2)], 2: [issue(1)] } });
  const snapshot = await tracker(f).snapshot();
  assert.equal(snapshot.completeness, 'incomplete'); assert.deepEqual(snapshot.frontier, []);
  assert.deepEqual(snapshot.incomplete, [{ code: 'cycle', subject: 'issue:1' }]);
});

test('pagination reaches a terminating second page before declaring the native graph complete', async () => {
  const calls: string[] = []; const hundred = Array.from({ length: 100 }, () => issue(2));
  const transport: TrackerCommandTransport = async (argv) => {
    const path = argv[3]!; calls.push(path);
    if (path === 'repos/owner/repo/issues/1' || path === 'repos/owner/repo/issues/2') return { ok: true, stdout: JSON.stringify(issue(path.endsWith('/1') ? 1 : 2)), stderr: '' };
    if (path.includes('dependencies/blocked_by')) return { ok: true, stdout: '[]', stderr: '' };
    if (path.includes('/issues/1/sub_issues') && path.endsWith('&page=1')) return { ok: true, stdout: JSON.stringify(hundred), stderr: '' };
    if (path.includes('/issues/1/sub_issues') && path.endsWith('&page=2')) return { ok: true, stdout: '[]', stderr: '' };
    if (path.includes('/issues/2/sub_issues')) return { ok: true, stdout: '[]', stderr: '' };
    return { ok: false, stdout: '', stderr: `unexpected ${path}` };
  };
  const snapshot = await new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, transport, now: () => timestamp }).snapshot();
  assert.equal(snapshot.completeness, 'complete'); assert.deepEqual(snapshot.frontier.map((node) => node.number), [2]);
  assert(calls.some((path) => path.includes('/issues/1/sub_issues') && path.endsWith('&page=2')), 'the observer did not silently assume a full first page was complete');
});

test('default gh transport bounds untrusted subprocess output', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-tracker-output-')); const gh = join(root, 'gh');
  await writeFile(gh, '#!/bin/sh\nnode -e "process.stdout.write(\'x\'.repeat(4096))"\n'); await chmod(gh, 0o755);
  const priorPath = process.env.PATH; process.env.PATH = `${root}:${priorPath}`;
  try {
    const result = await ghCommandTransport(['api', '-X', 'GET', 'repos/owner/repo/issues/1'], { timeoutMs: 1_000, outputByteLimit: 32 });
    assert.equal(result.ok, false); assert.equal(result.outputTruncated, true); assert(result.stdout.length <= 32);
  } finally { process.env.PATH = priorPath; }
});

test('observer construction refuses unbounded pagination, subprocess time, and output settings', () => {
  assert.throws(() => new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, pageLimit: 51 }), /pageLimit/);
  assert.throws(() => new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, timeoutMs: 60_001 }), /timeoutMs/);
  assert.throws(() => new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, outputByteLimit: 4_000_001 }), /outputByteLimit/);
});

test('observer CLI accepts only explicit repo and map arguments and emits an injected-gh snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-tracker-observe-')); const fake = join(root, 'fake'); const gh = join(fake, 'gh');
  await (await import('node:fs/promises')).mkdir(fake);
  await writeFile(gh, `#!/usr/bin/env node
const path = process.argv.find((entry) => entry.startsWith('repos/'));
const issue = (n) => ({ number:n, title:'Issue '+n, state:'OPEN', html_url:'https://example.test/issues/'+n, updated_at:'2026-09-15T00:00:00Z' });
if (path.endsWith('/issues/1')) console.log(JSON.stringify(issue(1)));
else if (path.includes('/sub_issues') || path.includes('/dependencies/blocked_by')) console.log('[]');
else process.exit(1);
`); await chmod(gh, 0o755);
  const env = { ...process.env, PATH: `${fake}:${process.env.PATH}` };
  const observed = spawnSync(process.execPath, ['--import', 'tsx', 'src/tracker/observe.ts', '--repo', 'owner/repo', '--map', '1'], { cwd: join(process.cwd()), env, encoding: 'utf8' });
  assert.equal(observed.status, 0, observed.stderr); assert.equal(JSON.parse(observed.stdout).completeness, 'complete');
  const invalid = spawnSync(process.execPath, ['--import', 'tsx', 'src/tracker/observe.ts', '--repo', 'bad repo', '--map', '1'], { cwd: join(process.cwd()), env, encoding: 'utf8' });
  assert.equal(invalid.status, 2); assert.match(invalid.stderr, /OWNER\/REPO/);
});
