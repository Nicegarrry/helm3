/** Worktrees, install caches and releases kept off HELM_HOME (e.g. on /Volumes/T7). */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pruneReleases } from '../bin/update.mjs';
import { sharedCacheRoot, withGateCache } from '../src/gate.js';
import { createHygiene, installCacheRoot, unmountedVolume, worktreeRoots } from '../src/hygiene.js';
import { buildSandboxProfile } from '../src/sandbox.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { GitHub, WorkerRow, Workspace } from '../src/types.js';

const unmounted = async () => ({ dev: 1 });
const mounted = async (path: string) => ({ dev: path === '/' || path === '/Volumes' ? 1 : 2 });
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

test('hygiene.worktreeRoot and installCacheRoot parse, expand ~ and reject relative paths', () => {
  const home = temp('helm-ext-settings-');
  try {
    assert.deepEqual(worktreeRoots(home, loadSettings(home).hygiene), { root: join(home, 'worktrees'), allowed: [join(home, 'worktrees')] });
    assert.equal(installCacheRoot(loadSettings(home).hygiene), undefined);
    writeFileSync(join(home, 'helm.json'), JSON.stringify({ hygiene: { worktreeRoot: '/Volumes/T7/helm/worktrees', installCacheRoot: '~/cache/helm' } }));
    const hygiene = loadSettings(home).hygiene;
    assert.deepEqual(worktreeRoots(home, hygiene), { root: '/Volumes/T7/helm/worktrees', allowed: ['/Volumes/T7/helm/worktrees', join(home, 'worktrees')] });
    assert.equal(installCacheRoot(hygiene), join(homedir(), 'cache', 'helm'));
    writeFileSync(join(home, 'helm.json'), JSON.stringify({ hygiene: { worktreeRoot: 'relative/worktrees' } }));
    const errors = console.error; console.error = () => {};
    try { assert.equal(loadSettings(home).hygiene.worktreeRoot, undefined); } finally { console.error = errors; }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('unmountedVolume flags a /Volumes path whose device matches / or /Volumes, or that is missing', async () => {
  assert.equal(await unmountedVolume('/Volumes/T7/helm/worktrees', unmounted), '/Volumes/T7');
  assert.equal(await unmountedVolume('/Volumes/T7/helm/worktrees', mounted), undefined);
  assert.equal(await unmountedVolume('/Volumes/T7', async (path) => { if (path === '/Volumes/T7') throw new Error('ENOENT'); return { dev: 1 }; }), '/Volumes/T7');
  assert.equal(await unmountedVolume('/Users/x/.helm/worktrees', unmounted), undefined);
  assert.equal(await unmountedVolume(`/Volumes/helm-absent-${process.pid}/x`), `/Volumes/helm-absent-${process.pid}`);
});

function row(id: string, worktree: string): WorkerRow {
  return {
    workerId: id, repo: '/repo', repoSlug: 'owner/repo', role: 'builder', model: 'test/model', objective: id, acceptance: null, contextPaths: [], allowWorkflows: false,
    baseRef: 'main', baseSha: 'a'.repeat(40), branch: `helm/${id}`, worktree, state: 'failed', head: 'b'.repeat(40), sessionFile: null, result: null, rawResultText: null,
    idempotencyKey: null, createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z',
  };
}
const workspace = (removed: string[]): Workspace => ({
  async create() { throw new Error('unused'); }, async remove(_repo, path) { removed.push(path); }, async head() { return 'b'.repeat(40); }, async isClean() { return true; },
  async diffStat() { return ''; }, async patchId() { return ''; }, async commitAll() { return ''; }, async push() {}, async clone() {}, async fetch() {},
  async isTrackedClean() { return true; }, async contains() { return false; }, async reachableFromOrigin() { return true; }, async prune() {}, async deleteBranch() {},
  async resolveSha() { return ''; }, async defaultBranch() { return 'main'; },
});
const github = { async prStatus() { throw new Error('unused'); } } as unknown as GitHub;

test('GC removes legacy default-root rows and skips worktrees on an unmounted volume', async () => {
  const home = temp('helm-ext-gc-');
  const root = '/Volumes/T7/helm/worktrees';
  const settings = { hygiene: { ...loadSettings(home).hygiene, worktreeRoot: root } };
  const legacy = row('w-legacy', join(home, 'worktrees', 'owner__repo', 'w-legacy'));
  const external = row('w-external', join(root, 'owner__repo', 'w-external'));
  const stray = row('w-stray', '/tmp/elsewhere/w-stray');
  const now = () => new Date('2026-01-02T00:00:00.000Z');
  for (const [volumeStat, expected] of [[unmounted, ['w-legacy']], [mounted, ['w-external', 'w-legacy']]] as const) {
    const store = openStore(':memory:');
    try {
      for (const value of [legacy, external, stray]) store.insertWorker(value);
      const removed: string[] = [];
      await createHygiene({ home, store, settings, workspace: workspace(removed), github, now, volumeStat }).gc();
      assert.deepEqual(removed.map((path) => path.split('/').at(-1)).sort(), expected);
      if (volumeStat === unmounted) assert.deepEqual(store.listEvents('w-external'), []);
    } finally { store.close(); }
  }
  rmSync(home, { recursive: true, force: true });
});

test('hygiene disk alert checks free space on the worktree root volume', async () => {
  const home = temp('helm-ext-disk-');
  const store = openStore(':memory:');
  try {
    store.insertWorker({ ...row('w-1', join(home, 'worktrees', 'owner__repo', 'w-1')), state: 'running' });
    const settings = { hygiene: { ...loadSettings(home).hygiene, worktreeRoot: '/Volumes/T7/wt' } };
    const statfs = async (path: string) => ({ bavail: path.startsWith('/Volumes/T7') ? 2 : 500, bsize: 1024 ** 3 });
    await createHygiene({ home, store, settings, workspace: workspace([]), github, statfs, volumeStat: mounted }).tick();
    assert.deepEqual(store.listEvents('project:owner/repo').map((event) => [event.data.rule, (event.data.detail as { freeGb: number }).freeGb]), [['disk.low', 2]]);
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('install cache uses the shared root when set, and falls back with a warning when its volume is unmounted', async () => {
  assert.equal(withGateCache('npm ci', '/tmp/run'), 'npm ci --cache "/tmp/run/npm-cache"');
  assert.equal(withGateCache('pnpm install', '/Volumes/T7/cache'), 'pnpm install --store-dir "/Volumes/T7/cache/pnpm-cache"');
  assert.equal(withGateCache('npm test', '/Volumes/T7/cache'), 'npm test');
  const warnings: string[] = [];
  assert.equal(await sharedCacheRoot(undefined), undefined);
  assert.equal(await sharedCacheRoot('/Volumes/T7/helm/cache', unmounted, (message) => warnings.push(message)), undefined);
  assert.match(warnings[0] ?? '', /install cache volume not mounted: \/Volumes\/T7/);
  const base = temp('helm-ext-cache-');
  try {
    const shared = await sharedCacheRoot(join(base, 'cache'));
    assert.equal(shared, realpathSync(join(base, 'cache')));
    const profile = buildSandboxProfile({ cwd: '/Volumes/T7/wt/w-1', tempDir: '/tmp/gate', operatorHomes: ['/Users/tester'], writePaths: [shared!], allowNetwork: true });
    assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${shared!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)\\)`));
    assert.match(profile, /\(allow file-write\* \(subpath "\/Volumes\/T7\/wt\/w-1"\)\)/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('release prune keeps the newest two plus every referenced release and drops stale staging dirs', () => {
  const home = temp('helm-ext-prune-');
  const releases = join(home, 'releases');
  const now = Date.now();
  const make = (name: string, ageMin: number) => {
    const path = join(releases, name);
    mkdirSync(join(path, 'helm'), { recursive: true });
    const at = new Date(now - ageMin * 60_000);
    utimesSync(path, at, at);
    return realpathSync(path);
  };
  try {
    const name = (i: number) => `1.7.${i}-${String(i).repeat(12).slice(0, 12)}-${String(i).repeat(8)}`;
    const paths: string[] = [1, 2, 3, 4, 5, 6].map((i) => make(name(i), 600 - i * 60)); // 6 is newest
    const staleStaging = make('staging-old', 120), freshStaging = make('staging-new', 5), unknown = make('notes', 900);
    const outside = temp('helm-ext-outside-');
    symlinkSync(outside, join(releases, `1.0.0-${'f'.repeat(12)}-${'f'.repeat(8)}`));
    writeFileSync(join(home, 'current-release.json'), JSON.stringify({ root: paths[0] }));
    writeFileSync(join(home, 'staged-release.json'), JSON.stringify({ root: paths[1] }));
    writeFileSync(join(home, 'upgrade.json'), JSON.stringify({ id: 'x', staged: { root: paths[2] } }));
    const removed = pruneReleases(home, { now });
    assert.deepEqual(removed.sort(), [paths[3]!, staleStaging].sort());
    for (const kept of [...paths.slice(0, 3), ...paths.slice(4), freshStaging, unknown, outside]) assert.equal(existsSync(kept), true, kept);
    writeFileSync(join(home, 'upgrade.json'), '{not json');
    assert.throws(() => pruneReleases(home, { now, keep: 0 }));
    assert.equal(existsSync(paths[4]!), true);
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
