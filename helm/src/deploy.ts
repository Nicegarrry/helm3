import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoConfig } from './repoconfig.js';
import { loadRepoConfig } from './repoconfig.js';
import type { Store, ToolOutcome, Workspace } from './types.js';
import { loadEnvFile } from './settings.js';
import { registerWakeKind } from './supervise.js';
import { runTestFlight, withTempHome } from './testflight.js';
import { hardenedGitArgs } from './git.js';

export type DeployInput = Readonly<{ project: string; target: string; sha?: string; tapId?: string }>;
export type DeployStatusInput = Readonly<{ project?: string; id?: string }>;
export type DeployRollbackInput = Readonly<{ id: string; tapId?: string }>;
export type DeployRow = Readonly<{ id: string; project: string; target: string; kind: string; env: string; sha: string; state: string; bootId: string | null; reason: string | null; url: string | null; deploymentId: string | null; previousId: string | null; smoke: Record<string, unknown>; tapId: string | null; at: string }>;
export type DeployExec = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<{ stdout: string; stderr?: string; code?: number }>;
type Target = NonNullable<RepoConfig['deploy']>['targets'][number];
type TapReservation = Readonly<{ tapId: string; token: string }>;
type Options = Readonly<{
  store: Store; home: string; workspace: Pick<Workspace, 'defaultBranch'>; bootId?: string;
  resolveRepo: (project: string) => Promise<{ repo: string; slug: string }>;
  envelope: (input: { project: string; actions: string[]; kind: string; baseRef?: string }) => Promise<ToolOutcome<{ decisions: Array<{ decision: string }> }>>;
  reserveTap: (project: string, kind: string, action: string, tapId?: string) => TapReservation | string;
  commitTap: (reservation: TapReservation) => void; rollbackTap: (reservation: TapReservation) => void;
  exec?: DeployExec; fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv; envFile?: string; smokeEnvAllowlist?: readonly string[]; now?: () => Date;
}>;
export type DeployService = Readonly<{
  run(input: DeployInput): Promise<ToolOutcome<{ deploy: DeployRow; warning?: string }>>;
  status(input: DeployStatusInput): Promise<ToolOutcome<{ deploys: DeployRow[] }>>;
  rollback(input: DeployRollbackInput): Promise<ToolOutcome<{ deploy: DeployRow }>>;
  isInProgress(project: string, target: string): boolean;
}>;

const realExec = promisify(execFile);
const defaultExec: DeployExec = async (file, args, options) => {
  try { const result = await realExec(file, args, { cwd: options.cwd, env: options.env, timeout: options.timeout, maxBuffer: 16 * 1024 * 1024 }); return { stdout: result.stdout, stderr: result.stderr, code: 0 }; }
  catch (error) { const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }; return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message ?? ''), code: typeof e.code === 'number' ? e.code : 1 }; }
};

export function ensureDeployTable(store: Store): void {
  store.sql.exec(`CREATE TABLE IF NOT EXISTS deploys (id TEXT PRIMARY KEY, project TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, env TEXT NOT NULL, sha TEXT NOT NULL, state TEXT NOT NULL, bootId TEXT, reason TEXT, url TEXT, deploymentId TEXT, previousId TEXT, smoke JSON NOT NULL, tapId TEXT, at TEXT NOT NULL)`);
  const columns = store.sql.prepare('PRAGMA table_info(deploys)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'bootId')) store.sql.exec('ALTER TABLE deploys ADD COLUMN bootId TEXT');
  if (!columns.some((column) => column.name === 'reason')) store.sql.exec('ALTER TABLE deploys ADD COLUMN reason TEXT');
}

function row(value: Record<string, unknown>): DeployRow { return { id: String(value.id), project: String(value.project), target: String(value.target), kind: String(value.kind), env: String(value.env), sha: String(value.sha), state: String(value.state), bootId: (value.bootId as string | null) ?? null, reason: (value.reason as string | null) ?? null, url: (value.url as string | null) ?? null, deploymentId: (value.deploymentId as string | null) ?? null, previousId: (value.previousId as string | null) ?? null, smoke: JSON.parse(String(value.smoke ?? '{}')) as Record<string, unknown>, tapId: (value.tapId as string | null) ?? null, at: String(value.at) }; }

export async function markDeploysInterrupted(store: Store, options: { currentBootId?: string; predecessorBootId?: string; now?: Date; timeoutMs?: number; timeoutFor?: (row: { project: string; target: string; sha: string }) => Promise<number | undefined> } = {}): Promise<number> {
  ensureDeployTable(store);
  const now = (options.now ?? new Date()).getTime();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const liveBoots = new Set([options.currentBootId, options.predecessorBootId].filter((bootId): bootId is string => Boolean(bootId)));
  const rows = store.sql.prepare("SELECT id, project, target, sha, bootId, at FROM deploys WHERE state = 'deploying'").all() as Array<{ id: string; project: string; target: string; sha: string; bootId: string | null; at: string }>;
  const stale: typeof rows = [];
  for (const row of rows) {
    if (!liveBoots.has(row.bootId ?? '')) { stale.push(row); continue; }
    const limit = row.bootId === options.predecessorBootId
      ? (await options.timeoutFor?.({ project: row.project, target: row.target, sha: row.sha }) ?? 60) * 60_000
      : timeoutMs;
    if (now - Date.parse(row.at) > limit) stale.push(row);
  }
  const update = store.sql.prepare("UPDATE deploys SET state = 'failed', reason = ? WHERE id = ? AND state = 'deploying'");
  for (const row of stale) update.run('interrupted (daemon restart)', row.id);
  return stale.length;
}
function redactor(secrets: string[]): (value: unknown) => string { const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length); return (value) => values.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value)); }
function tokens(command: string): string[] {
  if (/[;&|<>`$()]|\n|\r/.test(command)) throw new Error('smoke command contains shell syntax');
  const found: string[] = []; let current = ''; let quote = '';
  for (const char of command) { if (quote) { if (char === quote) quote = ''; else current += char; } else if (char === "'" || char === '"') quote = char; else if (/\s/.test(char)) { if (current) { found.push(current); current = ''; } } else current += char; }
  if (quote) throw new Error('smoke command has an unterminated quote'); if (current) found.push(current); if (!found.length) throw new Error('smoke command is empty');
  if (/^(?:sh|bash|zsh|dash|ksh)$/.test(found[0]!) && /^-(?:c|lc)$/.test(found[1] ?? '')) throw new Error('smoke command must not invoke a shell');
  return found;
}
function targetFor(config: RepoConfig, name: string): Target { const target = config.deploy?.targets.find((candidate) => candidate.name === name); if (!target) throw new Error(`deploy target not found: ${name}`); return target; }
function moreRestrictive(left: string, right: string): string { const rank = (decision: string) => decision === 'never' ? 2 : decision === 'tap' ? 1 : 0; return rank(left) >= rank(right) ? left : right; }
function requiresExternalTap(files: string[]): boolean { return files.some((file) => file.startsWith('fastlane/') || file === 'Gemfile' || file === 'Gemfile.lock'); }
function preview(target: Target): boolean { return /^(preview|pr)$/i.test(typeof target.env === 'string' ? target.env : '') || /^preview/i.test(target.name); }
function productionTarget(target: Target): boolean { return target.env === 'prod' || target.env === 'production' || target.name === 'prod' || target.name === 'production'; }
function lockKey(project: string, target: string): string { return `${project}\u0000${target}`; }
function envNames(target: Target): Record<string, string> {
  if (target.kind === 'convex') return { CONVEX_DEPLOY_KEY: typeof target.env === 'string' ? target.env : target.env.CONVEX_DEPLOY_KEY ?? 'CONVEX_DEPLOY_KEY' };
  const configured = typeof target.env === 'string' ? {} : target.env;
  if (target.mode === 'git') return configured;
  if (target.kind === 'testflight') return {
    APP_STORE_CONNECT_API_KEY_PATH: configured.APP_STORE_CONNECT_API_KEY_PATH ?? 'APP_STORE_CONNECT_API_KEY_PATH',
    MATCH_PASSWORD: configured.MATCH_PASSWORD ?? 'MATCH_PASSWORD',
  };
  return {
    VERCEL_TOKEN: configured.VERCEL_TOKEN ?? 'VERCEL_TOKEN',
    VERCEL_ORG_ID: configured.VERCEL_ORG_ID ?? 'VERCEL_ORG_ID',
    VERCEL_PROJECT_ID: configured.VERCEL_PROJECT_ID ?? 'VERCEL_PROJECT_ID',
    ...configured,
  };
}

export function createDeploy(options: Options) {
  const rawExec = options.exec ?? defaultExec;
  const exec: DeployExec = options.exec ? rawExec : (file, args, execOptions) => rawExec(file, file === 'git' ? hardenedGitArgs(args) : args, execOptions);
  const fetchImpl = options.fetch ?? globalThis.fetch; const now = options.now ?? (() => new Date()); const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  ensureDeployTable(options.store);
  const inProgress = new Set<string>();
  const daemonEnv = () => ({ ...process.env, ...(options.env ?? {}) });
  const sourceEnv = () => ({ ...loadEnvFile(options.envFile ?? join(homedir(), '.config', 'helm', 'env')), ...process.env, ...(options.env ?? {}) });
  const secretEnv = (target: Target, required = true, missingMessage?: string) => { const source = sourceEnv(); const values: Record<string, string> = {}; const missing: string[] = []; for (const [key, name] of Object.entries(envNames(target))) { const value = source[name]; if (!value) missing.push(name); else values[key] = value; } if (required && missing.length) throw new Error(missingMessage ? `${missingMessage} (${missing.join(', ')})` : `missing credential ${missing[0]}`); return { values, redact: redactor(Object.values(values)) }; };
  const vercelProjectEnv = (repo: string, target: Target): Record<string, string> => {
    const names = envNames(target); const source = sourceEnv(); const orgName = names.VERCEL_ORG_ID; const projectName = names.VERCEL_PROJECT_ID; const configuredOrg = orgName ? source[orgName] : undefined; const configuredProject = projectName ? source[projectName] : undefined;
    if (configuredOrg && configuredProject) return { VERCEL_ORG_ID: configuredOrg, VERCEL_PROJECT_ID: configuredProject };
    try {
      const linked = JSON.parse(readFileSync(join(repo, '.vercel', 'project.json'), 'utf8')) as { orgId?: unknown; projectId?: unknown };
      if (typeof linked.orgId === 'string' && linked.orgId && typeof linked.projectId === 'string' && linked.projectId) return { VERCEL_ORG_ID: linked.orgId, VERCEL_PROJECT_ID: linked.projectId };
    } catch { /* an absent or invalid link is handled by the refusal below */ }
    throw new Error(`vercel target ${target.name} is not linked: set org/project ids or run \`vercel link\` in ${repo}`);
  };
  const convexProjectEnv = (repo: string, target: Target): Record<string, string> => {
    const keyName = envNames(target).CONVEX_DEPLOY_KEY; const source = sourceEnv();
    if (keyName && source[keyName]) return {};
    const deployment = loadEnvFile(join(repo, '.env.local')).CONVEX_DEPLOYMENT;
    if (deployment) return { CONVEX_DEPLOYMENT: deployment };
    throw new Error(`convex target ${target.name} is not linked: set a deploy key or run \`npx convex dev\` once in ${repo}`);
  };
  const hasScopedCredentials = (target: Target): boolean => { const source = sourceEnv(); return Object.values(envNames(target)).every((name) => Boolean(source[name])); };
  const operatorEnv = (source: NodeJS.ProcessEnv, credentials: Record<string, string>): NodeJS.ProcessEnv => ({ PATH: source.PATH ?? '', HOME: source.HOME ?? homedir(), LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: source.TMPDIR ?? tmpdir(), ...credentials });
  const run = async (file: string, args: string[], target: Target, useOperatorLogin: boolean, cwd?: string, extraCredentials: Record<string, string> = {}) => { const credentials = secretEnv(target, !useOperatorLogin, 'branch preview deploys require scoped credentials'); const values = { ...credentials.values, ...extraCredentials }; const redact = redactor(Object.values(values)); const source = sourceEnv(); const minimalEnv = { PATH: source.PATH ?? '', ...values }; const result = useOperatorLogin ? await exec(file, args, { cwd, env: operatorEnv(source, values), timeout: 300_000 }) : await withTempHome(minimalEnv, (tempEnv) => exec(file, args, { cwd, env: tempEnv, timeout: 300_000 })); if ((result.code ?? 0) !== 0) throw new Error(redact(result.stderr || result.stdout || `${file} failed`)); return { text: redact(result.stdout), credentials: { values, redact } }; };
  const runDaemon = async (file: string, args: string[], cwd?: string) => { const result = await exec(file, args, { cwd, env: daemonEnv(), timeout: 300_000 }); if ((result.code ?? 0) !== 0) throw new Error(result.stderr || result.stdout || `${file} failed`); return { text: result.stdout }; };
  const git = (args: string[], cwd: string) => exec('git', args, { cwd, env: daemonEnv() });
  const defaultMigrationGlobs = ['convex/schema.ts', 'convex/migrations/**'];
  const globMatch = (file: string, glob: string): boolean => { const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'); return new RegExp(`^${escaped}$`).test(file); };
  const migrationGlobs = async (repo: string, previousSha: string | null, target: Target, includeTarget = false): Promise<string[]> => {
    const configured: string[] = includeTarget ? [...(target.migrationGlobs ?? [])] : [];
    if (previousSha) {
      try {
        const baseConfig = await loadRepoConfig(repo, previousSha, false);
        const baseTarget = baseConfig.deploy?.targets.find((candidate) => candidate.name === target.name);
        configured.push(...(baseTarget?.migrationGlobs ?? []));
      } catch { /* defaults fail closed when the old config is unavailable */ }
    }
    return [...new Set([...defaultMigrationGlobs, ...configured])];
  };
  const hasSchemaDiff = async (repo: string, globs: string[], previousSha: string | null, sha: string): Promise<boolean> => {
    if (!previousSha) return true;
    const result = await git(['diff', '--name-only', `${previousSha}..${sha}`], repo);
    if ((result.code ?? 0) !== 0) throw new Error('could not inspect Convex migration diff');
    return result.stdout.split(/\r?\n/).map((file) => file.trim()).filter(Boolean).some((file) => globs.some((glob) => globMatch(file, glob)));
  };
  const install = async (worktree: string): Promise<void> => {
    const command: readonly [string, string[]] | null = existsSync(join(worktree, 'package-lock.json')) ? ['npm', ['ci']] : existsSync(join(worktree, 'pnpm-lock.yaml')) ? ['pnpm', ['install', '--frozen-lockfile']] : existsSync(join(worktree, 'yarn.lock')) ? ['yarn', ['install', '--frozen-lockfile']] : null;
    if (!command) throw new Error('Convex deploy requires a package lockfile');
    const source = sourceEnv();
    const result = await withTempHome({ PATH: source.PATH ?? '' }, (minimalEnv) => exec(command[0], command[1], { cwd: worktree, env: minimalEnv, timeout: 300_000 }));
    if ((result.code ?? 0) !== 0) throw new Error(result.stderr || result.stdout || `${command[0]} install failed`);
  };
  const adapter = async (repo: string, slug: string, target: Target, sha: string, worktree?: string, useOperatorLogin = false): Promise<{ url: string | null; deploymentId: string | null }> => {
    if (target.kind === 'testflight') {
      if (!worktree) throw new Error('TestFlight deploy requires a deploy worktree');
      const credentials = secretEnv(target);
      const source = sourceEnv();
      const deployed = await runTestFlight(target, worktree, exec, { PATH: source.PATH ?? '', HOME: source.HOME ?? homedir(), TMPDIR: source.TMPDIR ?? tmpdir(), ...credentials.values }, credentials.redact);
      return { url: null, deploymentId: deployed.deploymentId };
    }
    if (target.kind === 'convex') { if (!worktree) throw new Error('Convex deploy requires a worktree'); const providerEnv = useOperatorLogin ? convexProjectEnv(repo, target) : {}; await install(worktree); const result = await run('npx', ['--no-install', 'convex', 'deploy', '--yes'], target, useOperatorLogin, worktree, providerEnv); return { url: null, deploymentId: sha }; }
    if (target.kind !== 'vercel') throw new Error(`${target.kind} deploy adapter is not available in C2a`);
    if ((target.mode ?? 'cli') === 'git') {
      const deadline = Date.now() + 300_000;
      for (let attempt = 0; attempt < 300 && Date.now() < deadline; attempt++) {
        const result = await runDaemon('gh', ['api', `repos/${slug}/deployments?sha=${sha}`], repo);
        const deployments = JSON.parse(result.text || '[]') as Array<Record<string, unknown>>;
        for (const deployment of deployments) {
          const id = deployment.id === undefined ? undefined : String(deployment.id);
          if (!id) continue;
          const statuses = await runDaemon('gh', ['api', `repos/${slug}/deployments/${id}/statuses`], repo);
          const successful = (JSON.parse(statuses.text || '[]') as Array<Record<string, unknown>>).find((status) => String(status.state ?? status.status ?? '').toLowerCase() === 'success');
          if (successful) return { url: typeof successful.environment_url === 'string' && successful.environment_url ? successful.environment_url : typeof successful.target_url === 'string' && successful.target_url ? successful.target_url : null, deploymentId: id };
        }
        if (attempt < 299) await sleep(1000);
      }
      throw new Error('timed out waiting for GitHub deployment');
    }
    const args = ['deploy']; if (!preview(target)) args.push('--prod'); args.push('--yes'); const result = await run('vercel', args, target, useOperatorLogin, worktree, useOperatorLogin ? vercelProjectEnv(repo, target) : {}); const url = result.text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? null; return { url, deploymentId: url };
  };
  const rollbackAdapter = async (repo: string, slug: string, target: Target, previousSha: string, cwd?: string, useOperatorLogin = false) => {
    if (target.kind === 'convex') { const rollbackWorktree = `${cwd ?? options.home}-rollback`; const added = await git(['worktree', 'add', '--detach', rollbackWorktree, previousSha], repo); if ((added.code ?? 0) !== 0) throw new Error('could not create rollback worktree'); try { await adapter(repo, slug, target, previousSha, rollbackWorktree, useOperatorLogin); } finally { try { await git(['worktree', 'remove', '--force', rollbackWorktree], repo); } catch { /* cleanup is best effort */ } } return; }
    if (target.kind !== 'vercel' || (target.mode ?? 'cli') !== 'cli' || preview(target)) throw new Error('Vercel rollback is only available for a production CLI deployment'); await run('vercel', ['rollback', previousSha], target, useOperatorLogin, cwd, useOperatorLogin ? vercelProjectEnv(repo, target) : {});
  };
  const smoke = async (target: Target, url: string | null, cwd: string, useOperatorLogin: boolean): Promise<Record<string, unknown>> => {
    const credentials = secretEnv(target, !useOperatorLogin, 'branch preview deploys require scoped credentials'); const result: { commands: unknown[]; http: unknown[] } = { commands: [], http: [] }; const secrets = credentials.redact; const source = sourceEnv(); const baseEnv: NodeJS.ProcessEnv = { PATH: source.PATH ?? '', HELM_DEPLOY_URL: url ?? '' };
    for (const name of options.smokeEnvAllowlist ?? []) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && source[name] !== undefined) baseEnv[name] = source[name];
    return withTempHome(baseEnv, async (smokeEnv) => {
      for (const command of target.smoke.commands ?? []) { const argv = tokens(command.command); const out = await exec(argv[0]!, argv.slice(1), { cwd, env: smokeEnv, timeout: 300_000 }); const output = secrets(`${out.stdout}${out.stderr ?? ''}`).slice(-4000); result.commands.push({ name: command.name, ok: (out.code ?? 0) === 0, output }); if ((out.code ?? 0) !== 0) throw new Error(`smoke command failed: ${command.name}: ${output}`); }
      for (const check of target.smoke.http ?? []) { if (!url) throw new Error(`HTTP smoke check needs a deployment URL: ${check.path}`); const response = await fetchImpl(new URL(check.path, url), { signal: AbortSignal.timeout(300_000) }); const rawBody = await response.text(); const body = secrets(rawBody).slice(0, 4000); const ok = response.status === check.status && (check.contains === undefined || rawBody.includes(check.contains)); result.http.push({ path: check.path, status: response.status, ok, ...(body ? { body } : {}) }); if (!ok) throw new Error(`HTTP smoke check failed: ${check.path}`); }
      return result;
    });
  };
  const save = (id: string, patch: Record<string, unknown>) => { const entries = Object.entries(patch); const values = entries.map(([, value]) => value as string | number | bigint | Uint8Array | null); options.store.sql.prepare(`UPDATE deploys SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`).run(...values, id); };
  const previous = (project: string, target: string) => { const value = options.store.sql.prepare("SELECT * FROM deploys WHERE project = ? AND target = ? AND state = 'succeeded' ORDER BY at DESC LIMIT 1").get(project, target) as Record<string, unknown> | undefined; return value ? row(value) : undefined; };
  async function runDeployLocked(input: DeployInput, resolved: { repo: string; slug: string }): Promise<ToolOutcome<{ deploy: DeployRow; warning?: string }>> {
    let reservation: TapReservation | undefined; let deployId: string | undefined; let redact = (value: unknown) => String(value);
    try {
      const branch = await options.workspace.defaultBranch(resolved.repo); const requestedSha = input.sha ?? branch; if (requestedSha.startsWith('-')) throw new Error('invalid commit reference'); const resolvedResult = await git(['rev-parse', '--verify', `${requestedSha}^{commit}`], resolved.repo); const sha = resolvedResult.stdout.trim().toLowerCase(); if ((resolvedResult.code ?? 0) !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`commit reference did not resolve to a full SHA: ${requestedSha}`); const config = await loadRepoConfig(resolved.repo, sha, false); const prior = previous(resolved.slug, input.target); let target: Target; let deployTarget: Target; let externalTap = false;
      const fetched = await git(['fetch', 'origin', branch], resolved.repo);
      if ((fetched.code ?? 0) !== 0) throw new Error('base ref stale');
      const ancestry = await git(['merge-base', '--is-ancestor', sha, `origin/${branch}`], resolved.repo);
      const onBase = (ancestry.code ?? 0) === 0;
      let baseConfig: RepoConfig | undefined;
      if (!onBase) {
        try { baseConfig = await loadRepoConfig(resolved.repo, `origin/${branch}`, false); } catch { /* TestFlight fails closed below; previews need a base config. */ }
      }
      if (onBase) {
        target = targetFor(config, input.target);
      } else {
        if (!baseConfig) throw new Error('base ref stale');
        try { target = targetFor(baseConfig, input.target); } catch { throw new Error('target not defined on base'); }
        if (target.kind === 'testflight') throw new Error('testflight deploys require a base-branch sha');
        if (!preview(target)) throw new Error(`sha ${sha} is not on base branch ${branch}`);
      }
      deployTarget = target;
      if (target.kind === 'testflight') {
        let baseTarget: Target | undefined;
        try { baseTarget = targetFor(baseConfig ?? await loadRepoConfig(resolved.repo, `origin/${branch}`, false), input.target); } catch { /* fail closed below */ }
        deployTarget = { ...target, platform: baseTarget?.platform, lane: baseTarget?.lane, external: baseTarget?.external };
        externalTap = baseTarget === undefined || baseTarget.external === true || !prior;
        if (prior) { const changed = await git(['diff', '--name-only', prior.sha, sha], resolved.repo); externalTap ||= (changed.code ?? 0) !== 0 || requiresExternalTap(changed.stdout.split(/\r?\n/).filter(Boolean)); }
      }
      const providerLogin = onBase && productionTarget(target) && (target.kind === 'vercel' || target.kind === 'convex');
      const loginFallback = providerLogin && !hasScopedCredentials(target);
      if (onBase && !productionTarget(target)) secretEnv(target, true, 'branch preview deploys require scoped credentials');
      const smokeTarget = deployTarget;
      const globs = target.kind === 'convex' ? await migrationGlobs(resolved.repo, prior?.sha ?? null, target, !onBase) : []; const migration = target.kind === 'convex' ? await hasSchemaDiff(resolved.repo, globs, prior?.sha ?? null, sha) : false; const migrationAction = `convex.migration:${resolved.slug}:${target.name}:${prior?.sha ?? 'none'}:${sha}`; const action = migration ? migrationAction : `deploy.run:${resolved.slug}:${target.name}:${sha}`; const deployKinds = [`deploy.${target.name}`, ...(loginFallback && target.name !== 'prod' ? ['deploy.prod'] : [])]; const baseKinds = migration ? [...deployKinds, 'convex.migration'] : deployKinds; const kinds = externalTap ? [...baseKinds, 'testflight.external'] : baseKinds; const decisions = await Promise.all(kinds.map((kind) => options.envelope({ project: resolved.slug, actions: [action], kind, baseRef: branch }))); for (const decision of decisions) if (!decision.ok) return decision; const verdicts = decisions.map((decision) => decision.ok ? decision.decisions[0]?.decision : undefined); if (verdicts.some((verdict) => !verdict)) return { ok: false, reason: `envelope returned no decision for ${target.kind}` }; if (verdicts.some((verdict) => verdict === 'never')) { const refusedKind = target.kind === 'testflight' && externalTap && verdicts.at(-1) === 'never' ? 'testflight.external' : kinds[0]; return { ok: false, reason: `deployment refused for ${refusedKind}` }; } const knownVerdicts = verdicts.filter((verdict): verdict is string => Boolean(verdict)); const verdict = knownVerdicts.reduce((left, right) => moreRestrictive(left, right), 'allow'); const hardMigrationTap = migration && (!preview(target) || loginFallback); if (hardMigrationTap || verdict === 'tap') { const migrationTap = migration && (hardMigrationTap || verdicts[kinds.indexOf('convex.migration')] === 'tap'); const externalTapKind = externalTap && verdicts[kinds.indexOf('testflight.external')] === 'tap'; const tapKind = migrationTap ? 'convex.migration' : externalTapKind ? 'testflight.external' : `deploy.${target.name}`; if (!input.tapId) return { ok: false, reason: `tap required for ${tapKind}: ${action}` }; const reserved = options.reserveTap(resolved.slug, tapKind, action, input.tapId); if (typeof reserved === 'string') return { ok: false, reason: `tap required for ${tapKind}: ${reserved}` }; reservation = reserved; }
      deployId = `d-${randomUUID()}`; const at = now().toISOString(); options.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, bootId, reason, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(deployId, resolved.slug, target.name, target.kind, typeof target.env === 'string' ? target.env : JSON.stringify(target.env), sha, 'deploying', options.bootId ?? null, null, null, null, prior?.deploymentId ?? null, '{}', reservation?.tapId ?? null, at);
      const worktree = join(options.home, 'deploys', resolved.slug.replace(/\//g, '__'), deployId); mkdirSync(join(options.home, 'deploys', resolved.slug.replace(/\//g, '__')), { recursive: true }); let created = false;
      let live = false;
      try { const added = await git(['worktree', 'add', '--detach', worktree, sha], resolved.repo); if ((added.code ?? 0) !== 0) throw new Error(redact(added.stderr || added.stdout || 'could not create deploy worktree')); created = true; const deployed = await adapter(resolved.repo, resolved.slug, deployTarget, sha, worktree, providerLogin); live = Boolean(deployed.deploymentId || deployed.url); const smokeResult = await smoke(smokeTarget, deployed.url, worktree, providerLogin); save(deployId, { state: 'succeeded', url: deployed.url, deploymentId: deployed.deploymentId, smoke: JSON.stringify(smokeResult) }); const saved = row(options.store.sql.prepare('SELECT * FROM deploys WHERE id = ?').get(deployId) as Record<string, unknown>); options.store.appendEvent(`project:${resolved.slug}`, 'deploy', { project: resolved.slug, id: deployId, target: target.name, kind: target.kind, state: 'succeeded', ...(deployed.deploymentId ? { deploymentId: deployed.deploymentId } : {}), ...(deployed.url ? { url: redact(deployed.url) } : {}) }); let tapWarning: string | undefined; if (reservation) { try { options.commitTap(reservation); } catch (error) { const reason = redact(error instanceof Error ? error.message : error); tapWarning = `tap commit failed: ${reason}`; options.store.appendEvent(`project:${resolved.slug}`, 'error', { project: resolved.slug, id: deployId, target: target.name, kind: target.kind, operation: 'tap commit', reason }); } } const rollbackWarning = target.kind === 'testflight' && target.rollback !== 'none' ? 'TestFlight rollback is disabled; treating configured rollback as none' : undefined; const warning = [rollbackWarning, tapWarning].filter(Boolean).join('; ') || undefined; return { ok: true, deploy: saved, ...(warning ? { warning } : {}) }; }
      catch (error) { const schemaFailure = migration; const reason = redact(error instanceof Error ? error.message : error); const schemaRollback = schemaFailure ? 'manual (schema change)' : undefined; const rollback = target.kind === 'testflight' ? 'none' : target.rollback; save(deployId, { state: schemaFailure ? 'manual' : 'failed', smoke: JSON.stringify({ error: reason, ...(schemaRollback ? { rollback: schemaRollback } : {}) }) }); const priorDeployment = previous(resolved.slug, target.name); if (live && !migration && rollback === 'auto' && priorDeployment?.deploymentId) { try { await rollbackAdapter(resolved.repo, resolved.slug, target, target.kind === 'convex' ? priorDeployment.sha : priorDeployment.deploymentId, worktree, providerLogin); save(deployId, { state: 'rolledback' }); options.store.appendEvent(`project:${resolved.slug}`, 'deploy.rolledback', { project: resolved.slug, id: deployId, target: target.name, kind: target.kind, previousId: priorDeployment.deploymentId }); } catch (rollbackError) { const rollbackReason = redact(rollbackError instanceof Error ? rollbackError.message : rollbackError); options.store.appendEvent(`project:${resolved.slug}`, 'deploy.failed', { project: resolved.slug, id: deployId, target: target.name, kind: target.kind, reason, rollbackError: rollbackReason }); } } else options.store.appendEvent(`project:${resolved.slug}`, 'deploy.failed', { project: resolved.slug, id: deployId, target: target.name, kind: target.kind, reason, ...(schemaRollback ? { rollback: schemaRollback } : {}) }); throw new Error(reason); }
      finally { if (created) { try { await git(['worktree', 'remove', '--force', worktree], resolved.repo); } catch { /* cleanup is best effort */ } } }
    } catch (error) { if (reservation) options.rollbackTap(reservation); return { ok: false, reason: redact(error instanceof Error ? error.message : error) }; }
  }
  async function runDeploy(input: DeployInput): Promise<ToolOutcome<{ deploy: DeployRow; warning?: string }>> {
    let resolved: { repo: string; slug: string };
    try { resolved = await options.resolveRepo(input.project); } catch (error) { return { ok: false, reason: String(error instanceof Error ? error.message : error) }; }
    const key = lockKey(resolved.slug, input.target);
    if (inProgress.has(key)) return { ok: false, reason: 'deploy in progress' };
    inProgress.add(key);
    try { return await runDeployLocked(input, resolved); } finally { inProgress.delete(key); }
  }
  async function status(input: DeployStatusInput): Promise<ToolOutcome<{ deploys: DeployRow[] }>> { const clauses: string[] = []; const args: string[] = []; if (input.project) { clauses.push('project = ?'); args.push(input.project); } if (input.id) { clauses.push('id = ?'); args.push(input.id); } const rows = options.store.sql.prepare(`SELECT * FROM deploys${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY at DESC`).all(...args) as Record<string, unknown>[]; return { ok: true, deploys: rows.map(row) }; }
  async function rollback(input: DeployRollbackInput): Promise<ToolOutcome<{ deploy: DeployRow }>> {
    const value = options.store.sql.prepare('SELECT * FROM deploys WHERE id = ?').get(input.id) as Record<string, unknown> | undefined;
    if (!value) return { ok: false, reason: 'deployment not found' };
    const current = row(value);
    const key = lockKey(current.project, current.target);
    if (inProgress.has(key)) return { ok: false, reason: 'deploy in progress' };
    inProgress.add(key);
    try {
      if (current.state !== 'succeeded' && current.state !== 'live') return { ok: false, reason: 'deployment is not in a succeeded or live state' };
      if (!current.previousId) return { ok: false, reason: 'deployment has no previous deployment' };
      let reservation: TapReservation | undefined;
      try {
        const resolved = await options.resolveRepo(current.project); const config = await loadRepoConfig(resolved.repo, current.sha, false); const target = targetFor(config, current.target); const action = `deploy.rollback:${current.id}:${current.previousId}`; const decision = await options.envelope({ project: current.project, actions: [action], kind: `deploy.${target.name}` }); if (!decision.ok) return decision; const verdict = decision.decisions[0]?.decision; if (!verdict) return { ok: false, reason: `envelope returned no decision for ${target.kind}` }; if (verdict === 'never') return { ok: false, reason: `rollback refused for ${target.kind}` }; if (verdict === 'tap') { if (!input.tapId) return { ok: false, reason: `tap required for deploy.${target.name}` }; const reserved = options.reserveTap(current.project, `deploy.${target.name}`, action, input.tapId); if (typeof reserved === 'string') return { ok: false, reason: `tap required for deploy.${target.name}: ${reserved}` }; reservation = reserved; } await rollbackAdapter(resolved.repo, resolved.slug, target, current.previousId, undefined, productionTarget(target) && (target.kind === 'vercel' || target.kind === 'convex')); save(current.id, { state: 'rolledback' }); if (reservation) options.commitTap(reservation); options.store.appendEvent(`project:${current.project}`, 'deploy.rolledback', { project: current.project, id: current.id, target: current.target, kind: current.kind, previousId: current.previousId }); return { ok: true, deploy: row(options.store.sql.prepare('SELECT * FROM deploys WHERE id = ?').get(current.id) as Record<string, unknown>) };
      } catch (error) { if (reservation) options.rollbackTap(reservation); return { ok: false, reason: String(error instanceof Error ? error.message : error) }; }
    } finally { inProgress.delete(key); }
  }
  return { run: runDeploy, status, rollback, isInProgress: (project: string, target: string) => inProgress.has(lockKey(project, target)) };
}

registerWakeKind('deploy.failed', (event, project, now) => ({ id: `wake-deploy-${randomUUID()}`, project, kind: 'deploy.failed', workerId: event.workerId, summary: `deployment failed: ${String(event.data.reason ?? event.data.target ?? 'unknown')}`, command: false, createdAt: now }));
