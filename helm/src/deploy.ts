import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoConfig } from './repoconfig.js';
import { loadRepoConfig } from './repoconfig.js';
import type { Store, ToolOutcome, Workspace } from './types.js';
import { loadEnvFile } from './settings.js';
import { registerWakeKind } from './supervise.js';

export type DeployInput = Readonly<{ project: string; target: string; sha?: string; tapId?: string }>;
export type DeployStatusInput = Readonly<{ project?: string; id?: string }>;
export type DeployRollbackInput = Readonly<{ id: string; tapId?: string }>;
export type DeployRow = Readonly<{ id: string; project: string; target: string; kind: string; env: string; sha: string; state: string; url: string | null; deploymentId: string | null; previousId: string | null; smoke: Record<string, unknown>; tapId: string | null; at: string }>;
export type DeployExec = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<{ stdout: string; stderr?: string; code?: number }>;
type Target = NonNullable<RepoConfig['deploy']>['targets'][number];
type TapReservation = Readonly<{ tapId: string; token: string }>;
type Options = Readonly<{
  store: Store; home: string; workspace: Pick<Workspace, 'defaultBranch'>;
  resolveRepo: (project: string) => Promise<{ repo: string; slug: string }>;
  envelope: (input: { project: string; actions: string[]; kind: string; baseRef?: string }) => Promise<ToolOutcome<{ decisions: Array<{ decision: string }> }>>;
  reserveTap: (project: string, kind: string, action: string, tapId?: string) => TapReservation | string;
  commitTap: (reservation: TapReservation) => void; rollbackTap: (reservation: TapReservation) => void;
  exec?: DeployExec; fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv; smokeEnvAllowlist?: readonly string[]; now?: () => Date;
}>;
export type DeployService = Readonly<{
  run(input: DeployInput): Promise<ToolOutcome<{ deploy: DeployRow }>>;
  status(input: DeployStatusInput): Promise<ToolOutcome<{ deploys: DeployRow[] }>>;
  rollback(input: DeployRollbackInput): Promise<ToolOutcome<{ deploy: DeployRow }>>;
}>;

const realExec = promisify(execFile);
const defaultExec: DeployExec = async (file, args, options) => {
  try { const result = await realExec(file, args, { cwd: options.cwd, env: options.env, timeout: options.timeout, maxBuffer: 16 * 1024 * 1024 }); return { stdout: result.stdout, stderr: result.stderr, code: 0 }; }
  catch (error) { const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }; return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message ?? ''), code: typeof e.code === 'number' ? e.code : 1 }; }
};

export function ensureDeployTable(store: Store): void {
  store.sql.exec(`CREATE TABLE IF NOT EXISTS deploys (id TEXT PRIMARY KEY, project TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, env TEXT NOT NULL, sha TEXT NOT NULL, state TEXT NOT NULL, url TEXT, deploymentId TEXT, previousId TEXT, smoke JSON NOT NULL, tapId TEXT, at TEXT NOT NULL)`);
}

function row(value: Record<string, unknown>): DeployRow { return { id: String(value.id), project: String(value.project), target: String(value.target), kind: String(value.kind), env: String(value.env), sha: String(value.sha), state: String(value.state), url: (value.url as string | null) ?? null, deploymentId: (value.deploymentId as string | null) ?? null, previousId: (value.previousId as string | null) ?? null, smoke: JSON.parse(String(value.smoke ?? '{}')) as Record<string, unknown>, tapId: (value.tapId as string | null) ?? null, at: String(value.at) }; }
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
function preview(target: Target): boolean { return /^(preview|pr)$/i.test(typeof target.env === 'string' ? target.env : '') || /^preview/i.test(target.name); }
function envNames(target: Target): Record<string, string> {
  if (target.kind === 'convex') return { CONVEX_DEPLOY_KEY: typeof target.env === 'string' ? target.env : target.env.CONVEX_DEPLOY_KEY ?? 'CONVEX_DEPLOY_KEY' };
  if (target.mode === 'git') return {};
  const configured = typeof target.env === 'string' ? {} : target.env;
  return {
    VERCEL_TOKEN: configured.VERCEL_TOKEN ?? 'VERCEL_TOKEN',
    VERCEL_ORG_ID: configured.VERCEL_ORG_ID ?? 'VERCEL_ORG_ID',
    VERCEL_PROJECT_ID: configured.VERCEL_PROJECT_ID ?? 'VERCEL_PROJECT_ID',
    ...configured,
  };
}

export function createDeploy(options: Options) {
  const exec = options.exec ?? defaultExec; const fetchImpl = options.fetch ?? globalThis.fetch; const now = options.now ?? (() => new Date()); const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  ensureDeployTable(options.store);
  const secretEnv = (target: Target) => { const source = { ...loadEnvFile(join(homedir(), '.config', 'helm', 'env')), ...process.env, ...(options.env ?? {}) }; const values: Record<string, string> = {}; for (const [key, name] of Object.entries(envNames(target))) { const value = source[name]; if (!value) throw new Error(`missing credential ${name}`); values[key] = value; } return { values, redact: redactor(Object.values(values)) }; };
  const run = async (file: string, args: string[], target: Target, cwd?: string) => { const credentials = secretEnv(target); const result = await exec(file, args, { cwd, env: { ...process.env, ...(options.env ?? {}), ...credentials.values }, timeout: 300_000 }); if ((result.code ?? 0) !== 0) throw new Error(credentials.redact(result.stderr || result.stdout || `${file} failed`)); return { text: credentials.redact(result.stdout), credentials }; };
  const defaultMigrationGlobs = ['convex/schema.ts', 'convex/migrations/**'];
  const globMatch = (file: string, glob: string): boolean => { const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'); return new RegExp(`^${escaped}$`).test(file); };
  const migrationGlobs = async (repo: string, previousSha: string | null, target: Target): Promise<string[]> => {
    const configured: string[] = [];
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
    const result = await exec('git', ['diff', '--name-only', `${previousSha}..${sha}`], { cwd: repo });
    if ((result.code ?? 0) !== 0) throw new Error('could not inspect Convex migration diff');
    return result.stdout.split(/\r?\n/).map((file) => file.trim()).filter(Boolean).some((file) => globs.some((glob) => globMatch(file, glob)));
  };
  const install = async (worktree: string): Promise<void> => {
    const command: readonly [string, string[]] | null = existsSync(join(worktree, 'package-lock.json')) ? ['npm', ['ci']] : existsSync(join(worktree, 'pnpm-lock.yaml')) ? ['pnpm', ['install', '--frozen-lockfile']] : existsSync(join(worktree, 'yarn.lock')) ? ['yarn', ['install', '--frozen-lockfile']] : null;
    if (!command) throw new Error('Convex deploy requires a package lockfile');
    const source = { ...loadEnvFile(join(homedir(), '.config', 'helm', 'env')), ...process.env, ...(options.env ?? {}) };
    const result = await exec(command[0], command[1], { cwd: worktree, env: { PATH: source.PATH ?? '', HOME: source.HOME ?? homedir() }, timeout: 300_000 });
    if ((result.code ?? 0) !== 0) throw new Error(result.stderr || result.stdout || `${command[0]} install failed`);
  };
  const adapter = async (repo: string, slug: string, target: Target, sha: string, worktree?: string): Promise<{ url: string | null; deploymentId: string | null }> => {
    if (target.kind === 'convex') { if (!worktree) throw new Error('Convex deploy requires a worktree'); await install(worktree); const result = await run('npx', ['--no-install', 'convex', 'deploy', '--yes'], target, worktree); return { url: null, deploymentId: sha }; }
    if (target.kind !== 'vercel') throw new Error(`${target.kind} deploy adapter is not available in C2a`);
    if ((target.mode ?? 'cli') === 'git') {
      const deadline = Date.now() + 300_000;
      for (let attempt = 0; attempt < 300 && Date.now() < deadline; attempt++) {
        const result = await run('gh', ['api', `repos/${slug}/deployments?sha=${sha}`], target, repo);
        const deployments = JSON.parse(result.text || '[]') as Array<Record<string, unknown>>;
        for (const deployment of deployments) {
          const id = deployment.id === undefined ? undefined : String(deployment.id);
          if (!id) continue;
          const statuses = await run('gh', ['api', `repos/${slug}/deployments/${id}/statuses`], target, repo);
          const successful = (JSON.parse(statuses.text || '[]') as Array<Record<string, unknown>>).find((status) => String(status.state ?? status.status ?? '').toLowerCase() === 'success');
          if (successful) return { url: typeof successful.environment_url === 'string' && successful.environment_url ? successful.environment_url : typeof successful.target_url === 'string' && successful.target_url ? successful.target_url : null, deploymentId: id };
        }
        if (attempt < 299) await sleep(1000);
      }
      throw new Error('timed out waiting for GitHub deployment');
    }
    const args = ['deploy']; if (!preview(target)) args.push('--prod'); args.push('--yes'); const result = await run('vercel', args, target, worktree); const url = result.text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? null; return { url, deploymentId: url };
  };
  const rollbackAdapter = async (repo: string, slug: string, target: Target, previousSha: string, cwd?: string) => {
    if (target.kind === 'convex') { const rollbackWorktree = `${cwd ?? options.home}-rollback`; const added = await exec('git', ['worktree', 'add', '--detach', rollbackWorktree, previousSha], { cwd: repo }); if ((added.code ?? 0) !== 0) throw new Error('could not create rollback worktree'); try { await adapter(repo, slug, target, previousSha, rollbackWorktree); } finally { try { await exec('git', ['worktree', 'remove', '--force', rollbackWorktree], { cwd: repo }); } catch { /* cleanup is best effort */ } } return; }
    if (target.kind !== 'vercel' || (target.mode ?? 'cli') !== 'cli' || preview(target)) throw new Error('Vercel rollback is only available for a production CLI deployment'); await run('vercel', ['rollback', previousSha], target, cwd);
  };
  const smoke = async (target: Target, url: string | null, cwd: string): Promise<Record<string, unknown>> => {
    const credentials = secretEnv(target); const result: { commands: unknown[]; http: unknown[] } = { commands: [], http: [] }; const secrets = credentials.redact; const source = { ...loadEnvFile(join(homedir(), '.config', 'helm', 'env')), ...process.env, ...(options.env ?? {}) }; const baseEnv: NodeJS.ProcessEnv = { PATH: source.PATH ?? '', HOME: source.HOME ?? homedir(), HELM_DEPLOY_URL: url ?? '' };
    for (const name of options.smokeEnvAllowlist ?? []) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && source[name] !== undefined) baseEnv[name] = source[name];
    for (const command of target.smoke.commands ?? []) { const argv = tokens(command.command); const out = await exec(argv[0]!, argv.slice(1), { cwd, env: baseEnv, timeout: 300_000 }); const output = secrets(`${out.stdout}${out.stderr ?? ''}`).slice(-4000); result.commands.push({ name: command.name, ok: (out.code ?? 0) === 0, output }); if ((out.code ?? 0) !== 0) throw new Error(`smoke command failed: ${command.name}: ${output}`); }
    for (const check of target.smoke.http ?? []) { if (!url) throw new Error(`HTTP smoke check needs a deployment URL: ${check.path}`); const response = await fetchImpl(new URL(check.path, url), { signal: AbortSignal.timeout(300_000) }); const rawBody = await response.text(); const body = secrets(rawBody).slice(0, 4000); const ok = response.status === check.status && (check.contains === undefined || rawBody.includes(check.contains)); result.http.push({ path: check.path, status: response.status, ok, ...(body ? { body } : {}) }); if (!ok) throw new Error(`HTTP smoke check failed: ${check.path}`); }
    return result;
  };
  const save = (id: string, patch: Record<string, unknown>) => { const entries = Object.entries(patch); const values = entries.map(([, value]) => value as string | number | bigint | Uint8Array | null); options.store.sql.prepare(`UPDATE deploys SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`).run(...values, id); };
  const previous = (project: string, target: string) => { const value = options.store.sql.prepare("SELECT * FROM deploys WHERE project = ? AND target = ? AND state = 'succeeded' ORDER BY at DESC LIMIT 1").get(project, target) as Record<string, unknown> | undefined; return value ? row(value) : undefined; };
  async function runDeploy(input: DeployInput): Promise<ToolOutcome<{ deploy: DeployRow }>> {
    let reservation: TapReservation | undefined; let deployId: string | undefined; let redact = (value: unknown) => String(value);
    try {
      const resolved = await options.resolveRepo(input.project); const branch = await options.workspace.defaultBranch(resolved.repo); const requestedSha = input.sha ?? branch; if (requestedSha.startsWith('-')) throw new Error('invalid commit reference'); const resolvedResult = await exec('git', ['rev-parse', '--verify', `${requestedSha}^{commit}`], { cwd: resolved.repo }); const sha = resolvedResult.stdout.trim().toLowerCase(); if ((resolvedResult.code ?? 0) !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`commit reference did not resolve to a full SHA: ${requestedSha}`); const config = await loadRepoConfig(resolved.repo, sha, false); const target = targetFor(config, input.target); const prior = previous(resolved.slug, target.name); const globs = target.kind === 'convex' ? await migrationGlobs(resolved.repo, prior?.sha ?? null, target) : []; const migration = target.kind === 'convex' ? await hasSchemaDiff(resolved.repo, globs, prior?.sha ?? null, sha) : false; const migrationAction = `convex.migration:${resolved.slug}:${target.name}:${prior?.sha ?? 'none'}:${sha}`; const action = migration ? migrationAction : `deploy.run:${resolved.slug}:${target.name}:${sha}`; const kinds = migration ? [`deploy.${target.name}`, 'convex.migration'] : [`deploy.${target.name}`]; const decisions = await Promise.all(kinds.map((kind) => options.envelope({ project: resolved.slug, actions: [action], kind, baseRef: branch }))); for (const decision of decisions) if (!decision.ok) return decision; const verdicts = decisions.map((decision) => decision.ok ? decision.decisions[0]?.decision : undefined); if (verdicts.some((verdict) => verdict === 'never')) return { ok: false, reason: `deployment refused for ${verdicts[0] === 'never' ? kinds[0] : 'convex.migration'}` }; if (verdicts.some((verdict) => !verdict)) return { ok: false, reason: `envelope returned no decision for ${target.kind}` }; const verdict = verdicts.includes('tap') ? 'tap' : 'allow'; const hardMigrationTap = migration && !preview(target); if (hardMigrationTap || verdict === 'tap') { if (!input.tapId) return { ok: false, reason: `tap required for ${migration ? 'convex.migration' : target.kind}: ${action}` }; const reserved = options.reserveTap(resolved.slug, migration ? 'convex.migration' : target.kind, action, input.tapId); if (typeof reserved === 'string') return { ok: false, reason: `tap required for ${migration ? 'convex.migration' : target.kind}: ${reserved}` }; reservation = reserved; }
      redact = secretEnv(target).redact; if (!preview(target)) { const check = await exec('git', ['merge-base', '--is-ancestor', sha, `origin/${branch}`], { cwd: resolved.repo }); if ((check.code ?? 0) !== 0) throw new Error(`sha ${sha} is not on base branch ${branch}`); }
      deployId = `d-${randomUUID()}`; const at = now().toISOString(); options.store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(deployId, resolved.slug, target.name, target.kind, typeof target.env === 'string' ? target.env : JSON.stringify(target.env), sha, 'deploying', null, null, prior?.deploymentId ?? null, '{}', reservation?.tapId ?? null, at);
      const worktree = join(options.home, 'deploys', resolved.slug.replace(/\//g, '__'), deployId); mkdirSync(join(options.home, 'deploys', resolved.slug.replace(/\//g, '__')), { recursive: true }); let created = false;
      let live = false;
      try { const added = await exec('git', ['worktree', 'add', '--detach', worktree, sha], { cwd: resolved.repo }); if ((added.code ?? 0) !== 0) throw new Error(redact(added.stderr || added.stdout || 'could not create deploy worktree')); created = true; const deployed = await adapter(resolved.repo, resolved.slug, target, sha, worktree); live = Boolean(deployed.deploymentId || deployed.url); const smokeResult = await smoke(target, deployed.url, worktree); save(deployId, { state: 'succeeded', url: deployed.url, deploymentId: deployed.deploymentId, smoke: JSON.stringify(smokeResult) }); if (reservation) options.commitTap(reservation); const saved = row(options.store.sql.prepare('SELECT * FROM deploys WHERE id = ?').get(deployId) as Record<string, unknown>); options.store.appendEvent(`project:${resolved.slug}`, 'deploy', { project: resolved.slug, id: deployId, target: target.name, kind: target.kind, state: 'succeeded', ...(deployed.url ? { url: redact(deployed.url) } : {}) }); return { ok: true, deploy: saved }; }
      catch (error) { const schemaFailure = migration; const reason = schemaFailure ? 'schema change; manual rollback' : redact(error instanceof Error ? error.message : error); save(deployId, { state: schemaFailure ? 'manual' : 'failed', smoke: JSON.stringify({ error: reason }) }); const priorDeployment = previous(resolved.slug, target.name); if (live && !migration && target.rollback === 'auto' && priorDeployment?.deploymentId) { try { await rollbackAdapter(resolved.repo, resolved.slug, target, target.kind === 'convex' ? priorDeployment.sha : priorDeployment.deploymentId, worktree); save(deployId, { state: 'rolledback' }); options.store.appendEvent(`project:${resolved.slug}`, 'deploy.rolledback', { project: resolved.slug, id: deployId, target: target.name, kind: target.kind, previousId: priorDeployment.deploymentId }); } catch (rollbackError) { const rollbackReason = redact(rollbackError instanceof Error ? rollbackError.message : rollbackError); options.store.appendEvent(`project:${resolved.slug}`, 'deploy.failed', { project: resolved.slug, id: deployId, target: target.name, kind: target.kind, reason, rollbackError: rollbackReason }); } } else options.store.appendEvent(`project:${resolved.slug}`, 'deploy.failed', { project: resolved.slug, id: deployId, target: target.name, kind: target.kind, reason }); throw new Error(reason); }
      finally { if (created) { try { await exec('git', ['worktree', 'remove', '--force', worktree], { cwd: resolved.repo }); } catch { /* cleanup is best effort */ } } }
    } catch (error) { if (reservation) options.rollbackTap(reservation); return { ok: false, reason: redact(error instanceof Error ? error.message : error) }; }
  }
  async function status(input: DeployStatusInput): Promise<ToolOutcome<{ deploys: DeployRow[] }>> { const clauses: string[] = []; const args: string[] = []; if (input.project) { clauses.push('project = ?'); args.push(input.project); } if (input.id) { clauses.push('id = ?'); args.push(input.id); } const rows = options.store.sql.prepare(`SELECT * FROM deploys${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY at DESC`).all(...args) as Record<string, unknown>[]; return { ok: true, deploys: rows.map(row) }; }
  async function rollback(input: DeployRollbackInput): Promise<ToolOutcome<{ deploy: DeployRow }>> { let reservation: TapReservation | undefined; try { const value = options.store.sql.prepare('SELECT * FROM deploys WHERE id = ?').get(input.id) as Record<string, unknown> | undefined; if (!value) return { ok: false, reason: 'deployment not found' }; const current = row(value); if (!current.previousId) return { ok: false, reason: 'deployment has no previous deployment' }; const resolved = await options.resolveRepo(current.project); const config = await loadRepoConfig(resolved.repo, current.sha, false); const target = targetFor(config, current.target); const action = `deploy.rollback:${current.id}:${current.previousId}`; const decision = await options.envelope({ project: current.project, actions: [action], kind: `deploy.${target.name}` }); if (!decision.ok) return decision; const verdict = decision.decisions[0]?.decision; if (!verdict) return { ok: false, reason: `envelope returned no decision for ${target.kind}` }; if (verdict === 'never') return { ok: false, reason: `rollback refused for ${target.kind}` }; if (verdict === 'tap') { if (!input.tapId) return { ok: false, reason: `tap required for ${target.kind}` }; const reserved = options.reserveTap(current.project, target.kind, action, input.tapId); if (typeof reserved === 'string') return { ok: false, reason: `tap required for ${target.kind}: ${reserved}` }; reservation = reserved; } await rollbackAdapter(resolved.repo, resolved.slug, target, current.previousId); save(current.id, { state: 'rolledback' }); if (reservation) options.commitTap(reservation); options.store.appendEvent(`project:${current.project}`, 'deploy.rolledback', { project: current.project, id: current.id, target: current.target, kind: current.kind, previousId: current.previousId }); return { ok: true, deploy: row(options.store.sql.prepare('SELECT * FROM deploys WHERE id = ?').get(current.id) as Record<string, unknown>) }; } catch (error) { if (reservation) options.rollbackTap(reservation); return { ok: false, reason: String(error instanceof Error ? error.message : error) }; } }
  return { run: runDeploy, status, rollback };
}

registerWakeKind('deploy.failed', (event, project, now) => ({ id: `wake-deploy-${randomUUID()}`, project, kind: 'deploy.failed', workerId: event.workerId, summary: `deployment failed: ${String(event.data.reason ?? event.data.target ?? 'unknown')}`, command: false, createdAt: now }));
