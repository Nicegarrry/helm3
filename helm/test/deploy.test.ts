import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { actionHash, ensureTapTable, reserveTap, type TapMemory } from '../src/envelope.js';
import { checkEnvelope, envelopePath } from '../src/envelope.js';
import { createDeploy, ensureDeployTable, type DeployExec } from '../src/deploy.js';
import { runTestFlight } from '../src/testflight.js';
import type { Jev } from '../src/jev.js';
import type { RepoConfig } from '../src/repoconfig.js';
import { openStore } from '../src/store.js';
import type { Workspace } from '../src/types.js';

const token = 'deploy-sentinel-token';
const target = { name: 'prod', kind: 'vercel' as const, env: { VERCEL_TOKEN: 'VERCEL_TOKEN' }, mode: 'cli' as const, smoke: { commands: [{ name: 'smoke', command: 'false' }] }, rollback: 'auto' as const };
type DeployTarget = NonNullable<RepoConfig['deploy']>['targets'][number];

function repoWithConfig(configTarget: DeployTarget = target): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), 'helm-deploy-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'helm@example.invalid'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Helm Test'], { cwd: repo });
  writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [], deploy: { targets: [configTarget] } }));
  execFileSync('git', ['add', 'helm.json'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'config'], { cwd: repo });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
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

function deployDeps(repo: string, sha: string, exec: DeployExec, decision: 'allow' | 'tap' = 'allow', env: NodeJS.ProcessEnv = { VERCEL_TOKEN: token, VERCEL_ORG_ID: token, VERCEL_PROJECT_ID: token }) {
  const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-deploy-home-'));
  const wrapped: DeployExec = async (file, args, options) => { if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[3]!, { recursive: true }); writeFileSync(join(args[3]!, 'Gemfile.lock'), 'GEM'); } return exec(file, args, options); };
  const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision }] }), reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: wrapped, env, now: () => new Date('2026-09-30T00:00:00.000Z') });
  return { service, store, home };
}

test('smoke failure rolls back the previous provider deployment and redacts secrets', async () => {
  const { repo, sha } = repoWithConfig(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = [];
  const exec: DeployExec = async (file, args, options) => { calls.push({ file, args, options }); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'vercel' && args[0] === 'deploy') return { stdout: 'https://new.example.invalid\n', code: 0 }; if (file === 'false') return { stdout: token, stderr: token, code: 1 }; return { stdout: '', code: 0 }; };
  const d = deployDeps(repo, sha, exec); ensureDeployTable(d.store);
  d.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'prod', 'vercel', 'prod', sha, 'succeeded', 'https://old.example.invalid', 'previous-provider-id', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try {
    const result = await d.service.run({ project: 'owner/repo', target: 'prod' });
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    assert.deepEqual(calls.find((call) => call.file === 'vercel' && call.args[0] === 'rollback')?.args.slice(0, 2), ['rollback', 'previous-provider-id']);
    const vercelCalls = calls.filter((call) => call.file === 'vercel'); assert.ok(vercelCalls.length > 0); assert.ok(vercelCalls.every((call) => !call.args.includes(token) && call.options.env?.VERCEL_TOKEN === token));
    assert.equal((d.store.sql.prepare('SELECT state FROM deploys WHERE id != ? ORDER BY at DESC LIMIT 1').get('old') as { state: string }).state, 'rolledback');
    assert.ok(d.store.listEvents('project:owner/repo').some((event) => event.kind === 'deploy.rolledback'));
  } finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('non-base production SHA is refused before the adapter runs', async () => {
  const { repo, sha } = repoWithConfig(); const calls: string[] = [];
  const d = deployDeps(repo, sha, async (file, args) => { calls.push(file); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; return { stdout: '', code: file === 'git' ? 1 : 0 }; });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod', sha }); assert.equal(result.ok, false); assert.match(result.reason, /not on base branch/); assert.deepEqual(calls, ['git', 'git']); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('deployment configuration comes from the requested SHA, not the dirty worktree', async () => {
  const first = repoWithConfig({ ...target, name: 'old' }); writeFileSync(join(first.repo, 'helm.json'), JSON.stringify({ gates: [], deploy: { targets: [{ ...target, name: 'new' }] } }));
  const d = deployDeps(first.repo, first.sha, async (file, args) => file === 'git' && args[0] === 'rev-parse' ? { stdout: `${first.sha}\n`, code: 0 } : file === 'git' && args[0] === 'merge-base' ? { stdout: '', code: 0 } : { stdout: 'https://old.example.invalid\n', code: 0 });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'old' }); assert.equal(result.ok, true); }
  finally { d.store.close(); rmSync(first.repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('a granted tap is reserved, committed once, and required for the adapter kind', async () => {
  const { repo, sha } = repoWithConfig(); const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-deploy-tap-')); const taps = new Map<string, TapMemory>(); ensureTapTable(store); const id = 't-deploy'; const action = `deploy.run:owner/repo:prod:${sha}`; let resolved = 0; const actions: string[] = [];
  taps.set(id, { project: 'owner/repo', kind: 'vercel', actionHash: actionHash(action), codeMac: '', attempts: 0, expiresAt: '2099-01-01T00:00:00.000Z', state: 'granted' }); store.sql.prepare('INSERT INTO taps (id, project, kind, action, actionHash, codeHash, state, attempts, requestedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'owner/repo', 'vercel', action, actionHash(action), '', 'granted', 0, '2026-09-30T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo, slug: 'owner/repo' }), envelope: async ({ actions: currentActions }) => { actions.push(...currentActions); return { ok: true, decisions: [{ decision: 'tap' }] }; }, reserveTap: (project, kind, currentAction, tapId) => reserveTap(store, taps, project, kind, actionHash(currentAction), tapId), commitTap: (reservation) => { store.sql.prepare("UPDATE taps SET state='used' WHERE id=?").run(reservation.tapId); taps.delete(reservation.tapId); }, rollbackTap() {}, exec: async (file, args) => { if (file === 'git' && args[0] === 'rev-parse') { resolved += 1; return { stdout: `${sha}\n`, code: 0 }; } return file === 'vercel' && args[0] === 'deploy' ? { stdout: 'https://tap.example.invalid\n', code: 0 } : { stdout: '', code: 0 }; }, env: { VERCEL_TOKEN: token, VERCEL_ORG_ID: token, VERCEL_PROJECT_ID: token } });
  try { const refused = await service.run({ project: 'owner/repo', target: 'prod', sha: 'main' }); assert.equal(refused.ok, false); assert.match(refused.reason, /vercel/); const success = await service.run({ project: 'owner/repo', target: 'prod', sha: 'main', tapId: id }); assert.equal(success.ok, true); assert.equal(resolved, 2); assert.deepEqual(actions, [action, action]); assert.equal((store.sql.prepare('SELECT state FROM taps WHERE id=?').get(id) as { state: string }).state, 'used'); }
  finally { store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('smoke runs in the deploy worktree with no credentials and refuses sh -c', async () => {
  const config = { ...target, smoke: { commands: [{ name: 'env', command: 'printenv HELM_DEPLOY_URL' }] } }; const { repo, sha } = repoWithConfig(config); let smokeOptions: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
  const d = deployDeps(repo, sha, async (file, args, options) => { if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'printenv') { smokeOptions = options; return { stdout: token, code: 0 }; } if (file === 'vercel') return { stdout: 'https://smoke.example.invalid\n', code: 0 }; return { stdout: '', code: 0 }; });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, true); assert.ok(smokeOptions?.cwd?.includes('/deploys/owner__repo/')); assert.deepEqual(Object.keys(smokeOptions?.env ?? {}).sort(), ['HELM_DEPLOY_URL', 'HOME', 'PATH']); assert.equal(JSON.stringify(smokeOptions?.env).includes(token), false); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }

  const shellConfig = { ...target, smoke: { commands: [{ name: 'shell', command: 'sh -c echo' }] } }; const shellRepo = repoWithConfig(shellConfig); const shell = deployDeps(shellRepo.repo, shellRepo.sha, async (file, args) => file === 'git' && args[0] === 'rev-parse' ? { stdout: `${shellRepo.sha}\n`, code: 0 } : file === 'vercel' ? { stdout: 'https://shell.example.invalid\n', code: 0 } : { stdout: '', code: 0 });
  try { const result = await shell.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.match(result.reason, /shell/); }
  finally { shell.store.close(); rmSync(shellRepo.repo, { recursive: true, force: true }); rmSync(shell.home, { recursive: true, force: true }); }
});

test('adapter failure keeps the original reason and does not roll back', async () => {
  const { repo, sha } = repoWithConfig(); const calls: string[] = []; const d = deployDeps(repo, sha, async (file, args) => { calls.push(`${file}:${args[0] ?? ''}`); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'vercel' && args[0] === 'deploy') return { stdout: '', stderr: 'adapter failed', code: 1 }; return { stdout: '', code: 0 }; });
  d.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'prod', 'vercel', 'prod', sha, 'succeeded', 'https://old.example.invalid', 'previous-provider-id', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.equal(result.reason, 'adapter failed'); assert.equal(calls.some((call) => call === 'vercel:rollback'), false); const event = d.store.listEvents('project:owner/repo').find((entry) => entry.kind === 'deploy.failed'); assert.deepEqual(event?.data, { project: 'owner/repo', id: event?.data.id, target: 'prod', kind: 'vercel', reason: 'adapter failed' }); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('git mode uses the successful deployment status environment URL', async () => {
  const config = { ...target, mode: 'git' as const }; const { repo, sha } = repoWithConfig(config); const d = deployDeps(repo, sha, async (file, args) => { if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'gh' && args[1]?.includes('/statuses')) return { stdout: JSON.stringify([{ state: 'success', environment_url: 'https://environment.example.invalid', target_url: 'https://target.example.invalid' }]), code: 0 }; if (file === 'gh') return { stdout: JSON.stringify([{ id: 42, url: 'https://api.example.invalid' }]), code: 0 }; return { stdout: '', code: 0 }; });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, true); assert.equal(result.deploy.url, 'https://environment.example.invalid'); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('TestFlight records the fastlane build number and keeps credentials out of argv', async () => {
  const config = { name: 'beta', kind: 'testflight' as const, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, lane: 'internal', smoke: {}, rollback: 'none' as const }; const { repo, sha } = repoWithConfig(config); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = [];
  const d = deployDeps(repo, sha, async (file, args, options) => { calls.push({ file, args, options }); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'bundle') return { stdout: 'HELM_BUILD_NUMBER=42\n', code: 0 }; return { stdout: '', code: 0 }; }, 'allow', { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, true); assert.equal(result.deploy.deploymentId, '42'); assert.deepEqual(calls.filter((call) => call.file === 'bundle').map((call) => call.args), [['install', '--deployment'], ['exec', 'fastlane', 'internal']]); const install = calls.find((call) => call.args[0] === 'install')!; assert.equal(install.options.env?.APP_STORE_CONNECT_API_KEY_PATH, undefined); assert.equal(install.options.env?.MATCH_PASSWORD, undefined); const fastlane = calls.find((call) => call.args[1] === 'fastlane')!; assert.equal(fastlane.options.env?.APP_STORE_CONNECT_API_KEY_PATH, '/tmp/key.json'); assert.equal(fastlane.options.env?.MATCH_PASSWORD, 'match-password'); assert.ok(fastlane.args.every((arg) => !arg.includes('password') && !arg.includes('key.json'))); const event = d.store.listEvents('project:owner/repo').find((entry) => entry.kind === 'deploy'); assert.equal(event?.data.deploymentId, '42'); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('TestFlight failure stores and emits only a redacted last-40-line tail', async () => {
  const config = { name: 'beta', kind: 'testflight' as const, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const { repo, sha } = repoWithConfig(config); const secret = 'fastlane-secret';
  const log = Array.from({ length: 50 }, (_, index) => index === 45 ? secret : `line-${index + 1}`).join('\n'); const d = deployDeps(repo, sha, async (file, args) => { if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'bundle') return { stdout: log, code: 1 }; return { stdout: '', code: 0 }; }, 'allow', { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: secret });
  try { const result = await d.service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, false); assert.doesNotMatch(result.reason, new RegExp(secret)); const saved = d.store.sql.prepare("SELECT state, smoke FROM deploys WHERE target = 'beta'").get() as { state: string; smoke: string }; assert.equal(saved.state, 'failed'); assert.doesNotMatch(saved.smoke, new RegExp(secret)); assert.match(saved.smoke, /line-50/); const event = d.store.listEvents('project:owner/repo').find((entry) => entry.kind === 'deploy.failed'); assert.doesNotMatch(JSON.stringify(event?.data), new RegExp(secret)); assert.match(String(event?.data.reason), /line-50/); }
  finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});

test('external TestFlight distribution requires the testflight.external tap', async () => {
  const config = { name: 'external', kind: 'testflight' as const, external: true, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const { repo, sha } = repoWithConfig(config); let envelopeKind = '';
  const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-testflight-tap-')); const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { envelopeKind = kind; return { ok: true, decisions: [{ decision: 'tap' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args) => file === 'git' && args[0] === 'rev-parse' ? { stdout: `${sha}\n`, code: 0 } : { stdout: '', code: 0 }, env: { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' } });
  try { const result = await service.run({ project: 'owner/repo', target: 'external' }); assert.equal(result.ok, false); assert.match(result.reason, /tap required for testflight\.external/); assert.equal(envelopeKind, 'testflight.external'); }
  finally { store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('deploy envelope keeps target modes while adding the real external tap check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-envelope-real-')); const path = envelopePath(root, 'owner/repo'); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify({ rules: [], budget: { maxSprintUsd: 1, maxSprintCodexTokens: 1 }, deploy: { prod: 'tap', preview: 'auto', blocked: 'never' }, tapOnly: [] }));
  const jev: Jev = { shadow: false, async ask(_purpose, input) { return { ok: true, answers: Object.fromEntries(Object.keys(input.questions).map((key) => [key, { noul: false }])) }; } };
  try { const one = async (kind: string) => (await checkEnvelope(root, { project: 'owner/repo', actions: ['deploy it'], kind }, { jev, envelopeTapAt: 0.5, defaultBranch: 'main' }))[0]!; assert.equal((await one('deploy.blocked')).decision, 'never'); assert.equal((await one('deploy.preview')).decision, 'allow'); assert.equal((await one('deploy.prod')).decision, 'tap'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('TestFlight lane and external policy come from base config, and no prior deploy fails closed', async () => {
  const base = { name: 'beta', kind: 'testflight' as const, lane: 'base_lane', external: false, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const deployed = { ...base, lane: 'sha_lane', external: true }; const fixture = repoWithConfig(base); execFileSync('git', ['checkout', '-qb', 'deploy-sha'], { cwd: fixture.repo }); const sha = commitConfig(fixture.repo, deployed); const kinds: string[] = []; let lane = '';
  const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-testflight-base-')); const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo: fixture.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args, options) => { if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[3]!, { recursive: true }); writeFileSync(join(args[3]!, 'Gemfile.lock'), 'GEM'); } if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'bundle') { lane = args.at(-1) ?? ''; return { stdout: 'HELM_BUILD_NUMBER=7', code: 0 }; } return { stdout: '', code: 0 }; }, env: { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' } });
  try { const result = await service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, true); assert.equal(lane, 'base_lane'); assert.deepEqual(kinds, ['deploy.beta', 'testflight.external']); }
  finally { store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('TestFlight toolchain changes since the last deploy require the external tap', async () => {
  const base = { name: 'beta', kind: 'testflight' as const, lane: 'base-lane', external: false, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const fixture = repoWithConfig(base); execFileSync('git', ['checkout', '-qb', 'deploy-sha'], { cwd: fixture.repo }); const sha = commitConfig(fixture.repo, { ...base, lane: 'new-lane' }); const kinds: string[] = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-testflight-diff-')); const actionSha = fixture.sha;
  const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo: fixture.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: kind === 'testflight.external' ? 'tap' : 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args) => { if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'git' && args[0] === 'diff') return { stdout: 'fastlane/Fastfile\n', code: 0 }; return { stdout: '', code: 0 }; }, env: { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' } });
  store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'beta', 'testflight', 'beta', actionSha, 'succeeded', null, '6', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try { const result = await service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, false); assert.match(result.reason, /tap required for testflight\.external/); assert.deepEqual(kinds, ['deploy.beta', 'testflight.external']); }
  finally { store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('missing base TestFlight config fails closed to the external tap', async () => {
  const base = { name: 'other', kind: 'testflight' as const, lane: 'base-lane', external: false, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'none' as const }; const deployed = { ...base, name: 'beta' }; const fixture = repoWithConfig(base); execFileSync('git', ['checkout', '-qb', 'deploy-sha'], { cwd: fixture.repo }); const sha = commitConfig(fixture.repo, deployed); const kinds: string[] = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-testflight-base-missing-')); const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo: fixture.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: kind === 'testflight.external' ? 'tap' : 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: async (file, args) => file === 'git' && args[0] === 'rev-parse' ? { stdout: `${sha}\n`, code: 0 } : { stdout: '', code: 0 }, env: { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' } });
  store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'beta', 'testflight', 'beta', fixture.sha, 'succeeded', null, '6', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try { const result = await service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, false); assert.match(result.reason, /tap required for testflight\.external/); assert.deepEqual(kinds, ['deploy.beta', 'testflight.external']); }
  finally { store.close(); rmSync(fixture.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('TestFlight accepts only explicit build markers and applies timeoutMin', async () => {
  const logs = ['Building MyApp for iOS 18.0 (build 42)', 'increment_build_number: 2026-09-30 12:34:56 +0000'];
  for (const log of logs) { const worktree = mkdtempSync(join(tmpdir(), 'helm-testflight-run-')); writeFileSync(join(worktree, 'Gemfile.lock'), 'GEM'); try { const result = await runTestFlight({}, worktree, async () => ({ stdout: log, code: 0 }), {}, String); assert.equal(result.deploymentId, null); } finally { rmSync(worktree, { recursive: true, force: true }); } }
  const missing = mkdtempSync(join(tmpdir(), 'helm-testflight-missing-')); try { await assert.rejects(() => runTestFlight({}, missing, async () => { throw new Error('exec should not run'); }, {}, String), /Gemfile.lock/); } finally { rmSync(missing, { recursive: true, force: true }); }
  let timeout = 0; let laneCalls = 0; const worktree = mkdtempSync(join(tmpdir(), 'helm-testflight-lane-')); writeFileSync(join(worktree, 'Gemfile.lock'), 'GEM'); try { const result = await runTestFlight({ platform: 'ios', lane: 'beta', timeoutMin: 2 }, worktree, async (_file, args, options) => { if (args[0] === 'install') { assert.equal(options.env?.APP_STORE_CONNECT_API_KEY_PATH, undefined); return { stdout: '', code: 0 }; } laneCalls += 1; timeout = options.timeout ?? 0; assert.deepEqual(args, ['exec', 'fastlane', 'ios', 'beta']); return { stdout: 'HELM_BUILD_NUMBER=42', code: 0 }; }, { APP_STORE_CONNECT_API_KEY_PATH: 'secret', MATCH_PASSWORD: 'secret' }, String); assert.equal(result.deploymentId, '42'); assert.equal(timeout, 120_000); assert.equal(laneCalls, 1); } finally { rmSync(worktree, { recursive: true, force: true }); }
  const invalid = mkdtempSync(join(tmpdir(), 'helm-testflight-invalid-')); writeFileSync(join(invalid, 'Gemfile.lock'), 'GEM'); try { await assert.rejects(() => runTestFlight({ platform: 'iOS' }, invalid, async () => ({ stdout: '', code: 0 }), {}, String), /platform/); await assert.rejects(() => runTestFlight({ lane: 'beta-release' }, invalid, async () => ({ stdout: '', code: 0 }), {}, String), /lane/); } finally { rmSync(invalid, { recursive: true, force: true }); }
});

test('TestFlight ignores configured rollback and returns a warning', async () => {
  const config = { name: 'beta', kind: 'testflight' as const, external: false, env: { APP_STORE_CONNECT_API_KEY_PATH: 'ASC_SECRET', MATCH_PASSWORD: 'MATCH_SECRET' }, smoke: {}, rollback: 'auto' as const }; const { repo, sha } = repoWithConfig(config); const d = deployDeps(repo, sha, async (file, args) => { if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'bundle' && args[0] === 'exec') return { stdout: 'HELM_BUILD_NUMBER=8', code: 0 }; return { stdout: '', code: 0 }; }, 'allow', { ASC_SECRET: '/tmp/key.json', MATCH_SECRET: 'match-password' });
  d.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'beta', 'testflight', 'beta', sha, 'succeeded', null, '7', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try { const result = await d.service.run({ project: 'owner/repo', target: 'beta' }); assert.equal(result.ok, true); assert.match(result.warning ?? '', /rollback is disabled/); } finally { d.store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(d.home, { recursive: true, force: true }); }
});
