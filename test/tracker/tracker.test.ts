import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitHubMapTracker, ghCommandTransport, type TrackerCommandResult, type TrackerCommandTransport } from '../../src/tracker/index.js';

type Issue = { number: number; title?: string; state?: string; updated_at?: string; html_url?: string; repository_url?: string; labels?: string[] };
const timestamp = '2026-09-15T00:00:00Z';
function issue(number: number, overrides: Partial<Issue> = {}): Issue { return { number, title: `Issue ${number}`, state: 'OPEN', updated_at: timestamp, html_url: `https://github.com/owner/repo/issues/${number}`, repository_url: 'https://api.github.com/repos/owner/repo', labels: ['wayfinder:task', 'complexity:high'], ...overrides }; }
function issueKey(entry: Issue): string { return `${entry.repository_url!.replace('https://api.github.com/repos/', '')}#${entry.number}`; }

function transportFixture(input: { issues: Issue[]; children?: Record<number, unknown[]>; blockers?: Record<number, unknown[]>; fail?: (path: string) => boolean }): { transport: TrackerCommandTransport; calls: string[] } {
  const issues = new Map(input.issues.map((entry) => [issueKey(entry), entry])); const calls: string[] = [];
  const transport: TrackerCommandTransport = async (argv): Promise<TrackerCommandResult> => {
    const path = argv[3]; assert.equal(typeof path, 'string'); calls.push(path);
    if (input.fail?.(path)) return { ok: false, stdout: '', stderr: 'fixture failure' };
    const match = path.match(/^repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)(?:\/(sub_issues|dependencies\/blocked_by))?(?:\?.*)?$/);
    if (!match) return { ok: false, stdout: '', stderr: 'unexpected path' };
    const repository = match[1]!; const number = Number(match[2]); const relation = match[3];
    if (relation === 'sub_issues') return { ok: true, stdout: JSON.stringify(input.children?.[number] ?? []), stderr: '' };
    if (relation === 'dependencies/blocked_by') return { ok: true, stdout: JSON.stringify(input.blockers?.[number] ?? []), stderr: '' };
    const value = issues.get(`${repository}#${number}`); return value ? { ok: true, stdout: JSON.stringify(value), stderr: '' } : { ok: false, stdout: '', stderr: 'not found' };
  };
  return { transport, calls };
}

function tracker(fixture: ReturnType<typeof transportFixture>, options: Partial<{ parentIssue: number; pageLimit: number; nodeLimit: number; requestLimit: number }> = {}) {
  return new GitHubMapTracker({ repo: 'owner/repo', parentIssue: options.parentIssue ?? 1, transport: fixture.transport, now: () => timestamp, pageLimit: options.pageLimit, nodeLimit: options.nodeLimit, requestLimit: options.requestLimit });
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

test('literal GitHub REST lowercase state is normalized and a cross-repository blocker retains its repository identity', async () => {
  const other = 'https://api.github.com/repos/other/repo';
  const f = transportFixture({
    issues: [issue(1, { state: 'open' }), issue(2), issue(7, { state: 'closed', repository_url: other, html_url: 'https://github.com/other/repo/issues/7' })],
    children: { 1: [issue(2)] }, blockers: { 2: [issue(7, { state: 'closed', repository_url: other, html_url: 'https://github.com/other/repo/issues/7' })] },
  });
  const snapshot = await tracker(f).snapshot();
  assert.equal(snapshot.completeness, 'complete'); assert.equal(snapshot.nodes[0]!.state, 'OPEN');
  assert.deepEqual(snapshot.frontier[0]!.blockers, [{ repository: 'other/repo', number: 7 }]);
  assert(f.calls.includes('repos/other/repo/issues/7'), 'the configured repository was not substituted for an external blocker');
});

test('returned issue identity, node cap, and request cap all fail closed', async () => {
  const mismatched: TrackerCommandTransport = async () => ({ ok: true, stdout: JSON.stringify(issue(2)), stderr: '' });
  const wrong = await new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, transport: mismatched, now: () => timestamp }).snapshot();
  assert.equal(wrong.completeness, 'incomplete'); assert.deepEqual(wrong.frontier, []); assert.deepEqual(wrong.incomplete, [{ code: 'invalid_response', subject: 'issue:owner/repo#1' }]);
  const unsafeUrl: TrackerCommandTransport = async () => ({ ok: true, stdout: JSON.stringify(issue(1, { html_url: 'https://example.test/owner/repo/issues/1' })), stderr: '' });
  const wrongUrl = await new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, transport: unsafeUrl, now: () => timestamp }).snapshot();
  assert.equal(wrongUrl.completeness, 'incomplete'); assert.deepEqual(wrongUrl.incomplete, [{ code: 'invalid_response', subject: 'issue:owner/repo#1' }]);
  const nodes = transportFixture({ issues: [issue(1), issue(2)], children: { 1: [issue(2)] } });
  const cappedNodes = await tracker(nodes, { nodeLimit: 1 }).snapshot();
  assert.equal(cappedNodes.completeness, 'incomplete'); assert.deepEqual(cappedNodes.incomplete, [{ code: 'node_limit', subject: 'owner/repo' }]);
  const requests = transportFixture({ issues: [issue(1)] });
  const cappedRequests = await new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, transport: requests.transport, now: () => timestamp, requestLimit: 1 }).snapshot();
  assert.equal(cappedRequests.completeness, 'incomplete'); assert.deepEqual(cappedRequests.incomplete, [{ code: 'request_limit', subject: 'owner/repo' }]);
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

test('snapshot bounds concurrent independent reads while retaining a 34-node star', async () => {
  const children = Array.from({ length: 34 }, (_, index) => issue(index + 2)); let active = 0, maximum = 0, requests = 0;
  const transport: TrackerCommandTransport = async (argv) => {
    const path = argv[3]!; requests += 1; active += 1; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 2)); active -= 1;
    const match = path.match(/^repos\/owner\/repo\/issues\/(\d+)(?:\/([^?]+))?/); if (!match) return { ok: false, stdout: '', stderr: 'bad path' };
    const number = Number(match[1]), relation = match[2];
    if (relation === 'sub_issues') return { ok: true, stdout: JSON.stringify(number === 1 ? children : []), stderr: '' };
    if (relation === 'dependencies/blocked_by') return { ok: true, stdout: '[]', stderr: '' };
    return { ok: true, stdout: JSON.stringify(issue(number)), stderr: '' };
  };
  const snapshot = await new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, transport, now: () => timestamp, concurrency: 8 }).snapshot();
  assert.equal(snapshot.completeness, 'complete'); assert.equal(snapshot.nodes.length, 35);
  assert.equal(requests, 105, 'one direct issue read and two sequential relation reads per observed node');
  assert.ok(maximum > 1); assert.ok(maximum <= 8);
});

test('concurrent child discovery retains multiple-parent and malformed-page refusals', async () => {
  const multi = transportFixture({ issues: [issue(1), issue(2), issue(3), issue(4)], children: { 1: [issue(2), issue(3)], 2: [issue(4)], 3: [issue(4)] } });
  const multipleParent = await new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, transport: multi.transport, now: () => timestamp, concurrency: 8 }).snapshot();
  assert.equal(multipleParent.completeness, 'incomplete'); assert.deepEqual(multipleParent.frontier, []); assert.ok(multipleParent.incomplete.some(reason => reason.code === 'cycle' && reason.subject === 'issue:4'));
  const malformed = transportFixture({ issues: [issue(1), issue(2), issue(3)], children: { 1: [issue(2), issue(3)], 2: [{ broken: true }] } });
  const invalid = await new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, transport: malformed.transport, now: () => timestamp, concurrency: 8 }).snapshot();
  assert.equal(invalid.completeness, 'incomplete'); assert.deepEqual(invalid.frontier, []); assert.ok(invalid.incomplete.some(reason => reason.code === 'invalid_response'));
});

test('default gh transport bounds runaway subprocess output with a single termination sequence', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-tracker-output-')); const gh = join(root, 'gh'); const marker = join(root, 'terms');
  await writeFile(gh, `#!/usr/bin/env node
const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(marker)}, 'x', { flag: 'a' }));
setInterval(() => process.stdout.write('x'.repeat(1024)), 0);
`); await chmod(gh, 0o755);
  const priorPath = process.env.PATH; process.env.PATH = `${root}:${priorPath}`;
  try {
    const result = await ghCommandTransport(['api', '-X', 'GET', 'repos/owner/repo/issues/1'], { timeoutMs: 2_000, outputByteLimit: 32 });
    assert.equal(result.ok, false); assert.equal(result.outputTruncated, true); assert(result.stdout.length <= 32);
    assert.equal(await readFile(marker, 'utf8'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await readFile(marker, 'utf8'), 'x', 'later output chunks cannot create another termination sequence');
  } finally { process.env.PATH = priorPath; }
});

test('default gh transport escalates a TERM-ignoring process to a bounded SIGKILL outcome', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-tracker-timeout-')); const gh = join(root, 'gh');
  const marker = join(root, 'term-observed'); const ready = join(root, 'ready');
  await writeFile(gh, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(marker)}, 'observed'));
setInterval(() => {}, 1000);
`); await chmod(gh, 0o755);
  const priorPath = process.env.PATH; process.env.PATH = `${root}:${priorPath}`;
  try {
    const started = Date.now(); const pending = ghCommandTransport(['api', '-X', 'GET', 'repos/owner/repo/issues/1'], { timeoutMs: 2_000, outputByteLimit: 32 });
    const readyDeadline = Date.now() + 1_500;
    while (true) { try { await readFile(ready); break; } catch { if (Date.now() > readyDeadline) throw new Error('TERM-ignoring fixture did not start'); await new Promise((resolve) => setTimeout(resolve, 10)); } }
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.equal(await readFile(marker, 'utf8'), 'observed');
    assert(Date.now() - started >= 2_000 && Date.now() - started < 4_000, 'the direct child ignored TERM until the bounded SIGKILL grace elapsed');
  } finally { process.env.PATH = priorPath; }
});

test('observer construction refuses unbounded traversal, subprocess time, and output settings', () => {
  assert.throws(() => new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, pageLimit: 51 }), /pageLimit/);
  assert.throws(() => new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, nodeLimit: 1_001 }), /nodeLimit/);
  assert.throws(() => new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, requestLimit: 10_001 }), /requestLimit/);
  assert.throws(() => new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, timeoutMs: 60_001 }), /timeoutMs/);
  assert.throws(() => new GitHubMapTracker({ repo: 'owner/repo', parentIssue: 1, outputByteLimit: 4_000_001 }), /outputByteLimit/);
});

test('observer CLI accepts only explicit repo and map arguments and emits an injected-gh snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-tracker-observe-')); const fake = join(root, 'fake'); const gh = join(fake, 'gh');
  await (await import('node:fs/promises')).mkdir(fake);
  await writeFile(gh, `#!/usr/bin/env node
const path = process.argv.find((entry) => entry.startsWith('repos/'));
const issue = (n) => ({ number:n, title:'Issue '+n, state:'OPEN', html_url:'https://github.com/owner/repo/issues/'+n, repository_url:'https://api.github.com/repos/owner/repo', updated_at:'2026-09-15T00:00:00Z' });
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
