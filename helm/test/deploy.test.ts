import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  return async (file: string, args: string[], options: Parameters<DeployExec>[2]) => {
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

test('Convex production schema diff is refused without a migration tap and names both SHAs', async () => {
  const c = convexRepo(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-refused-')); insertSuccessfulConvex(store, c.oldSha);
  const kinds: string[] = []; const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async ({ kind }) => { kinds.push(kind); return { ok: true, decisions: [{ decision: 'allow' }] }; }, reserveTap: () => 'tap required', commitTap() {}, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'convex/schema.ts\n', calls), env: { CONVEX_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod' }); assert.equal(result.ok, false); assert.match(result.reason, /convex\.migration/); assert.deepEqual(kinds, ['deploy.prod', 'convex.migration']); assert.equal(calls.some((call) => call.file === 'npx'), false); assert.doesNotMatch(JSON.stringify(result), new RegExp(token)); }
  finally { store.close(); rmSync(c.repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('Convex migration checks both envelope kinds and consumes one granted tap', async () => {
  const c = convexRepo(); const calls: Array<{ file: string; args: string[]; options: Parameters<DeployExec>[2] }> = []; const store = openStore(':memory:'); const home = mkdtempSync(join(tmpdir(), 'helm-convex-tap-')); insertSuccessfulConvex(store, c.oldSha); const actions: string[] = []; let committed = 0;
  const service = createDeploy({ store, home, workspace: workspace(c.newSha), resolveRepo: async () => ({ repo: c.repo, slug: 'owner/repo' }), envelope: async ({ kind, actions: currentActions }) => { actions.push(`${kind}:${currentActions[0]}`); return { ok: true, decisions: [{ decision: 'allow' }] }; }, reserveTap: (project, kind, action, tapId) => { assert.equal(kind, 'convex.migration'); assert.equal(tapId, 'tap-1'); assert.match(action, new RegExp(`${c.oldSha}:${c.newSha}$`)); return { tapId: tapId!, token: 'reservation' }; }, commitTap: () => { committed += 1; }, rollbackTap() {}, exec: convexExec(c.repo, c.newSha, 'convex/schema.ts\n', calls), env: { CONVEX_DEPLOY_KEY: token } });
  try { const result = await service.run({ project: 'owner/repo', target: 'prod', tapId: 'tap-1' }); assert.equal(result.ok, true); assert.equal(committed, 1); assert.deepEqual(calls.filter((call) => call.file === 'npm').map((call) => call.args), [['ci']]); assert.deepEqual(calls.filter((call) => call.file === 'npx').map((call) => call.args), [['--no-install', 'convex', 'deploy', '--yes']]); assert.ok(actions.every((action) => action.includes(c.oldSha) && action.includes(c.newSha))); assert.ok(calls.find((call) => call.file === 'npm')!.options.env && !JSON.stringify(calls.find((call) => call.file === 'npm')!.options.env).includes(token)); }
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
