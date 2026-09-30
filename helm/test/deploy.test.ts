import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { actionHash, ensureTapTable, reserveTap, type TapMemory } from '../src/envelope.js';
import { checkEnvelope, envelopePath } from '../src/envelope.js';
import { createDeploy as createDeployImpl, ensureDeployTable, markDeploysInterrupted, type DeployExec } from '../src/deploy.js';
import { runTestFlight } from '../src/testflight.js';
import type { Jev } from '../src/jev.js';
import { loadRepoConfig } from '../src/repoconfig.js';
import type { RepoConfig } from '../src/repoconfig.js';
import { hardenedGitArgs } from '../src/git.js';
import { openStore } from '../src/store.js';
import type { Workspace } from '../src/types.js';

function unHardenedGitArgs(file: string, args: string[]): string[] {
  return file === 'git' && args[0] === '-c' ? args.slice(8).filter((arg) => arg !== '--no-verify') : args;
}

const token = 'deploy-sentinel-token';
const TEST_ENV_FILE = '/definitely-missing/helm-test-env';
const createDeploy = (options: Parameters<typeof createDeployImpl>[0]) => createDeployImpl({ ...options, envFile: TEST_ENV_FILE });
const target = { name: 'prod', kind: 'vercel' as const, env: { VERCEL_TOKEN: 'VERCEL_TOKEN' }, mode: 'cli' as const, smoke: { commands: [{ name: 'smoke', command: 'false' }] }, rollback: 'auto' as const };
type DeployTarget = NonNullable<RepoConfig['deploy']>['targets'][number];

test('daemon startup marks deploying rows failed with an interruption reason', async () => {
  const store = openStore(':memory:');
  try {
    ensureDeployTable(store);
    store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, reason, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('d-restart', 'owner/repo', 'prod', 'vercel', '{}', 'a'.repeat(40), 'deploying', null, null, null, null, '{}', null, new Date().toISOString());
    assert.equal(await markDeploysInterrupted(store), 1);
    const saved = store.sql.prepare('SELECT state, reason FROM deploys WHERE id = ?').get('d-restart') as { state: string; reason: string };
    assert.equal(saved.state, 'failed');
    assert.equal(saved.reason, 'interrupted (daemon restart)');
    assert.equal(await markDeploysInterrupted(store), 0);
  } finally { store.close(); }
});

test('daemon startup preserves current and handover-predecessor deploys until timeout', async () => {
  const store = openStore(':memory:');
  const now = new Date('2026-09-30T00:00:00.000Z');
  try {
    ensureDeployTable(store);
    const insert = store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, bootId, reason, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const add = (id: string, bootId: string, at: string) => insert.run(id, 'owner/repo', 'prod', 'vercel', '{}', 'a'.repeat(40), 'deploying', bootId, null, null, null, null, '{}', null, at);
    add('current', 'boot-current', now.toISOString());
    add('previous', 'boot-previous', now.toISOString());
    add('foreign', 'boot-foreign', now.toISOString());
    add('timed-out', 'boot-current', '2026-09-29T23:00:00.000Z');
    add('predecessor-within-target-timeout', 'boot-previous', '2026-09-29T23:30:00.000Z');
    add('predecessor-past-target-timeout', 'boot-previous', '2026-09-29T22:59:00.000Z');
    assert.equal(await markDeploysInterrupted(store, { currentBootId: 'boot-current', predecessorBootId: 'boot-previous', now, timeoutMs: 1000, timeoutFor: async () => 60 }), 3);
    const states = (store.sql.prepare('SELECT id, state FROM deploys ORDER BY id').all() as Array<{ id: string; state: string }>).map((row) => ({ id: row.id, state: row.state }));
    assert.deepEqual(states, [
      { id: 'current', state: 'deploying' }, { id: 'foreign', state: 'failed' },
      { id: 'predecessor-past-target-timeout', state: 'failed' }, { id: 'predecessor-within-target-timeout', state: 'deploying' },
      { id: 'previous', state: 'deploying' }, { id: 'timed-out', state: 'failed' },
    ]);
  } finally { store.close(); }
});

test('daemon startup falls back to the 60-minute timeout when target lookup fails', async () => {
  const store = openStore(':memory:');
  const now = new Date('2026-09-30T00:00:00.000Z');
  try {
    ensureDeployTable(store);
    const insert = store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, bootId, reason, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const add = (id: string, at: string) => insert.run(id, 'owner/repo', 'prod', 'vercel', '{}', 'a'.repeat(40), 'deploying', 'boot-previous', null, null, null, null, '{}', null, at);
    add('within-default', '2026-09-29T23:01:00.000Z');
    add('past-default', '2026-09-29T22:59:00.000Z');
    assert.equal(await markDeploysInterrupted(store, { predecessorBootId: 'boot-previous', now, timeoutFor: async () => { throw new Error('git show timed out'); } }), 1);
    const states = (store.sql.prepare('SELECT id, state FROM deploys ORDER BY id').all() as Array<{ id: string; state: string }>).map((row) => ({ id: row.id, state: row.state }));
    assert.deepEqual(states, [{ id: 'past-default', state: 'failed' }, { id: 'within-default', state: 'deploying' }]);
  } finally { store.close(); }
});

test('loadRepoConfig passes a bounded timeout to git config lookup', async () => {
  const calls: Array<{ file: string; args: readonly string[]; timeout?: number }> = [];
  const config = await loadRepoConfig('/repo', 'a'.repeat(40), false, {
    timeout: 5_000,
    exec: async (file, args, options) => { calls.push({ file, args, timeout: options.timeout }); return { stdout: '{"gates":[]}' }; },
  });
  assert.deepEqual(config, { gates: [] });
  assert.deepEqual(calls, [{ file: 'git', args: hardenedGitArgs(['show', `${'a'.repeat(40)}:helm.json`]), timeout: 5_000 }]);
});

function repoWithConfig(configTarget: DeployTarget = target): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), 'helm-deploy-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'helm@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Helm Test'], { cwd: repo });
  writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [], deploy: { targets: [configTarget] } }));
  execFileSync('git', ['add', 'helm.json'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'config'], { cwd: repo });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', sha], { cwd: repo });
  return { repo, sha };
}

function workspace(sha: string): Workspace {
  return { async resolveSha() { return sha; }, async defaultBranch() { return 'main'; }, async create() { return { path: '', branch: '', baseSha: sha }; }, async remove() {}, async head() { return sha; }, async isClean() { return true; }, async diffStat() { return ''; }, async patchId() { return ''; }, async commitAll() { return sha; }, async push() {}, async clone() {}, async fetch() {} };
}

function commitConfig(repo: string, target: DeployTarget): string {
  writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [], deploy: { targets: [target] } }));
  execFileSync('git', ['add', 'helm.json'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'config update'], { cwd: repo });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

function deployDeps(repo: string, sha: string, exec: DeployExec, decision: 'allow' | 'tap' = 'allow', env: NodeJS.ProcessEnv = { VERCEL_TOKEN: token, VERCEL_ORG_ID: token, VERCEL_PROJECT_ID: token }, kinds: string[] = []) {
  const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-deploy-home-'));
  const wrapped: DeployExec = async (file, args, options) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[3]!, { recursive: true }); writeFileSync(join(args[3]!, 'Gemfile.lock'), 'GEM'); } return exec(file, args, options); };
  const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: wrapped, env, envFile: TEST_ENV_FILE, now: () => new Date('2026-09-30T00:00:00.000Z') });
  return { service, store, home };
}

const convexTarget = { name: 'prod', kind: 'convex' as const, env: 'CONVEX_DEPLOY_KEY', smoke: { commands: [{ name: 'smoke', command: 'true' }] }, rollback: 'auto' as const };

function convexRepo(configTarget: DeployTarget = convexTarget): { repo: string; oldSha: string; newSha: string } {
  const first = repoWithConfig(configTarget); writeFileSync(join(first.repo, 'package-lock.json'), '{}'); mkdirSync(join(first.repo, 'convex')); writeFileSync(join(first.repo, 'convex', 'schema.ts'), 'export default {};');
  execFileSync('git', ['add', '.'], { cwd: first.repo }); execFileSync('git', ['commit', '-qm', 'convex baseline'], { cwd: first.repo });
  const oldSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: first.repo, encoding: 'utf8' }).trim(); writeFileSync(join(first.repo, 'convex', 'schema.ts'), 'export default { changed: true };');
  execFileSync('git', ['add', '.'], { cwd: first.repo }); execFileSync('git', ['commit', '-qm', 'convex change'], { cwd: first.repo });
  return { repo: first.repo, oldSha, newSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: first.repo, encoding: 'utf8' }).trim() };
}

function convexExec(repo: string, newSha: string, diff: string, calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }>, npx: (count: number) => { stdout: string; stderr?: string; code?: number } = () => ({ stdout: 'deployed' })) {
  let deployCount = 0;
  return async (file: string, args: string[], options: Parameters<DeployExec>[2]) => { args = unHardenedGitArgs(file, args);
    calls.push({ file, args, options });
    if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${newSha}\n`, code: 0 };
    if (file === 'git' && args[0] === 'diff') return { stdout: diff, code: 0 };
    if (file === 'git' && args[0] === 'merge-base') return { stdout: '', code: 0 };
    if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[3]!, { recursive: true }); writeFileSync(join(args[3]!, 'package-lock.json'), '{}'); return { stdout: '', code: 0 }; }
    if (file === 'git' && args[0] === 'worktree' && args[1] === 'remove') { rmSync(args[3]!, { recursive: true, force: true }); return { stdout: '', code: 0 }; }
    if (file === 'npm') return { stdout: '', code: 0 };
    if (file === 'npx') return npx(++deployCount);
    if (file === 'false') return { stdout: token, stderr: token, code: 1 };
    if (file === 'true') return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  };
}

function insertSuccessfulConvex(store: ReturnType<typeof openStore>, sha: string, deploymentId = sha): void {
  ensureDeployTable(store);
  store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'prod', 'convex', 'CONVEX_DEPLOY_KEY', sha, 'succeeded', null, deploymentId, null, '{}', null, '2026-09-29T00:00:00.000Z');
}

test('smoke failure rolls back the previous provider deployment and redacts secrets', async () => {
  const { repo, sha } = repoWithConfig(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = [];
  const exec: DeployExec = async (file, args, options) => { args = unHardenedGitArgs(file, args); calls.push({ file, args, options }); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'vercel' && args[0] === 'deploy') return { stdout: 'https://new.example.invalid\n', code: 0 }; if (file === 'false') return { stdout: token, stderr: token, code: 1 }; return { stdout: '', code: 0 }; };
  const d = deployDeps(repo, sha, exec); ensureDeployTable(d.store);
  d.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'prod', 'vercel', 'prod', sha, 'succeeded', 'https://old.example.invalid', 'previous-provider-id', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try {
    const result = await d.service.run({ project: 'owner/repo', target: 'prod' });
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    assert.deepEqual(calls.find((call) => call.file === 'vercel' && call.args[0] === 'rollback')?.args.slice(0, 2), ['rollback', 'previous-provider-id']);
    const vercelCalls = calls.filter((call) => call.file === 'vercel'); assert.ok(vercelCalls.length > 0); assert.ok(vercelCalls.every((call) => !call.args.includes(token) && call.options.env?.VERCEL_TOKEN === token && call.options.env?.HOME === (process.env.HOME ?? homedir()) && Object.keys(call.options.env ?? {}).sort().join(',') === 'HOME,LANG,LC_ALL,PATH,TMPDIR,VERCEL_ORG_ID,VERCEL_PROJECT_ID,VERCEL_TOKEN'));
    assert.equal((d.store.sql.prepare('SELECT state FROM deploys WHERE id != ? ORDER BY at DESC LIMIT 1').get('old') as { state: string }).state, 'rolledback');
    assert.ok(d.store.listEvents('project:owner/repo').some((event) => event.kind === 'deploy.rolledback'));
  } finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('base Vercel deploy uses linked checkout ids when the token is absent', async () => {
  const config = { ...target, env: { VERCEL_TOKEN: 'VERCEL_TOKEN', VERCEL_ORG_ID: 'VERCEL_ORG_ID', VERCEL_PROJECT_ID: 'VERCEL_PROJECT_ID' }, smoke: {} }; const { repo, sha } = repoWithConfig(config); mkdirSync(join(repo, '.vercel')); writeFileSync(join(repo, '.vercel', 'project.json'), JSON.stringify({ orgId: 'checkout-org', projectId: 'checkout-project' })); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = [];
  const d = deployDeps(repo, sha, async (file, args, options) => { args = unHardenedGitArgs(file, args); calls.push({ file, args, options }); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'vercel') return { stdout: 'https://operator-login.example.invalid\n', code: 0 }; return { stdout: '', code: 0 }; }, 'allow', {});
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, true); const vercel = calls.find((call) => call.file === 'vercel')!; assert.deepEqual(vercel.args, ['deploy', '--prod', '--yes']); assert.equal(vercel.options.env?.HOME, process.env.HOME ?? homedir()); assert.equal(vercel.options.env?.VERCEL_TOKEN, undefined); assert.equal(vercel.options.env?.VERCEL_ORG_ID, 'checkout-org'); assert.equal(vercel.options.env?.VERCEL_PROJECT_ID, 'checkout-project'); assert.equal(Object.keys(vercel.options.env ?? {}).sort().join(','), 'HOME,LANG,LC_ALL,PATH,TMPDIR,VERCEL_ORG_ID,VERCEL_PROJECT_ID'); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('base Vercel deploy refuses an unlinked checkout before the provider CLI runs', async () => {
  const config = { ...target, env: { VERCEL_TOKEN: 'VERCEL_TOKEN', VERCEL_ORG_ID: 'VERCEL_ORG_ID', VERCEL_PROJECT_ID: 'VERCEL_PROJECT_ID' }, smoke: {} }; const { repo, sha } = repoWithConfig(config); const calls: string[] = [];
  const d = deployDeps(repo, sha, async (file, args) => { args = unHardenedGitArgs(file, args); calls.push(file); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; return { stdout: '', code: 0 }; }, 'allow', {});
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.equal(result.reason, `vercel target prod is not linked: set org/project ids or run \`vercel link\` in ${repo}`); assert.equal(calls.includes('vercel'), false); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('base Vercel dev target without scoped credentials is refused before the provider CLI runs', async () => {
  const config = { ...target, name: 'dev', env: 'dev', smoke: {} }; const { repo, sha } = repoWithConfig(config); const calls: string[] = [];
  const d = deployDeps(repo, sha, async (file, args) => { args = unHardenedGitArgs(file, args); calls.push(file); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; return { stdout: '', code: 0 }; }, 'allow', {});
  try { const result = await d.service.run({ project: 'owner/repo', target: 'dev' }); assert.equal(result.ok, false); assert.equal(result.reason, 'branch preview deploys require scoped credentials (VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID)'); assert.equal(calls.includes('vercel'), false); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('base production fallback asks the envelope for deploy.prod', async () => {
  const config = { ...target, name: 'release', env: 'prod', smoke: {} }; const { repo, sha } = repoWithConfig(config); mkdirSync(join(repo, '.vercel')); writeFileSync(join(repo, '.vercel', 'project.json'), JSON.stringify({ orgId: 'checkout-org', projectId: 'checkout-project' })); const kinds: string[] = [];
  const d = deployDeps(repo, sha, async (file, args) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'vercel') return { stdout: 'https://production-fallback.example.invalid\n', code: 0 }; return { stdout: '', code: 0 }; }, 'allow', {}, kinds);
  try { const result = await d.service.run({ project: 'owner/repo', target: 'release' }); assert.equal(result.ok, true); assert.deepEqual(kinds, ['deploy.release', 'deploy.prod']); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('base Convex deploy uses linked checkout deployment while installs and smoke keep temp homes', async () => {
  const c = convexRepo(); writeFileSync(join(c.repo, '.env.local'), 'CONVEX_DEPLOYMENT=dev:checkout-project\n'); writeFileSync(join(c.repo, 'convex', 'index.ts'), 'export default {};'); execFileSync('git', ['add', '.'], { cwd: c.repo }); execFileSync('git', ['commit', '-qm', 'convex code change'], { cwd: c.repo }); const oldSha = c.newSha; const newSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: c.repo, encoding: 'utf8' }).trim(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-login-')); insertSuccessfulConvex(store, oldSha);
  const service = createDeploy({ store, home, workspace: workspace(newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision: 'allow' }] }), reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, newSha, 'convex/index.ts\n', calls), env: {} });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, true); const install = calls.find((call) => call.file === 'npm')!; assert.notEqual(install.options.env?.HOME, process.env.HOME); assert.equal(existsSync(install.options.env!.HOME!), false); assert.deepEqual(Object.keys(install.options.env ?? {}).sort(), ['HOME', 'PATH']); const deploy = calls.find((call) => call.file === 'npx')!; assert.equal(deploy.options.env?.HOME, process.env.HOME ?? homedir()); assert.equal(deploy.options.env?.CONVEX_DEPLOY_KEY, undefined); assert.equal(deploy.options.env?.CONVEX_DEPLOYMENT, 'dev:checkout-project'); assert.deepEqual(Object.keys(deploy.options.env ?? {}).sort(), ['CONVEX_DEPLOYMENT', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']); const smoke = calls.find((call) => call.file === 'true')!; assert.notEqual(smoke.options.env?.HOME, process.env.HOME); assert.equal(existsSync(smoke.options.env!.HOME!), false); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('base Convex deploy refuses an unlinked checkout before the provider CLI runs', async () => {
  const c = convexRepo(); writeFileSync(join(c.repo, 'convex', 'index.ts'), 'export default {};'); execFileSync('git', ['add', '.'], { cwd: c.repo }); execFileSync('git', ['commit', '-qm', 'convex code change'], { cwd: c.repo }); const oldSha = c.newSha; const newSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: c.repo, encoding: 'utf8' }).trim(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-unlinked-')); insertSuccessfulConvex(store, oldSha);
  const service = createDeploy({ store, home, workspace: workspace(newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision: 'allow' }] }), reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, newSha, 'convex/index.ts\n', calls), env: {} });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.equal(result.reason, `convex target prod is not linked: set a deploy key or run \`npx convex dev\` once in ${c.repo}`); assert.equal(calls.some((call) => call.file === 'npx'), false); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('non-base preview without scoped credentials is refused before the provider CLI runs', async () => {
  const config = { ...target, name: 'preview', env: 'preview', smoke: {} }; const fixture = repoWithConfig(config); execFileSync('git', ['checkout', '-qb', 'deploy-sha'], { cwd: fixture.repo }); const sha = commitConfig(fixture.repo, { ...config, rollback: 'manual' }); const calls: string[] = []; const d = deployDeps(fixture.repo, sha, async (file, args) => { args = unHardenedGitArgs(file, args); calls.push(file); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'git' && args[0] === 'merge-base') return { stdout: '', code: 1 }; return { stdout: '', code: 0 }; }, 'allow', {});
  try { const result = await d.service.run({ project: 'owner/repo', target: 'preview', sha }); assert.equal(result.ok, false); assert.equal(result.reason, 'branch preview deploys require scoped credentials (VERCEL_TOKEN, VERCEL_ORG_ID, VERCEL_PROJECT_ID)'); assert.equal(calls.includes('vercel'), false); }
  finally { d.store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('non-base production SHA is refused before the adapter runs', async () => {
  const { repo, sha } = repoWithConfig(); const calls: string[] = [];
  const d = deployDeps(repo, sha, async (file, args) => { args = unHardenedGitArgs(file, args); calls.push(file); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'git' && args[0] === 'fetch') return { stdout: '', code: 0 }; return { stdout: '', code: file === 'git' ? 1 : 0 }; });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod', sha }); assert.equal(result.ok, false); assert.match(result.reason, /not on base branch/); assert.deepEqual(calls, ['git', 'git', 'git']); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('deployment configuration comes from the requested SHA, not the dirty worktree', async () => {
  const first = repoWithConfig({ ...target, name: 'old' }); writeFileSync(join(first.repo, 'helm.json'), JSON.stringify({ gates: [], deploy: { targets: [{ ...target, name: 'new' }] } }));
  const d = deployDeps(first.repo, first.sha, async (file, args) => file === 'git' && unHardenedGitArgs(file, args)[0] === 'rev-parse' ? { stdout: `${first.sha}\n`, code: 0 } : file === 'git' && unHardenedGitArgs(file, args)[0] === 'merge-base' ? { stdout: '', code: 0 } : { stdout: 'https://old.example.invalid\n', code: 0 });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'old' }); assert.equal(result.ok, true); }
  finally { d.store.close(); rmSync(first.repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('a granted tap is reserved, committed once, and bound to the envelope kind', async () => {
  const { repo, sha } = repoWithConfig(); const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-deploy-tap-')); const taps = new Map<string, TapMemory>(); ensureTapTable(store); const id = 't-deploy'; const action = `deploy.run:owner/repo:prod:${sha}`; let resolved = 0; const actions: string[] = [];
  taps.set(id, { project: 'owner/repo', kind: 'deploy.prod', actionHash: actionHash(action), codeMac: '', attempts: 0, expiresAt: '2099-01-01T00:00:00.000Z', state: 'granted' }); store.sql.prepare('INSERT INTO taps (id, project, kind, action, actionHash, codeHash, state, attempts, requestedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'owner/repo', 'deploy.prod', action, actionHash(action), '', 'granted', 0, '2026-09-30T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo, slug: 'owner/repo' }), envelope: async ({ actions: currentActions }) => { actions.push(...currentActions); return { ok: true, decisions: [{ decision: 'tap' }] }; }, reserveTap: (project, kind, currentAction, tapId) => reserveTap(store, taps, project, kind, actionHash(currentAction), tapId), commitTap: (reservation) => { store.sql.prepare("UPDATE taps SET state='used' WHERE id=?").run(reservation.tapId); taps.delete(reservation.tapId); }, rollbackTap() {}, exec: async (file, args) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') { resolved += 1; return { stdout: `${sha}\n`, code: 0 }; } return file === 'vercel' && args[0] === 'deploy' ? { stdout: 'https://tap.example.invalid\n', code: 0 } : { stdout: '', code: 0 }; }, env: { VERCEL_TOKEN: token, VERCEL_ORG_ID: token, VERCEL_PROJECT_ID: token }, envFile: TEST_ENV_FILE });
  try { const refused = await service.run({ project: 'owner/repo', target: 'prod', sha: 'main' }); assert.equal(refused.ok, false); assert.match(refused.reason, /deploy\.prod/); const success = await service.run({ project: 'owner/repo', target: 'prod', sha: 'main', tapId: id }); assert.equal(success.ok, true); assert.equal(resolved, 2); assert.deepEqual(actions, [action, action]); assert.equal((store.sql.prepare('SELECT state FROM taps WHERE id=?').get(id) as { state: string }).state, 'used'); }
  finally { store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('smoke runs in the deploy worktree with no credentials and refuses sh -c', async () => {
  const config = { ...target, smoke: { commands: [{ name: 'env', command: 'printenv HELM_DEPLOY_URL' }] } }; const { repo, sha } = repoWithConfig(config); let smokeOptions: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
  const d = deployDeps(repo, sha, async (file, args, options) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'printenv') { smokeOptions = options; return { stdout: token, code: 0 }; } if (file === 'vercel') return { stdout: 'https://smoke.example.invalid\n', code: 0 }; return { stdout: '', code: 0 }; });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, true); assert.ok(smokeOptions?.cwd?.includes('/deploys/owner__repo/')); assert.deepEqual(Object.keys(smokeOptions?.env ?? {}).sort(), ['HELM_DEPLOY_URL', 'HOME', 'PATH']); assert.equal(JSON.stringify(smokeOptions?.env).includes(token), false); assert.ok(smokeOptions?.env?.HOME); assert.equal(existsSync(smokeOptions!.env!.HOME!), false); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }

  const shellConfig = { ...target, smoke: { commands: [{ name: 'shell', command: 'sh -c echo' }] } }; const shellRepo = repoWithConfig(shellConfig); const shell = deployDeps(shellRepo.repo, shellRepo.sha, async (file, args) => file === 'git' && unHardenedGitArgs(file, args)[0] === 'rev-parse' ? { stdout: `${shellRepo.sha}\n`, code: 0 } : file === 'vercel' ? { stdout: 'https://shell.example.invalid\n', code: 0 } : { stdout: '', code: 0 });
  try { const result = await shell.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.match(result.reason, /shell/); }
  finally { shell.store.close(); rmSync(shellRepo.repo, { recursive: true, force: true }); rmSync(shell.home, { recursive: true, force: true }); }
});

test('a preview on a non-base SHA uses the base branch smoke config', async () => {
  const base = { ...target, name: 'preview', env: 'preview', smoke: { commands: [{ name: 'base', command: 'base-smoke' }], http: [{ path: '/health', status: 200 }] } }; const fixture = repoWithConfig(base); execFileSync('git', ['checkout', '-qb', 'deploy-sha'], { cwd: fixture.repo }); const sha = commitConfig(fixture.repo, { ...base, smoke: { commands: [{ name: 'sha', command: 'sha-smoke' }], http: [{ path: '/sha', status: 200 }] } }); const commands: string[] = []; const paths: string[] = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-deploy-base-smoke-'));
  const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo: fixture.repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision: 'allow' }] }), reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'git' && args[0] === 'merge-base') return { stdout: '', code: 1 }; if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[3]!, { recursive: true }); return { stdout: '', code: 0 }; } if (file === 'git' && args[0] === 'worktree' && args[1] === 'remove') return { stdout: '', code: 0 }; if (file === 'vercel') return { stdout: 'https://preview.example.invalid\n', code: 0 }; if (file === 'base-smoke' || file === 'sha-smoke') { commands.push(file); return { stdout: '', code: 0 }; } return { stdout: '', code: 0 }; }, fetch: async (url) => { paths.push(new URL(String(url)).pathname); return new Response('ok', { status: 200 }); }, env: { VERCEL_TOKEN: token, VERCEL_ORG_ID: token, VERCEL_PROJECT_ID: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'preview', sha }); assert.equal(result.ok, true); assert.deepEqual(commands, ['base-smoke']); assert.deepEqual(paths, ['/health']); }
  finally { store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('a non-base preview uses the entire base target definition', async () => {
  const base = { ...target, name: 'preview', env: { VERCEL_TOKEN: 'BASE_TOKEN', VERCEL_ORG_ID: 'BASE_ORG', VERCEL_PROJECT_ID: 'BASE_PROJECT' }, mode: 'cli' as const, smoke: { commands: [{ name: 'base', command: 'base-smoke' }] }, rollback: 'manual' as const, migrationGlobs: ['base/**'] };
  const branch = { ...base, kind: 'convex' as const, env: 'BRANCH_SECRET', mode: 'git' as const, smoke: { commands: [{ name: 'branch', command: 'branch-smoke' }] }, rollback: 'none' as const, migrationGlobs: ['branch/**'] };
  const fixture = repoWithConfig(base); execFileSync('git', ['checkout', '-qb', 'deploy-sha'], { cwd: fixture.repo }); const sha = commitConfig(fixture.repo, branch); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-deploy-base-target-'));
  const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo: fixture.repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision: 'allow' }] }), reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args, options) => { args = unHardenedGitArgs(file, args); calls.push({ file, args, options }); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'git' && args[0] === 'merge-base') return { stdout: '', code: 1 }; if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[3]!, { recursive: true }); return { stdout: '', code: 0 }; } if (file === 'vercel') return { stdout: 'https://base-target.example.invalid\n', code: 0 }; if (file === 'base-smoke') return { stdout: '', code: 0 }; return { stdout: '', code: 0 }; }, env: { BASE_TOKEN: 'base-token', BASE_ORG: 'base-org', BASE_PROJECT: 'base-project' } });
  try { const result = await service.run({ project: 'owner/repo', target: 'preview', sha }); assert.equal(result.ok, true); assert.equal(result.deploy.kind, 'vercel'); assert.equal(result.deploy.env, JSON.stringify(base.env)); const vercel = calls.find((call) => call.file === 'vercel')!; assert.deepEqual(vercel.args, ['deploy', '--yes']); assert.equal(vercel.options.env?.VERCEL_TOKEN, 'base-token'); assert.equal(vercel.options.env?.BRANCH_SECRET, undefined); assert.equal(calls.some((call) => call.file === 'branch-smoke'), false); }
  finally { store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('a failed base fetch refuses with a stale base ref', async () => {
  const fixture = repoWithConfig({ ...target, smoke: {} }); const calls: string[][] = []; const d = deployDeps(fixture.repo, fixture.sha, async (file, args) => { args = unHardenedGitArgs(file, args); calls.push([file, ...args]); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${fixture.sha}\n`, code: 0 }; if (file === 'git' && args[0] === 'fetch') return { stdout: '', stderr: 'network unavailable', code: 1 }; return { stdout: '', code: 0 }; });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.equal(result.reason, 'base ref stale'); assert.ok(calls.some((call) => call.join(' ') === 'git fetch origin main')); }
  finally { d.store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('tap commit failure leaves the healthy deploy succeeded and emits an error', async () => {
  const config = { ...target, smoke: {} }; const { repo, sha } = repoWithConfig(config); const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-tap-commit-')); let rolledBack = false; const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision: 'tap' }] }), reserveTap: () => ({ tapId: 'tap-1', token: 'reservation' }), commitTap: () => { throw new Error('tap store unavailable'); }, rollbackTap: () => { rolledBack = true; }, exec: async (file, args) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'vercel') return { stdout: 'https://tap-commit.example.invalid\n', code: 0 }; return { stdout: '', code: 0 }; }, env: { VERCEL_TOKEN: token, VERCEL_ORG_ID: token, VERCEL_PROJECT_ID: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod', tapId: 'tap-1' }); assert.equal(result.ok, true); assert.match(result.warning ?? '', /tap commit failed/); assert.equal(rolledBack, false); assert.equal((store.sql.prepare("SELECT state FROM deploys WHERE state != 'succeeded'").get() as unknown), undefined); assert.equal(store.listEvents('project:owner/repo').some((event) => event.kind === 'error' && event.data.operation === 'tap commit'), true); }
  finally { store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('rollback refuses deployments that are not succeeded or live', async () => {
  const { repo, sha } = repoWithConfig({ ...target, smoke: {} }); const d = deployDeps(repo, sha, async (file) => file === 'git' ? { stdout: `${sha}\n`, code: 0 } : { stdout: '', code: 0 }); d.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('failed', 'owner/repo', 'prod', 'vercel', 'prod', sha, 'failed', null, 'current', 'previous', '{}', null, '2026-09-30T00:00:00.000Z');
  try { const result = await d.service.rollback({ id: 'failed' }); assert.equal(result.ok, false); assert.equal(result.reason, 'deployment is not in a succeeded or live state'); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('concurrent deploy and rollback operations for a target are refused', async () => {
  const { repo, sha } = repoWithConfig({ ...target, smoke: {} }); const home = mkdtempSync(join(tmpdir(), 'helm-deploy-lock-')); const store = openStore(':memory:'); let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; }); let started!: () => void; const startedPromise = new Promise<void>((resolve) => { started = resolve; }); const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision: 'allow' }] }), reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'vercel' && args[0] === 'deploy') { started(); await blocked; return { stdout: 'https://locked.example.invalid\n', code: 0 }; } return { stdout: '', code: 0 }; }, env: { VERCEL_TOKEN: token, VERCEL_ORG_ID: token, VERCEL_PROJECT_ID: token } });
  store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'prod', 'vercel', 'prod', sha, 'succeeded', 'https://old.example.invalid', 'current', 'previous', '{}', null, '2026-09-29T00:00:00.000Z');
  try { const first = service.run({ project: 'owner/repo', target: 'prod' }); await startedPromise; const second = await service.rollback({ id: 'old' }); assert.equal(second.ok, false); assert.equal(second.reason, 'deploy in progress'); release(); assert.equal((await first).ok, true); }
  finally { store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('invalid HTTP smoke paths are rejected while loading helm.json', async () => {
  for (const path of ['health', '//evil', '/..%2Fsecret', '/\\evil.example', 'https://evil.example.invalid']) { const fixture = repoWithConfig({ ...target, smoke: { http: [{ path, status: 200 }] } }); try { await assert.rejects(() => loadRepoConfig(fixture.repo, fixture.sha, false), /HTTP smoke path/); } finally { rmSync(fixture.repo, { recursive: true, force: true }); } }
});

test('adapter failure keeps the original reason and does not roll back', async () => {
  const { repo, sha } = repoWithConfig(); const calls: string[] = []; const d = deployDeps(repo, sha, async (file, args) => { args = unHardenedGitArgs(file, args); calls.push(`${file}:${args[0] ?? ''}`); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'vercel' && args[0] === 'deploy') return { stdout: '', stderr: 'adapter failed', code: 1 }; return { stdout: '', code: 0 }; });
  d.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'prod', 'vercel', 'prod', sha, 'succeeded', 'https://old.example.invalid', 'previous-provider-id', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.equal(result.reason, 'adapter failed'); assert.equal(calls.some((call) => call === 'vercel:rollback'), false); const event = d.store.listEvents('project:owner/repo').find((entry) => entry.kind === 'deploy.failed'); assert.deepEqual(event?.data, { project: 'owner/repo', id: event?.data.id, target: 'prod', kind: 'vercel', reason: 'adapter failed' }); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('git mode uses the successful deployment status environment URL', async () => {
  const config = { ...target, mode: 'git' as const }; const { repo, sha } = repoWithConfig(config); const d = deployDeps(repo, sha, async (file, args) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'gh' && args[1]?.includes('/statuses')) return { stdout: JSON.stringify([{ state: 'success', environment_url: 'https://environment.example.invalid', target_url: 'https://target.example.invalid' }]), code: 0 }; if (file === 'gh') return { stdout: JSON.stringify([{ id: 42, url: 'https://api.example.invalid' }]), code: 0 }; return { stdout: '', code: 0 }; });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, true); assert.equal(result.deploy.url, 'https://environment.example.invalid'); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('git and gh control calls keep the daemon HOME while provider adapters use a temp HOME', async () => {
  const gitFixture = repoWithConfig({ ...target, mode: 'git' as const }); const gitCalls: Array<{ file: string; options: Parameters<DeployExec>[2] }> = []; const gitDeploy = deployDeps(gitFixture.repo, gitFixture.sha, async (file, args, options) => { args = unHardenedGitArgs(file, args); gitCalls.push({ file, options }); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${gitFixture.sha}\n`, code: 0 }; if (file === 'gh' && args[1]?.includes('/statuses')) return { stdout: JSON.stringify([{ state: 'success', environment_url: 'https://environment.example.invalid' }]), code: 0 }; if (file === 'gh') return { stdout: JSON.stringify([{ id: 42 }]), code: 0 }; return { stdout: '', code: 0 }; });
  try { const result = await gitDeploy.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, true); assert.ok(gitCalls.filter((call) => call.file === 'git' || call.file === 'gh').every((call) => call.options.env?.HOME === process.env.HOME)); }
  finally { gitDeploy.store.close(); rmSync(gitFixture.repo, { recursive: true, force: true }); rmSync(gitDeploy.home, { recursive: true, force: true }); }
});

test('TestFlight records the fastlane build number and keeps credentials out of argv', async () => {
  const config = { name: 'beta', kind: 'testflight' as const, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, lane: 'internal', smoke: {}, rollback: 'none' as const }; const { repo, sha } = repoWithConfig(config); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = [];
  const d = deployDeps(repo, sha, async (file, args, options) => { args = unHardenedGitArgs(file, args); calls.push({ file, args, options }); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'bundle') return { stdout: 'HELM_BUILD_NUMBER=42\n', code: 0 }; return { stdout: '', code: 0 }; }, 'allow', { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, true); assert.equal(result.deploy.deploymentId, '42'); assert.deepEqual(calls.filter((call) => call.file === 'bundle').map((call) => call.args), [['install', '--deployment'], ['exec', 'fastlane', 'internal']]); const install = calls.find((call) => call.args[0] === 'install')!; assert.equal(install.options.env?.APP_STORE_CONNECT_API_KEY_PATH, '/tmp/key.json'); assert.equal(install.options.env?.MATCH_PASSWORD, 'match-password'); assert.equal(install.options.env?.HOME, process.env.HOME ?? homedir()); assert.equal(install.options.env?.LANG, 'en_US.UTF-8'); assert.equal(install.options.env?.LC_ALL, 'en_US.UTF-8'); assert.equal(install.options.env?.TMPDIR, process.env.TMPDIR ?? tmpdir()); assert.equal(Object.keys(install.options.env ?? {}).sort().join(','), 'APP_STORE_CONNECT_API_KEY_PATH,HOME,LANG,LC_ALL,MATCH_PASSWORD,PATH,TMPDIR'); assert.ok(install.options.cwd?.includes('/deploys/owner__repo/')); const fastlane = calls.find((call) => call.args[1] === 'fastlane')!; assert.equal(fastlane.options.env?.APP_STORE_CONNECT_API_KEY_PATH, '/tmp/key.json'); assert.equal(fastlane.options.env?.MATCH_PASSWORD, 'match-password'); assert.equal(fastlane.options.env?.HOME, process.env.HOME ?? homedir()); assert.equal(fastlane.options.env?.LANG, 'en_US.UTF-8'); assert.equal(fastlane.options.env?.LC_ALL, 'en_US.UTF-8'); assert.equal(fastlane.options.env?.TMPDIR, process.env.TMPDIR ?? tmpdir()); assert.equal(Object.keys(fastlane.options.env ?? {}).sort().join(','), 'APP_STORE_CONNECT_API_KEY_PATH,HOME,LANG,LC_ALL,MATCH_PASSWORD,PATH,TMPDIR'); assert.ok(fastlane.args.every((arg) => !arg.includes('password') && !arg.includes('key.json'))); const event = d.store.listEvents('project:owner/repo').find((entry) => entry.kind === 'deploy'); assert.equal(event?.data.deploymentId, '42'); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('TestFlight failure stores and emits only a redacted last-40-line tail', async () => {
  const config = { name: 'beta', kind: 'testflight' as const, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const { repo, sha } = repoWithConfig(config); const secret = 'fastlane-secret';
  const log = Array.from({ length: 50 }, (_, index) => index === 45 ? secret : `line-${index + 1}`).join('\n'); const d = deployDeps(repo, sha, async (file, args) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'bundle') return { stdout: log, code: 1 }; return { stdout: '', code: 0 }; }, 'allow', { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: secret });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, false); assert.doesNotMatch(result.reason, new RegExp(secret)); const saved = d.store.sql.prepare("SELECT state, smoke FROM deploys WHERE target = 'beta'").get() as { state: string; smoke: string }; assert.equal(saved.state, 'failed'); assert.doesNotMatch(saved.smoke, new RegExp(secret)); assert.match(saved.smoke, /line-50/); const event = d.store.listEvents('project:owner/repo').find((entry) => entry.kind === 'deploy.failed'); assert.doesNotMatch(JSON.stringify(event?.data), new RegExp(secret)); assert.match(String(event?.data.reason), /line-50/); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('external TestFlight distribution requires the testflight.external tap', async () => {
  const config = { name: 'external', kind: 'testflight' as const, external: true, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const { repo, sha } = repoWithConfig(config); let envelopeKind = '';
  const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-testflight-tap-')); const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { envelopeKind = kind; return { ok: true, decisions: [{ decision: 'tap' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args) => file === 'git' && unHardenedGitArgs(file, args)[0] === 'rev-parse' ? { stdout: `${sha}\n`, code: 0 } : { stdout: '', code: 0 }, env: { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' } });
  try { const result = await service.run({ project: 'owner/repo', target: 'external' }); assert.equal(result.ok, false); assert.match(result.reason, /tap required for testflight\.external/); assert.equal(envelopeKind, 'testflight.external'); }
  finally { store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('deploy envelope keeps target modes while adding the real external tap check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-envelope-real-')); const path = envelopePath(root, 'owner/repo'); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify({ rules: [], budget: { maxSprintUsd: 1, maxSprintCodexTokens: 1 }, deploy: { prod: 'tap', preview: 'auto', blocked: 'never' }, tapOnly: [] }));
  const jev: Jev = { shadow: false, async ask(_purpose, input) { return { ok: true, answers: Object.fromEntries(Object.keys(input.questions).map((key) => [key, { noul: false }])) }; } };
  try { const one = async (kind: string) => (await checkEnvelope(root, { project: 'owner/repo', actions: ['deploy it'], kind }, { jev, envelopeTapAt: 0.5, defaultBranch: 'main' }))[0]!; assert.equal((await one('deploy.blocked')).decision, 'never'); assert.equal((await one('deploy.preview')).decision, 'allow'); assert.equal((await one('deploy.prod')).decision, 'tap'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('TestFlight deploys require a base-branch SHA', async () => {
  const base = { name: 'beta', kind: 'testflight' as const, lane: 'base_lane', external: false, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const fixture = repoWithConfig(base); execFileSync('git', ['checkout', '-qb', 'deploy-sha'], { cwd: fixture.repo }); const sha = commitConfig(fixture.repo, { ...base, lane: 'sha_lane', external: true }); const kinds: string[] = [];
  const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-testflight-base-')); const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo: fixture.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args) => file === 'git' && unHardenedGitArgs(file, args)[0] === 'rev-parse' ? { stdout: `${sha}\n`, code: 0 } : file === 'git' && unHardenedGitArgs(file, args)[0] === 'merge-base' ? { stdout: '', code: 1 } : { stdout: '', code: 0 }, env: { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' } });
  try { const result = await service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, false); assert.equal(result.reason, 'testflight deploys require a base-branch sha'); assert.deepEqual(kinds, []); }
  finally { store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('TestFlight toolchain changes since the last deploy require the external tap', async () => {
  const base = { name: 'beta', kind: 'testflight' as const, lane: 'base-lane', external: false, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const fixture = repoWithConfig(base); execFileSync('git', ['checkout', '-qb', 'deploy-sha'], { cwd: fixture.repo }); const sha = commitConfig(fixture.repo, { ...base, lane: 'new-lane' }); const kinds: string[] = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-testflight-diff-')); const actionSha = fixture.sha;
  const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo: fixture.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: kind === 'testflight.external' ? 'tap' : 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'git' && args[0] === 'diff') return { stdout: 'fastlane/Fastfile\n', code: 0 }; return { stdout: '', code: 0 }; }, env: { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' } });
  store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'beta', 'testflight', 'beta', actionSha, 'succeeded', null, '6', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try { const result = await service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, false); assert.match(result.reason, /tap required for testflight\.external/); assert.deepEqual(kinds, ['deploy.beta', 'testflight.external']); }
  finally { store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('a target only defined on a non-base branch is refused', async () => {
  const base = { name: 'other', kind: 'testflight' as const, lane: 'base-lane', external: false, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const deployed = { ...base, name: 'beta' }; const fixture = repoWithConfig(base); execFileSync('git', ['checkout', '-qb', 'deploy-sha'], { cwd: fixture.repo }); const sha = commitConfig(fixture.repo, deployed); const kinds: string[] = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-testflight-base-missing-')); const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo: fixture.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: kind === 'testflight.external' ? 'tap' : 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args) => file === 'git' && unHardenedGitArgs(file, args)[0] === 'rev-parse' ? { stdout: `${sha}\n`, code: 0 } : file === 'git' && unHardenedGitArgs(file, args)[0] === 'merge-base' ? { stdout: '', code: 1 } : { stdout: '', code: 0 }, env: { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' } });
  store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'beta', 'testflight', 'beta', fixture.sha, 'succeeded', null, '6', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try { const result = await service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, false); assert.equal(result.reason, 'target not defined on base'); assert.deepEqual(kinds, []); }
  finally { store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('TestFlight accepts only explicit build markers and applies timeoutMin', async () => {
  const logs = ['Building MyApp for iOS 18.0 (build 42)', 'increment_build_number: 2026-09-30 12:34:56 +0000'];
  for (const log of logs) { const worktree = mkdtempSync(join(tmpdir(), 'helm-testflight-run-')); writeFileSync(join(worktree, 'Gemfile.lock'), 'GEM'); try { const result = await runTestFlight({}, worktree, async () => ({ stdout: log, code: 0 }), {}, String); assert.equal(result.deploymentId, null); } finally { rmSync(worktree, { recursive: true, force: true }); } }
  const missing = mkdtempSync(join(tmpdir(), 'helm-testflight-missing-')); try { await assert.rejects(() => runTestFlight({}, missing, async () => { throw new Error('exec should not run'); }, {}, String), /Gemfile.lock/); } finally { rmSync(missing, { recursive: true, force: true }); }
  let timeout = 0; let laneCalls = 0; const worktree = mkdtempSync(join(tmpdir(), 'helm-testflight-lane-')); writeFileSync(join(worktree, 'Gemfile.lock'), 'GEM'); try { const result = await runTestFlight({ platform: 'ios', lane: 'beta', timeoutMin: 2 }, worktree, async (_file, args, options) => { if (args[0] === 'install') { assert.equal(options.env?.APP_STORE_CONNECT_API_KEY_PATH, 'secret'); assert.equal(options.env?.MATCH_PASSWORD, 'secret'); return { stdout: '', code: 0 }; } laneCalls += 1; timeout = options.timeout ?? 0; assert.deepEqual(args, ['exec', 'fastlane', 'ios', 'beta']); return { stdout: 'HELM_BUILD_NUMBER=42', code: 0 }; }, { APP_STORE_CONNECT_API_KEY_PATH: 'secret', MATCH_PASSWORD: 'secret' }, String); assert.equal(result.deploymentId, '42'); assert.equal(timeout, 120_000); assert.equal(laneCalls, 1); } finally { rmSync(worktree, { recursive: true, force: true }); }
  const invalid = mkdtempSync(join(tmpdir(), 'helm-testflight-invalid-')); writeFileSync(join(invalid, 'Gemfile.lock'), 'GEM'); try { await assert.rejects(() => runTestFlight({ platform: 'iOS' }, invalid, async () => ({ stdout: '', code: 0 }), {}, String), /platform/); await assert.rejects(() => runTestFlight({ lane: 'beta-release' }, invalid, async () => ({ stdout: '', code: 0 }), {}, String), /lane/); } finally { rmSync(invalid, { recursive: true, force: true }); }
});

test('TestFlight ignores configured rollback and returns a warning', async () => {
  const config = { name: 'beta', kind: 'testflight' as const, external: false, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'auto' as const }; const { repo, sha } = repoWithConfig(config); const d = deployDeps(repo, sha, async (file, args) => { args = unHardenedGitArgs(file, args); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'bundle' && args[0] === 'exec') return { stdout: 'HELM_BUILD_NUMBER=8', code: 0 }; return { stdout: '', code: 0 }; }, 'allow', { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' });
  d.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'beta', 'testflight', 'beta', sha, 'succeeded', null, '7', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try { const result = await d.service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, true); assert.match(result.warning ?? '', /rollback is disabled/); } finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('Convex production schema diff is refused without a migration tap and names both SHAs', async () => {
  const c = convexRepo(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-refused-')); insertSuccessfulConvex(store, c.oldSha);
  const kinds: string[] = []; const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'convex/schema.ts\n', calls), env: { CONVEX_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.match(result.reason, /convex\.migration/); assert.deepEqual(kinds, ['deploy.prod', 'convex.migration']); assert.equal(calls.some((call) => call.file === 'npx'), false); assert.doesNotMatch(JSON.stringify(result), new RegExp(token)); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('Convex migration checks both envelope kinds and consumes one granted tap', async () => {
  const c = convexRepo(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-tap-')); insertSuccessfulConvex(store, c.oldSha); const actions: string[] = []; let committed = 0;
  const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async ({ kind, actions: currentActions }) => { actions.push(`${kind}:${currentActions[0]}`); return { ok: true, decisions: [{ decision: 'allow' }] }; }, reserveTap: (project, kind, action, tapId) => { assert.equal(kind, 'convex.migration'); assert.equal(tapId, 'tap-1'); assert.match(action, new RegExp(`${c.oldSha}:${c.newSha}$`)); return { tapId: tapId!, token: 'reservation' }; }, commitTap: () => { committed += 1; }, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'convex/schema.ts\n', calls), env: { CONVEX_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod', tapId: 'tap-1' }); assert.equal(result.ok, true); assert.equal(committed, 1); assert.deepEqual(calls.filter((call) => call.file === 'npm').map((call) => call.args), [['ci']]); assert.deepEqual(calls.filter((call) => call.file === 'npx').map((call) => call.args), [['--no-install', 'convex', 'deploy', '--yes']]); const install = calls.find((call) => call.file === 'npm')!; assert.ok(install.options.cwd?.includes('/deploys/owner__repo/')); assert.notEqual(install.options.env?.HOME, process.env.HOME); assert.equal(existsSync(install.options.env!.HOME!), false); assert.deepEqual(Object.keys(install.options.env ?? {}).sort(), ['HOME', 'PATH']); const deploy = calls.find((call) => call.file === 'npx')!; assert.equal(deploy.options.env?.HOME, process.env.HOME ?? homedir()); assert.equal(Object.keys(deploy.options.env ?? {}).sort().join(','), 'CONVEX_DEPLOY_KEY,HOME,LANG,LC_ALL,PATH,TMPDIR'); assert.ok(actions.every((action) => action.includes(c.oldSha) && action.includes(c.newSha))); assert.ok(!JSON.stringify(install.options.env).includes(token)); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('staging Convex migrations require a migration tap even with a scoped deploy key', async () => {
  const c = convexRepo({ ...convexTarget, name: 'staging', env: 'CONVEX_STAGING_DEPLOY_KEY' }); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-staging-tap-')); insertSuccessfulConvex(store, c.oldSha); const kinds: string[] = [];
  const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'convex/schema.ts\n', calls), env: { CONVEX_STAGING_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'staging' }); assert.equal(result.ok, false); assert.match(result.reason, /convex\.migration/); assert.deepEqual(kinds, ['deploy.staging', 'convex.migration']); assert.equal(calls.some((call) => call.file === 'npx'), false); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('Convex production fallback makes migration a hard prod tap', async () => {
  const c = convexRepo({ ...convexTarget, name: 'release', env: 'prod' }); writeFileSync(join(c.repo, '.env.local'), 'CONVEX_DEPLOYMENT=prod:checkout-project\n'); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-prod-fallback-')); insertSuccessfulConvex(store, c.oldSha); const kinds: string[] = [];
  const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'convex/schema.ts\n', calls), env: {} });
  try { const result = await service.run({ project: 'owner/repo', target: 'release' }); assert.equal(result.ok, false); assert.equal(result.reason?.startsWith('tap required for convex.migration:'), true); assert.deepEqual(kinds, ['deploy.release', 'deploy.prod', 'convex.migration']); assert.equal(calls.some((call) => call.file === 'npx'), false); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('a target never decision cannot be overridden by a migration tap', async () => {
  const c = convexRepo(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-never-')); insertSuccessfulConvex(store, c.oldSha); const kinds: string[] = [];
  const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: kind === 'deploy.prod' ? 'never' : 'tap' }] }; }, reserveTap: () => ({ tapId: 'tap-1', token: 'reservation' }), commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'convex/schema.ts\n', calls), env: { CONVEX_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod', tapId: 'tap-1' }); assert.equal(result.ok, false); assert.match(result.reason, /deploy\.prod/); assert.equal(calls.some((call) => call.file === 'npx'), false); assert.deepEqual(kinds, ['deploy.prod', 'convex.migration']); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('Convex code-only smoke failure redeploys the previous SHA through the local binary', async () => {
  const c = convexRepo({ ...convexTarget, smoke: { commands: [{ name: 'smoke', command: 'false' }] } }); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-rollback-')); insertSuccessfulConvex(store, c.oldSha);
  const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision: 'allow' }] }), reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'src/index.ts\n', calls, (count) => count === 1 ? { stdout: 'deployed' } : { stdout: 'redeployed' }), env: { CONVEX_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.equal(calls.filter((call) => call.file === 'npx').length, 2); assert.equal(calls.filter((call) => call.file === 'npm').length, 2); assert.ok(calls.some((call) => call.file === 'git' && call.args[0] === 'worktree' && call.args.includes(c.oldSha))); assert.equal((store.sql.prepare("SELECT state FROM deploys WHERE state != 'succeeded'").get() as { state: string }).state, 'rolledback'); assert.doesNotMatch(JSON.stringify(store.listEvents('project:owner/repo')), new RegExp(token)); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('Convex schema-diff failure is manual, emits deploy.failed, and never rolls back', async () => {
  const c = convexRepo({ ...convexTarget, smoke: { commands: [{ name: 'smoke', command: 'false' }] } }); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-manual-')); insertSuccessfulConvex(store, c.oldSha);
  const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision: 'allow' }] }), reserveTap: () => ({ tapId: 'tap-1', token: 'reservation' }), commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'convex/schema.ts\n', calls), env: { CONVEX_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod', tapId: 'tap-1' }); assert.equal(result.ok, false); const originalReason = 'smoke command failed: smoke: [REDACTED][REDACTED]'; assert.equal(result.reason, originalReason); const deploy = store.sql.prepare("SELECT state, smoke FROM deploys WHERE state != 'succeeded'").get() as { state: string; smoke: string }; assert.equal(deploy.state, 'manual'); assert.deepEqual(JSON.parse(deploy.smoke), { error: originalReason, rollback: 'manual (schema change)' }); assert.equal(calls.filter((call) => call.file === 'npx').length, 1); const event = store.listEvents('project:owner/repo').find((entry) => entry.kind === 'deploy.failed'); assert.equal(event?.data.reason, originalReason); assert.equal(event?.data.rollback, 'manual (schema change)'); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('no previous successful Convex deploy is classified as a migration', async () => {
  const c = convexRepo(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-first-')); const kinds: string[] = [];
  const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'src/index.ts\n', calls), env: { CONVEX_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.match(result.reason, /convex\.migration/); assert.deepEqual(kinds, ['deploy.prod', 'convex.migration']); assert.equal(calls.some((call) => call.file === 'npx'), false); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('migration globs come from the previous config and can only add to defaults', async () => {
  const c = convexRepo({ ...convexTarget, migrationGlobs: ['convex/legacy/**'] }); writeFileSync(join(c.repo, 'helm.json'), JSON.stringify({ gates: [], deploy: { targets: [{ ...convexTarget, migrationGlobs: ['src/generated/**'] }] } })); execFileSync('git', ['add', 'helm.json'], { cwd: c.repo }); execFileSync('git', ['commit', '-qm', 'attempt to narrow migration globs'], { cwd: c.repo }); c.newSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: c.repo, encoding: 'utf8' }).trim(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-globs-')); insertSuccessfulConvex(store, c.oldSha);
  const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision: 'allow' }] }), reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'convex/legacy/change.ts\n', calls), env: { CONVEX_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.match(result.reason, /convex\.migration/); assert.equal(calls.some((call) => call.file === 'npx'), false); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
