import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHygiene } from '../src/hygiene.js';
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

function fakeWorkspace(removed: string[], contained: Set<string>, dirty: Set<string>): Workspace {
  return {
    async create() { throw new Error('unused'); }, async remove(_repo, path) { removed.push(path); },
    async head() { return 'b'.repeat(40); }, async isClean() { return true; }, async diffStat() { return ''; },
    async patchId() { return ''; }, async commitAll() { return ''; }, async push() {}, async clone() {}, async fetch() {},
    async isTrackedClean(path) { return !dirty.has(path); },
    async contains(_repo, head) { return contained.has(head); },
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
    store.insertPr({ repoSlug: 'owner/repo', number: 41, workerId: 'merged', url: 'https://github.com/owner/repo/pull/41', head: rowHead('merged'), createdAt: recent });
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace(removed, contained, dirty), github: fakeGitHub(statuses), now: () => new Date('2026-01-02T00:00:00.000Z') });
    await service.gc();
    assert.deepEqual(removed.map((path) => path.split('/').at(-1)).sort(), ['contained', 'merged', 'ttl']);
    assert.equal(store.listEvents('merged').some((event) => event.kind === 'worktree.removed'), true);
    assert.equal(store.listEvents('running').some((event) => event.kind === 'worktree.removed'), false);
    assert.equal(store.listEvents('dirty').some((event) => event.kind === 'worktree.removed'), false);
    assert.equal(store.listEvents('recent').some((event) => event.kind === 'worktree.removed'), false);
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

test('GC removes deploy leftovers older than one hour and keeps recent deploy worktrees', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-hygiene-deploys-'));
  const store = openStore(':memory:');
  const oldPath = join(home, 'deploys', 'owner__repo', 'd-old');
  const recentPath = join(home, 'deploys', 'owner__repo', 'd-recent');
  try {
    mkdirSync(oldPath, { recursive: true });
    mkdirSync(recentPath, { recursive: true });
    const old = new Date('2025-12-31T22:00:00.000Z');
    utimesSync(oldPath, old, old);
    const service = createHygiene({ home, store, settings: settings(home), workspace: fakeWorkspace([], new Set(), new Set()), github: fakeGitHub(new Map()), now: () => new Date('2026-01-01T00:00:00.000Z') });
    await service.gc();
    assert.equal(existsSync(oldPath), false);
    assert.equal(existsSync(recentPath), true);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});
