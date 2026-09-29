import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { actionHash, ensureTapTable, reserveTap, type TapMemory } from '../src/envelope.js';
import { createDeploy, ensureDeployTable, type DeployExec } from '../src/deploy.js';
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

function deployDeps(repo: string, sha: string, exec: DeployExec, decision: 'allow' | 'tap' = 'allow') {
  const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-deploy-home-'));
  const service = createDeploy({ store, home, workspace: workspace(sha), resolveRepo: async () => ({ repo, slug: 'owner/repo' }), envelope: async () => ({ ok: true, decisions: [{ decision }] }), reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec, env: { VERCEL_TOKEN: token, VERCEL_ORG_ID: token, VERCEL_PROJECT_ID: token }, now: () => new Date('2026-09-30T00:00:00.000Z') });
  return { service, store, home };
}

test('smoke failure rolls back the previous provider deployment and redacts secrets', async () => {
  const { repo, sha } = repoWithConfig(); const calls: Array<{ file: string; args: string[] }> = [];
  const exec: DeployExec = async (file, args) => { calls.push({ file, args }); if (file === 'git' && args[0] === 'rev-parse') return { stdout: `${sha}\n`, code: 0 }; if (file === 'vercel' && args[0] === 'deploy') return { stdout: 'https://new.example.invalid\n', code: 0 }; if (file === 'false') return { stdout: token, stderr: token, code: 1 }; return { stdout: '', code: 0 }; };
  const d = deployDeps(repo, sha, exec); ensureDeployTable(d.store);
  d.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old', 'owner/repo', 'prod', 'vercel', 'prod', sha, 'succeeded', 'https://old.example.invalid', 'previous-provider-id', null, '{}', null, '2026-09-29T00:00:00.000Z');
  try {
    const result = await d.service.run({ project: 'owner/repo', target: 'prod' });
    assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    assert.deepEqual(calls.find((call) => call.file === 'vercel' && call.args[0] === 'rollback')?.args.slice(0, 2), ['rollback', 'previous-provider-id']);
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
