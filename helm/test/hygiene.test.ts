import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupNodeModules, createHygiene } from '../src/hygiene.js';
import { ensureDeployTable } from '../src/deploy.js';
import { loadSettings, type Settings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { GitHub, PrStatus, Store, WorkerRow, Workspace } from '../src/types.js';

function worker(id: string, home: string, state: WorkerRow['state'], updatedAt: string): WorkerRow {
  return {
    workerId: id, repo: '/repo', repoSlug: 'owner/repo', role: 'builder', model: 'test/model', objective: id,
    acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'a'.repeat(40), branch: `helm/${id}`,
    worktree: join(home, 'worktrees', 'owner__repo', id), state, head: id === 'contained' ? 'c'.repeat(40) : 'b'.repeat(40),
    sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: updatedAt, updatedAt,
  };
}

function settings(home: string): Settings {
  return loadSettings(home);
}

function fakeWorkspace(removed: string[], contained: Set<string>, dirty: Set<string>, reachable: boolean | Set<string> = true, untracked = new Set<string>(), excludedContainedBranch?: string): Workspace {
  return {
    async create() { throw new Error('unused'); }, async remove(_repo, path) { removed.push(path); },
    async head() { return 'b'.repeat(40); }, async isClean() { return true; }, async diffStat() { return ''; },
    async patchId() { return ''; }, async commitAll() { return ''; }, async push() {}, async clone() {}, async fetch() {},
    async isTrackedClean(path) { return !dirty.has(path) && !untracked.has(path); },
    async contains(_repo, head, excludeBranch) { return contained.has(head) && excludeBranch !== excludedContainedBranch; },
    async reachableFromOrigin(_repo, head) { return reachable === true || (reachable instanceof Set && reachable.has(head)); },
    async prune() {}, async deleteBranch() {},
    async resolveSha() { return ''; }, async defaultBranch() { return 'main'; },
  };
}

function fakeGitHub(statuses: Map<number, PrStatus>): GitHub {
  return { async prStatus(_repo, number) { return statuses.get(number) ?? { number, state: 'open', head: '', mergeable: null, draft: false, checks: [], reviews: [], url: '' }; }, async openPr() { return { number: 1, url: '' }; }, async comment() { return { body: '' }; }, async postComment() {}, async merge() {} };
}

test('GC removes only settled clean workers eligible by merged PR, origin containment, or TTL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-'));
  const store = openStore(':memory:');
  const old = '2025-12-31T23:59:00.000Z';
  const recent = '2026-01-01T23:59:00.000Z';
  const workers = [
    worker('merged', home, 'succeeded', recent), worker('contained', home, 'succeeded', recent), worker('ttl', home, 'failed', old),
    worker('running', home, 'running', old), worker('dirty', home, 'succeeded', old), worker('recent', home, 'succeeded', recent),
  ];
  const removed: string[] = [];
  const dirty = new Set([workers[4]!.worktree]);
  const contained = new Set(['c'.repeat(40)]);
  const statuses = new Map([[41, { number: 41, state: 'merged' as const, head: 'b'.repeat(40), mergeable: true, draft: false, checks: [], reviews: [], url: '' }]]);
  try {
    for (const row of workers) store.insertWorker(row);
    mkdirSync(join(home, 'tmp', 'merged'), { recursive: true });
    store.insertPr({ repoSlug: 'owner/repo', number: 41, workerId: 'merged', url: 'https://github.com/owner/repo/pull/41', head: rowHead('merged'), createdAt: recent });
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace(removed, contained, dirty), github: fakeGitHub(statuses), now: () => new Date('2026-01-02T00:00:00.000Z') });
    await service.gc();
    assert.deepEqual(removed.map((path) => path.split('/').at(-1)).sort(), ['contained', 'merged', 'ttl']);
    assert.equal(existsSync(join(home, 'tmp', 'merged')), false);
    assert.equal(store.listEvents('merged').some((event) => event.kind === 'worktree.removed'), true);
    assert.equal(store.listEvents('running').some((event) => event.kind === 'worktree.removed'), false);
    assert.equal(store.listEvents('dirty').some((event) => event.kind === 'worktree.removed'), false);
    assert.equal(store.listEvents('recent').some((event) => event.kind === 'worktree.removed'), false);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('GC keeps an open-PR worker even when it is old and contained', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-open-pr-'));
  const store = openStore(':memory:');
  const row = worker('open-pr', home, 'failed', '2025-12-01T00:00:00.000Z');
  try {
    store.insertWorker(row);
    store.insertPr({ repoSlug: row.repoSlug, number: 42, workerId: row.workerId, url: 'https://github.com/owner/repo/pull/42', head: row.head!, createdAt: row.createdAt });
    const removed: string[] = [];
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace(removed, new Set([row.head!]), new Set()), github: fakeGitHub(new Map([[42, { number: 42, state: 'open', head: row.head!, mergeable: null, draft: false, checks: [], reviews: [], url: '' }]])), now: () => new Date('2026-01-02T00:00:00.000Z') });
    await service.gc();
    assert.deepEqual(removed, []);
    assert.equal(store.listEvents(row.workerId).some((event) => event.kind === 'worktree.removed'), false);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('GC does not treat the worker branch as an integration origin ref', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-own-branch-'));
  const store = openStore(':memory:');
  const row = worker('own-branch', home, 'succeeded', '2026-01-01T23:59:00.000Z');
  try {
    store.insertWorker(row);
    const removed: string[] = [];
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace(removed, new Set([row.head!]), new Set(), true, new Set(), row.branch), github: fakeGitHub(new Map()), now: () => new Date('2026-01-02T00:00:00.000Z') });
    await service.gc();
    assert.deepEqual(removed, []);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('GC keeps a TTL-eligible worker with unpushed commits and records the reason', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-unpushed-'));
  const store = openStore(':memory:');
  const row = worker('unpushed', home, 'failed', '2025-12-01T00:00:00.000Z');
  try {
    store.insertWorker(row);
    const removed: string[] = [];
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace(removed, new Set(), new Set(), false), github: fakeGitHub(new Map()), now: () => new Date('2026-01-02T00:00:00.000Z') });
    await service.gc();
    assert.deepEqual(removed, []);
    assert.equal(store.listEvents(row.workerId).some((event) => event.kind === 'worktree.kept' && event.data.reason === 'unpushed commits'), true);
    await service.gc();
    assert.equal(store.listEvents(row.workerId).filter((event) => event.kind === 'worktree.kept').length, 1);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('GC aborts when worker state changes during the GitHub check', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-race-'));
  const store = openStore(':memory:');
  const row = worker('changing', home, 'failed', '2025-12-01T00:00:00.000Z');
  try {
    store.insertWorker(row);
    const removed: string[] = [];
    const github = fakeGitHub(new Map([[43, { number: 43, state: 'merged', head: row.head!, mergeable: true, draft: false, checks: [], reviews: [], url: '' }]]));
    store.insertPr({ repoSlug: row.repoSlug, number: 43, workerId: row.workerId, url: 'https://github.com/owner/repo/pull/43', head: row.head!, createdAt: row.createdAt });
    const racingGithub: GitHub = { ...github, async prStatus() { store.updateWorker(row.workerId, { state: 'idle', updatedAt: '2026-01-01T00:00:00.000Z' }); return { number: 43, state: 'merged', head: row.head!, mergeable: true, draft: false, checks: [], reviews: [], url: '' }; } };
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace(removed, new Set(), new Set()), github: racingGithub, now: () => new Date('2026-01-02T00:00:00.000Z') });
    await service.gc();
    assert.deepEqual(removed, []);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('GC keeps a clean worker with an untracked non-ignored file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-untracked-'));
  const store = openStore(':memory:');
  const row = worker('untracked', home, 'failed', '2025-12-01T00:00:00.000Z');
  try {
    store.insertWorker(row);
    const removed: string[] = [];
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace(removed, new Set(), new Set(), true, new Set([row.worktree])), github: fakeGitHub(new Map()), now: () => new Date('2026-01-02T00:00:00.000Z') });
    await service.gc();
    assert.deepEqual(removed, []);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

function rowHead(id: string): string { return id === 'merged' ? 'b'.repeat(40) : 'c'.repeat(40); }

test('disk.low is emitted once per hour and low disk runs GC immediately', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-disk-'));
  const store = openStore(':memory:');
  let clock = new Date('2026-01-01T00:00:00.000Z');
  try {
    store.insertWorker(worker('running', home, 'running', clock.toISOString()));
    const removed: string[] = [];
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace(removed, new Set(), new Set()), github: fakeGitHub(new Map()), now: () => clock, statfs: async () => ({ bavail: 1, bsize: 1024 ** 3 }) });
    await service.tick();
    await service.tick();
    assert.equal(store.listAllEvents({ limit: 1000 }).filter((event) => event.kind === 'watch.alert' && event.data.rule === 'disk.low').length, 1);
    clock = new Date(clock.getTime() + 60 * 60_000 + 1);
    await service.tick();
    assert.equal(store.listAllEvents({ limit: 1000 }).filter((event) => event.kind === 'watch.alert' && event.data.rule === 'disk.low').length, 2);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('GC removes old terminal deploys, keeps recent or long-running deploy worktrees', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-deploys-'));
  const store = openStore(':memory:');
  const oldPath = join(home, 'deploys', 'owner__repo', 'd-old');
  const recentPath = join(home, 'deploys', 'owner__repo', 'd-recent');
  const runningPath = join(home, 'deploys', 'owner__repo', 'd-running');
  try {
    mkdirSync(oldPath, { recursive: true });
    mkdirSync(recentPath, { recursive: true });
    mkdirSync(runningPath, { recursive: true });
    const old = new Date('2025-12-31T22:00:00.000Z');
    utimesSync(oldPath, old, old);
    utimesSync(runningPath, old, old);
    ensureDeployTable(store);
    store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('d-old', 'owner/repo', 'preview', 'vercel', '{}', 'a'.repeat(40), 'succeeded', null, null, null, '{}', null, old.toISOString());
    store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('d-running', 'owner/repo', 'preview', 'vercel', '{}', 'a'.repeat(40), 'deploying', null, null, null, '{}', null, old.toISOString());
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace([], new Set(), new Set()), github: fakeGitHub(new Map()), now: () => new Date('2026-01-01T00:00:00.000Z'), deployInProgress: () => false });
    await service.gc();
    assert.equal(existsSync(oldPath), false);
    assert.equal(existsSync(recentPath), true);
    assert.equal(existsSync(runningPath), true);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('node_modules cleanup refuses symlink targets outside the worker worktree', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-symlink-'));
  const worktree = join(home, 'worktrees', 'owner__repo', 'w-link');
  const outside = mkdtempSync(join(tmpdir(), 'helm-hygiene-outside-'));
  const errors: string[] = [];
  try {
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(outside, 'node_modules'), { recursive: true });
    writeFileSync(join(outside, 'node_modules', 'sentinel'), 'keep');
    symlinkSync(join(outside, 'node_modules'), join(worktree, 'node_modules'), 'dir');
    await cleanupNodeModules(worktree, false, { allowedRoot: worktree, onError: (message) => errors.push(message) });
    assert.equal(existsSync(join(outside, 'node_modules', 'sentinel')), true);
    assert.match(errors[0] ?? '', /outside worktree/);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
