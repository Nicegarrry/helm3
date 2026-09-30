/** The `helm` command line. */
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { EventRow, HelmConfig, InboxState, Store, WorkerRow } from './types.js';
import { createEffectiveSpendReader, ensureHome, loadConfig } from './config.js';
import { openStore } from './store.js';
import { listBudgetStatuses } from './budget.js';
import { gitWorkspace } from './workspace.js';
import { gateRunner } from './gate.js';
import { ghGitHub } from './github.js';
import { piWorkerRunner } from './worker.js';
import { codexWorkerRunner, laneRunner } from './codex.js';
import { builderPrompt, reviewerPrompt, validatorPrompt } from './prompt.js';
import { Helm } from './helm.js';
import { serve, serveStdioProxy, formatWorkerTable, callDaemon } from './server.js';
import { startTicker } from './daemon.js';
import { createInboxTriage, listInbox } from './inbox.js';
import { createJev } from './jev.js';
import { createJevCheck } from './jevcheck.js';
import { createClaims } from './claims.js';
import { loadSettings } from './settings.js';
import { defaultExec, herdrHost, tmuxHost, type Host, type HostExec, type HostStatus } from './host.js';
import type { SupervisorHost, SupervisorRow } from './types.js';
import { createWatcher } from './watch.js';
import { createSupervisor } from './supervise.js';
import { createDiscord } from './discord.js';
import { createReview } from './review.js';
import { createRetry } from './retry.js';
import { createEnvelopeTicker } from './envelope.js';
import { createMemorySync } from './memory-sync.js';
import { createHygiene } from './hygiene.js';
import { createPrTicker } from './pr-watch.js';

import { ownDaemon, readMetadata, VERSION } from './lifecycle.js';
import { launchUpgrade } from '../bin/update.mjs';

function usage(): void {
  console.error(`usage: helm <command> [options]
  spawn --repo <path> --objective <text> [--issue n] [--model <m>] [--difficulty super-easy|easy|normal] [--base-ref r] [--role builder|reviewer]
        [--context path]... [--allow-workflows] [--acceptance text] [--idempotency-key k]
  ps [--repo path] [--state s] [--json]
  logs <id> [-f] [--json]
  inspect <id> [--tail n] [--json]
  wait <id>... [--timeout ms] [--json]
  steer <id> "<message>" [--json]
  inbox [--project slug] [--state open|answered|superseded] [--json]
  reply <question-id> "<answer>" [--json]
  stop <id> [--json]
  gate <id> [--json]
  pr <id> [--title t] [--body b] [--base branch] [--draft] [--json]
  pr-status <id|#n> [--json]
  review <id|#n> [--model m] [--json]
  merge <#n> --head <sha> [--json]
  status [--json]
  cap --usd N [--warn N] [--workers N] [--tap <id>] [--json]
  budget open <project> <label> <capUsd> [--codex-tokens n]
  budget close <project>
  budget [project] [--json]
  tap <id> <code> [--json]
  serve [--stdio|--http] [--port n]
  daemon --action status|drain|resume [--json]
  supervisor register <project> --repo <path> --host herdr|tmux --label <text>
  supervisor start <owner/name> --repo <abs path> [--host herdr|tmux] [--label <text>]
  supervisor list [--json]
  wake <project> "<text>" [--json]
  scorecard <project> [--budget <id>] [--since <iso>] [--json]
  deploy run <project> <target> [--sha <sha>] [--tap-id <id>] [--json]
  deploy status [project] [--id <id>] [--json]
  deploy rollback <id> [--tap-id <id>] [--json]
  jev check --preset <issue|dedupe|verdict|raw> --file <json|md> [--json]
  update --stage <git-ref> [--repo path] | --when-idle [--timeout ms]
  shutdown`);
}

function openReadStore() {
  const config = loadConfig();
  return { config, store: openStore(join(config.home, 'helm.sqlite')) };
}

function prIdent(ref: string): { repoSlug?: string; number: number } | { workerId: string } {
  const stripped = ref.startsWith('#') ? ref.slice(1) : ref;
  const scoped = stripped.match(/^([^#]+)#(\d+)$/);
  if (scoped) return { repoSlug: scoped[1], number: Number(scoped[2]) };
  return /^\d+$/.test(stripped) ? { number: Number(stripped) } : { workerId: ref };
}

function printOutcome(outcome: unknown, json: boolean): void {
  if (outcome === undefined) return; // postTool already reported the error
  if (json) { console.log(JSON.stringify(outcome, null, 2)); return; }
  const o = outcome as Record<string, unknown>;
  if (o.ok === false) {
    console.error(`refused: ${String(o.reason)}`);
    process.exitCode = 1;
    return;
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'ok') continue;
    console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
}

/** Reads serve.json and confirms its pid is actually alive, deleting a stale file if not. */
function readLiveServeJson(serveJsonPath: string): { port: number; pid: number } | undefined {
  if (!existsSync(serveJsonPath)) return undefined;
  const parsed = JSON.parse(readFileSync(serveJsonPath, 'utf8')) as { port: number; pid: number };
  try {
    process.kill(parsed.pid, 0);
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      try { rmSync(serveJsonPath, { force: true }); } catch { /* best effort */ }
      return undefined;
    }
    // Some other error (e.g. EPERM: pid exists but owned by another user) - treat as alive.
    return parsed;
  }
}

async function postTool(name: string, body: unknown): Promise<unknown> {
  const config = loadConfig();
  const serveJsonPath = join(config.home, 'serve.json');
  const live = readLiveServeJson(serveJsonPath);
  if (!live) {
    console.error('helm serve is not running (start it with: helm serve --http)');
    process.exitCode = 2;
    return undefined;
  }
  return callDaemon(live.port, name, body);
}

function toWorkerRowSummary(r: WorkerRow) {
  return { workerId: r.workerId, state: r.state, role: r.role, model: r.model, branch: r.branch, head: r.head, createdAt: r.createdAt };
}

function printEvent(e: EventRow, json: boolean): void {
  console.log(json ? JSON.stringify(e) : `[${e.at}] #${e.seq} ${e.kind} ${JSON.stringify(e.data)}`);
}

type ParsedValues = Record<string, string | boolean | string[] | undefined>;
type CliOptions = Record<string, { type: 'string' | 'boolean'; multiple?: boolean; short?: string }>;

/** Shared shape for the thin write commands: parse args, build a tool body, POST, print. */
async function simpleCmd(
  toolName: string,
  args: string[],
  build: (positionals: string[], values: ParsedValues) => unknown,
  extraOptions: CliOptions = {},
): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, ...extraOptions } });
  const body = build(positionals, values as ParsedValues);
  if (body === undefined) { usage(); process.exitCode = 2; return; }
  printOutcome(await postTool(toolName, body), values.json === true);
}

/** Shared shape for the thin read commands: parse args, open the store, run, close the store. */
async function readCmd(
  args: string[],
  run: (positionals: string[], values: ParsedValues, store: Store, config: HelmConfig) => Promise<void> | void,
  extraOptions: CliOptions = {},
): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, ...extraOptions } });
  const { config, store } = openReadStore();
  try {
    await run(positionals, values as ParsedValues, store, config);
  } finally {
    store.close();
  }
}

const cmdSpawn = (args: string[]) =>
  simpleCmd('worker.spawn', args, (_p, v) => (v.repo && v.objective
    ? { repo: resolve(process.cwd(), v.repo as string), objective: v.objective, issue: v.issue ? Number(v.issue) : undefined, acceptance: v.acceptance, model: v.model, difficulty: v.difficulty,
        baseRef: v['base-ref'], role: v.role, contextPaths: v.context ?? [], allowWorkflows: v['allow-workflows'] ?? false,
        idempotencyKey: v['idempotency-key'] }
    : undefined), {
    repo: { type: 'string' }, objective: { type: 'string' }, issue: { type: 'string' }, acceptance: { type: 'string' }, model: { type: 'string' }, difficulty: { type: 'string' },
    'base-ref': { type: 'string' }, role: { type: 'string' }, context: { type: 'string', multiple: true },
    'allow-workflows': { type: 'boolean' }, 'idempotency-key': { type: 'string' },
  });

const cmdPs = (args: string[]) =>
  readCmd(args, (_p, v, store) => {
    const rows = store.listWorkers({ repo: v.repo as string | undefined, state: v.state as WorkerRow['state'] | undefined });
    if (v.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(formatWorkerTable(rows.map(toWorkerRowSummary)));
  }, { repo: { type: 'string' }, state: { type: 'string' } });

const cmdLogs = (args: string[]) =>
  readCmd(args, async (positionals, v, store) => {
    const workerId = positionals[0];
    if (!workerId) { usage(); process.exitCode = 2; return; }
    let afterSeq = 0;
    for (const e of store.listEvents(workerId, { limit: 100_000 })) { printEvent(e, v.json === true); afterSeq = e.seq; }
    if (!v.follow) return;
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      for (const e of store.listEvents(workerId, { afterSeq, limit: 1000 })) { printEvent(e, v.json === true); afterSeq = e.seq; }
    }
  }, { follow: { type: 'boolean', short: 'f' } });

const cmdInspect = (args: string[]) =>
  readCmd(args, async (positionals, v, store) => {
    const workerId = positionals[0];
    if (!workerId) { usage(); process.exitCode = 2; return; }
    const row = store.getWorker(workerId);
    if (!row) { console.error('worker not found'); process.exitCode = 1; return; }
    const spend = store.spendFor(workerId);
    let diffStat = '';
    try { diffStat = await gitWorkspace().diffStat(row.worktree, row.baseSha); } catch { diffStat = ''; }
    const tail = v.tail ? Number(v.tail) : 20;
    const events = tail > 0 ? store.listEvents(workerId, { limit: 1_000_000 }).slice(-tail) : [];
    const payload = { workerId, state: row.state, model: row.model, branch: row.branch, head: row.head, spendUsd: spend.spendUsd, tokens: spend.tokens, diffStat, result: row.result, events };
    if (v.json) { console.log(JSON.stringify(payload, null, 2)); return; }
    const lines: Array<[string, string | undefined]> = [['worker', workerId], ['state', row.state], ['model', row.model], ['branch', row.branch], ['head', row.head ?? '-'],
      ['spend', `$${spend.spendUsd.toFixed(4)}`], ['result', row.result ? `${row.result.status} - ${row.result.summary}` : undefined], ['diff', diffStat ? `\n${diffStat}` : undefined]];
    for (const [k, val] of lines) if (val !== undefined) console.log(`${k}:`.padEnd(9) + val);
    console.log('events:');
    for (const e of events) console.log(`  [${e.at}] ${e.kind} ${JSON.stringify(e.data)}`);
  }, { tail: { type: 'string' } });

/** `wait` goes through the daemon's worker.wait like the other write-side verbs: the daemon is what runs the workers anyway. */
const cmdWait = (args: string[]) =>
  simpleCmd('worker.wait', args, (p, v) => (p.length > 0 ? { workerIds: p, ...(v.timeout ? { timeoutMs: Number(v.timeout) } : {}) } : undefined), { timeout: { type: 'string' } });

const cmdSteer = (args: string[]) =>
  simpleCmd('worker.steer', args, (p) => (p[0] && p.length > 1 ? { workerId: p[0], message: p.slice(1).join(' ') } : undefined));

const cmdInbox = (args: string[]) =>
  readCmd(args, (_p, v, store) => {
    const rows = listInbox(store.sql, { project: v.project as string | undefined, state: (v.state as InboxState | undefined) ?? 'open' });
    if (v.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log('id\tproject\tworker\tquestion');
    for (const row of rows) console.log(`${row.id}\t${row.project}\t${row.workerId}\t${row.question}`);
  }, { project: { type: 'string' }, state: { type: 'string' } });

const cmdReply = (args: string[]) =>
  simpleCmd('inbox.reply', args, (p) => (p[0] && p.length > 1 ? { id: p[0], answer: p.slice(1).join(' ') } : undefined));

const cmdStop = (args: string[]) => simpleCmd('worker.stop', args, (p) => (p[0] ? { workerId: p[0] } : undefined));

const cmdGate = (args: string[]) => simpleCmd('gate.run', args, (p) => (p[0] ? { workerId: p[0] } : undefined));

const cmdPr = (args: string[]) =>
  simpleCmd('pr.open', args, (p, v) => (p[0] ? { workerId: p[0], title: v.title, body: v.body, base: v.base, draft: v.draft ?? true } : undefined),
    { title: { type: 'string' }, body: { type: 'string' }, base: { type: 'string' }, draft: { type: 'boolean' } });

const cmdPrStatus = (args: string[]) => simpleCmd('pr.status', args, (p) => (p[0] ? prIdent(p[0]) : undefined));

const cmdReview = (args: string[]) =>
  simpleCmd('review.request', args, (p, v) => (p[0] ? { ...prIdent(p[0]), model: v.model } : undefined), { model: { type: 'string' } });

const cmdMerge = (args: string[]) =>
  simpleCmd('pr.merge', args, (p, v) => {
    const ident = p[0] ? prIdent(p[0]) : undefined;
    return ident && 'number' in ident && v.head ? { ...ident, expectedHead: v.head } : undefined;
  },
    { head: { type: 'string' } });

const cmdStatus = (args: string[]) =>
  readCmd(args, (_p, v, store, config) => {
    const total = store.spendTotal();
    const activeWorkers = store.listWorkers().filter((w) => w.state === 'queued' || w.state === 'running').length;
    const spend = createEffectiveSpendReader(config, store, loadSettings(config.home))();
    const payload = { spendUsd: total.spendUsd, spendCapUsd: spend.capUsd, spendWarnUsd: spend.warnUsd, activeWorkers, maxWorkers: spend.maxWorkers, unknownCostEvents: total.unknownCostEvents, projects: listBudgetStatuses(store), spendSources: spend.sources, spendCapSource: spend.sources.capUsd, spendWarnSource: spend.sources.warnUsd, maxWorkersSource: spend.sources.maxWorkers, ...(spend.warning ? { warning: spend.warning } : {}) };
    if (v.json) { console.log(JSON.stringify(payload, null, 2)); return; }
    console.log(`spend:    $${payload.spendUsd.toFixed(4)}${payload.spendCapUsd > 0 ? ` / $${payload.spendCapUsd.toFixed(2)} cap` : ' (no cap)'}`);
    console.log(`warn:     $${payload.spendWarnUsd.toFixed(2)}`);
    console.log(`workers:  ${payload.activeWorkers} / ${payload.maxWorkers} active`);
    if (payload.warning) console.error(`warning:  ${payload.warning}`);
    console.log(`unknown-cost events: ${payload.unknownCostEvents}`);
    for (const project of payload.projects) console.log(`budget:   ${project.project} ${project.label} $${project.spentUsd.toFixed(2)} / $${project.capUsd.toFixed(2)}${project.exhausted ? ' exhausted' : ''}`);
  });
const cmdCap = (args: string[]) =>
  simpleCmd('spend.set', args, (_p, v) => {
    if (v.usd === undefined || !Number.isFinite(Number(v.usd))) return undefined;
    return { capUsd: Number(v.usd), ...(v.warn !== undefined ? { warnUsd: Number(v.warn) } : {}), ...(v.workers !== undefined ? { maxWorkers: Number(v.workers) } : {}), ...(v.tap ? { tapId: v.tap } : {}) };
  }, { usd: { type: 'string' }, warn: { type: 'string' }, workers: { type: 'string' }, tap: { type: 'string' } });

async function cmdBudget(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, 'codex-tokens': { type: 'string' } } });
  const [action, project, label, cap] = positionals;
  if (action === 'open') {
    if (!project || !label || !cap || !Number.isFinite(Number(cap))) { usage(); process.exitCode = 2; return; }
    printOutcome(await postTool('budget.open', { project, label, capUsd: Number(cap), ...(values['codex-tokens'] ? { codexTokens: Number(values['codex-tokens']) } : {}) }), values.json === true);
    return;
  }
  if (action === 'close') {
    if (!project) { usage(); process.exitCode = 2; return; }
    printOutcome(await postTool('budget.close', { project }), values.json === true);
    return;
  }
  const { store } = openReadStore();
  try {
    const budgets = listBudgetStatuses(store, action);
    if (values.json === true) console.log(JSON.stringify({ ok: true, budgets }, null, 2));
    else for (const budget of budgets) console.log(`${budget.project} ${budget.label}: $${budget.spentUsd.toFixed(2)} / $${budget.capUsd.toFixed(2)} (${budget.remainingUsd.toFixed(2)} remaining, ${budget.workerCount} workers)${budget.exhausted ? ' exhausted' : ''}`);
  } finally {
    store.close();
  }
}

const cmdTap = (args: string[]) => simpleCmd('tap.confirm', args, (p) => (p[0] && p[1] ? { id: p[0], code: p[1] } : undefined));

const cmdSupervisor = async (args: string[]): Promise<void> => {
  const [verb, ...rest] = args;
  if (verb === 'list') {
    await simpleCmd('supervisor.list', rest, () => ({}));
    return;
  }
  if (verb === 'register') {
    await simpleCmd('supervisor.register', rest, (positionals, values) => (
      positionals[0] && values.repo && values.host && values.label
        ? { project: positionals[0], repo: resolve(process.cwd(), values.repo as string), host: values.host, label: values.label }
        : undefined
    ), { repo: { type: 'string' }, host: { type: 'string' }, label: { type: 'string' } });
    return;
  }
  if (verb === 'start') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { repo: { type: 'string' }, host: { type: 'string' }, label: { type: 'string' }, json: { type: 'boolean' } },
    });
    const project = positionals[0];
    if (!project) { usage(); process.exitCode = 2; return; }
    const { config, store } = openReadStore();
    try {
      const listed = createSupervisor({ store, settings: loadSettings(config.home), hosts: { herdr: herdrHost(), tmux: tmuxHost() } }).list();
      const registered = listed.ok
        ? listed.supervisors.find((row: SupervisorRow) => row.project === project) ?? null
        : null;
      await startSupervisor({
        project,
        repo: values.repo as string | undefined,
        host: values.host as SupervisorHost | undefined,
        label: values.label as string | undefined,
        json: values.json === true,
      }, { registered, settings: loadSettings(config.home), exec: defaultExec });
    } finally {
      store.close();
    }
    return;
  }
  usage();
  process.exitCode = 2;
};

type StartSupervisorInput = Readonly<{
  project: string;
  repo?: string;
  host?: SupervisorHost;
  label?: string;
  json?: boolean;
}>;

type StartSupervisorDeps = Readonly<{
  host?: Host;
  exec?: HostExec;
  hosts?: Readonly<Record<SupervisorHost, Host>>;
  registered?: SupervisorRow | null;
  settings?: ReturnType<typeof loadSettings>;
  daemon?: () => Promise<{ port: number; pid: number }>;
  register?: (input: { project: string; repo: string; host: SupervisorHost; label: string }) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  warn?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  home?: string;
}>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function claudeBinary(env: NodeJS.ProcessEnv): string {
  const configured = env.HELM_CLAUDE_BIN;
  if (configured) return configured;
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

function supervisorCommand(project: string, label: string, settings: ReturnType<typeof loadSettings>, env: NodeJS.ProcessEnv): string {
  if (settings.supervisor.command) return settings.supervisor.command;
  return `${claudeBinary(env)} --remote-control ${shellQuote(label)} ${shellQuote(`Use the helm-supervisor skill. You are the supervisor for ${project}. Run its startup read order.`)}`;
}

function preflight(repo: string, warn: (line: string) => void, home: string): void {
  const mcpPath = join(repo, '.mcp.json');
  let hasHelm = false;
  try {
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as Record<string, unknown>;
    const servers = parsed.mcpServers ?? parsed.servers;
    hasHelm = Boolean(servers && typeof servers === 'object' && Object.keys(servers as object).some((key) => key === 'helm'));
  } catch { /* warning below is intentionally non-fatal */ }
  if (!hasHelm) warn(`warning: ${repo}/.mcp.json has no helm server`);
  const skill = join(home, '.claude', 'skills', 'helm-supervisor');
  if (!existsSync(skill)) warn(`warning: helm-supervisor skill is missing at ${skill}`);
}

/** Starts or reattaches the owner session. Dependencies are injectable for fake-exec tests. */
export async function startSupervisor(input: StartSupervisorInput, deps: StartSupervisorDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((line: string) => console.error(line));
  const home = deps.home ?? homedir();
  const settings = deps.settings ?? loadSettings(loadConfig().home);
  const registered = deps.registered ?? null;
  const repo = input.repo ? resolve(process.cwd(), input.repo) : registered?.repo;
  const label = input.label ?? registered?.label;
  if (!repo || !label) throw new Error('supervisor start needs --repo and --label the first time');
  preflight(repo, warn, home);

  const exec = deps.exec;
  let hostName = input.host ?? registered?.host;
  if (!hostName && !deps.host) {
    if (!exec) throw new Error('supervisor start cannot detect a host without exec');
    try { await exec('herdr', ['status', 'server']); hostName = 'herdr'; } catch { hostName = 'tmux'; }
  }
  if (!hostName) hostName = 'herdr';
  if (hostName !== 'herdr' && hostName !== 'tmux') throw new Error(`invalid supervisor host: ${hostName}`);
  const hosts = deps.hosts ?? { herdr: herdrHost(exec), tmux: tmuxHost(exec) };
  const host = deps.host ?? hosts[hostName];
  const command = supervisorCommand(input.project, label, settings, env);
  let pane = await host.resolve(label);
  let launched = false;
  if (pane) {
    const status = await host.status(pane);
    if (status === 'unknown') { await host.send(pane, command); launched = true; }
    else if (!input.json) console.log(`attached ${label} ${pane.id}`);
  } else {
    pane = await host.create(label, repo, command);
    if (!pane) throw new Error(`host did not create a pane for ${label}`);
    launched = true;
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const clock = deps.clock ?? (() => Date.now());
  const warnIfBlocked = (status: HostStatus) => {
    if (status === 'blocked') warn(`warning: supervisor ${label} is blocked (likely a folder-trust prompt)`);
  };
  if (launched) {
    const deadline = clock() + 8_000;
    let polls = 0;
    while (polls < 16) {
      const status = await host.status(pane);
      if (status === 'blocked') {
        warnIfBlocked(status);
        break;
      }
      if (clock() >= deadline) break;
      polls += 1;
      await sleep(500);
    }
  } else {
    warnIfBlocked(await host.status(pane));
  }

  if (deps.daemon) await deps.daemon();
  if (deps.register) {
    await deps.register({ project: input.project, repo, host: hostName, label });
  } else {
    const config = loadConfig();
    const serveJsonPath = join(config.home, 'serve.json');
    if (!readLiveServeJson(serveJsonPath)) await startDetachedDaemon(config.home, serveJsonPath, 0);
    printOutcome(await postTool('supervisor.register', { project: input.project, repo, host: hostName, label }), input.json === true);
  }
}

const cmdWake = (args: string[]) =>
  readCmd(args, (_positionals, values, store) => {
    const project = _positionals[0];
    const text = _positionals.slice(1).join(' ');
    if (!project || !text) { usage(); process.exitCode = 2; return; }
    const service = createSupervisor({ store, settings: loadSettings(loadConfig().home), hosts: { herdr: herdrHost(), tmux: tmuxHost() } });
    printOutcome(service.manualWake(project, text), values.json === true);
  });

const cmdJev = async (args: string[]): Promise<void> => {
  const [verb, ...rest] = args;
  if (verb !== 'check') { usage(); process.exitCode = 2; return; }
  const { values } = parseArgs({ args: rest, options: { preset: { type: 'string' }, file: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' } } });
  if (!values.preset || !values.file) { usage(); process.exitCode = 2; return; }
  const contents = readFileSync(resolve(process.cwd(), values.file as string), 'utf8');
  const input = (values.file as string).endsWith('.json') ? JSON.parse(contents) : contents;
  printOutcome(await postTool('jev.check', { preset: values.preset, project: values.project, input }), values.json === true);
};

/** HTTP owns the daemon; stdio attaches or starts it. See README.md. */
async function cmdServe(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { stdio: { type: 'boolean' }, http: { type: 'boolean' }, port: { type: 'string' } } });
  const config = loadConfig();
  ensureHome(config);
  const serveJsonPath = join(config.home, 'serve.json');
  const port = values.port ? Number(values.port) : 0;
  if (values.stdio && !values.http) {
    const live = readLiveServeJson(serveJsonPath) ?? (await startDetachedDaemon(config.home, serveJsonPath, port));
    const handle = await serveStdioProxy(live.port);
    console.error(`helm stdio front-end attached to daemon pid ${live.pid} on port ${live.port}`);
    await handle.closed;
    await handle.close();
    process.exit(0);
  }
  const live = readLiveServeJson(serveJsonPath);
  if (live) { console.error(`helm serve is already running (pid ${live.pid})`); process.exitCode = 2; return; }
  const pending = readMetadata(join(config.home, 'upgrade.json'));
  if (existsSync(join(config.home, 'upgrade.lock')) && (process.env.HELM_UPGRADE_ID !== pending?.id || pending?.phase !== 'starting' || readMetadata(join(config.home, 'upgrade.lock', 'owner.json'))?.id !== pending?.id)) throw new Error('upgrade owns startup; wait for it to finish');
  const releaseOwner = ownDaemon(config.home);
  const store = openStore(join(config.home, 'helm.sqlite'));
  const settings = loadSettings(config.home);
  const discord = createDiscord({ store, settings, home: config.home });
  const jev = createJev({ settings, store, env: process.env });
  const workspace = gitWorkspace();
  const github = ghGitHub();
  const helm = new Helm({
    config, store, workspace, gates: gateRunner({ keepNodeModules: settings.hygiene.keepNodeModules }), github,
    runner: laneRunner({ pi: piWorkerRunner(), codex: codexWorkerRunner() }), prompts: { builder: builderPrompt, reviewer: reviewerPrompt, validator: validatorPrompt },
    spendStartup: true,
    supervisor: createSupervisor({ store, settings, hosts: { herdr: herdrHost(), tmux: tmuxHost() } }),
    discord,
    review: createReview({ store, github, workspace, jev, settings }),
    retry: createRetry({ store, settings, github, workspace }),
    jevChecker: createJevCheck({ jev, store }),
    jev,
    claims: createClaims({ jev, store, settings, workspace }),
  });
  const predecessorBootId = process.env.HELM_UPGRADE_ID && pending?.id === process.env.HELM_UPGRADE_ID && pending.phase === 'starting'
    ? String((pending.source as Record<string, unknown> | undefined)?.bootId ?? '') || undefined
    : undefined;
  await helm.markInterruptedOnStart(predecessorBootId);
  const hygiene = createHygiene({ home: config.home, store, settings, workspace, github, isRunning: (workerId) => helm.isWorkerRunning(workerId), withWorkerLock: (workerId, fn) => helm.withWorkerLock(workerId, fn), deployInProgress: (project, target) => helm.deploy.isInProgress(project, target) });
  const handle = await serve({ helm, port }).catch((err) => { store.close(); releaseOwner(); throw err; });
  const stopWake = startTicker(1000, [helm.supervisor?.tick ?? (() => undefined), helm.tapTick.bind(helm), createInboxTriage({ store, settings, jev, home: config.home }), createEnvelopeTicker({ store, home: config.home }), helm.scorecard.consume]);
  const stopWatch = startTicker(settings.watch.tickSec * 1000, [createWatcher({ store, settings, jev })]);
  const stopQueue = startTicker(settings.queue.tickSec * 1000, [helm.queue.tick]);
  const stopDiscord = startTicker(1000, [discord.tick]);
  const stopPrWatch = startTicker(5 * 60_000, [createPrTicker({ store, github })]);
  const stopMemory = startTicker(1000, [createMemorySync({ store, settings })]);
  const stopHygiene = startTicker(settings.hygiene.gcSec * 1000, [hygiene.tick]);
  const stopTicker = () => { stopWake(); stopWatch(); stopQueue(); stopDiscord(); stopPrWatch(); stopMemory(); stopHygiene(); };
  console.error(`helm serve listening on http://127.0.0.1:${handle.port}`);
  const shutdown = async () => {
    stopTicker();
    await handle.close();
    store.close();
    releaseOwner();
    process.exit(0);
  };
  helm.lifecycle.shutdown = () => { void shutdown(); };
  helm.lifecycle.upgrade = (timeout) => launchUpgrade(config.home, handle.port!, helm.lifecycle.status(), timeout);
  let signaling = false;
  const drainOnSignal = async () => {
    if (signaling) return;
    signaling = true; helm.lifecycle.drain();
    const deadline = Date.now() + 600_000;
    while (helm.lifecycle.status().blockers.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const result = await helm.lifecycle.control({ action: 'shutdown' });
    if (!result.ok) console.error(result.reason);
    signaling = false;
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void drainOnSignal().catch((err) => { signaling = false; console.error(err); }); });
}

/** Spawns `helm serve --http` as its own process group, logging to `$HELM_HOME/daemon.log`, and waits for serve.json. */
async function startDetachedDaemon(home: string, serveJsonPath: string, port: number): Promise<{ port: number; pid: number }> {
  if (existsSync(join(home, 'upgrade.lock'))) throw new Error('upgrade in progress; automatic startup is paused');
  const update = readMetadata(join(home, 'upgrade.json'));
  if (update?.phase === 'failed' && update.handoverStarted) throw new Error('upgrade failed after shutdown; explicit manual recovery is required');
  const selected = readMetadata(join(home, 'current-release.json'));
  const entry = selected ? join(String(selected.root), 'helm', 'src', 'cli.ts') : process.argv[1] ?? '';
  const log = openSync(join(home, 'daemon.log'), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', entry, 'serve', '--http', '--port', String(port)], {
    cwd: resolve(entry, '..'), detached: true, stdio: ['ignore', log, log], env: process.env,
  });
  closeSync(log);
  child.on('error', (err) => console.error(err.message));
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const live = readLiveServeJson(serveJsonPath);
    if (live) return live;
  }
  throw new Error(`helm daemon did not start within 10s; see ${join(home, 'daemon.log')}`);
}

async function cmdShutdown(): Promise<void> {
  printOutcome(await postTool('daemon.control', { action: 'shutdown' }), false);
}
const cmdDaemon = (args: string[]) => simpleCmd('daemon.control', args, (_p, v) => ({ action: v.action ?? 'status' }), { action: { type: 'string' } });
const cmdScorecard = (args: string[]) => simpleCmd('scorecard.export', args, (p, v) => (p[0] ? { project: p[0], ...(v.budget ? { budgetId: v.budget } : {}), ...(v.since ? { since: v.since } : {}) } : undefined), { budget: { type: 'string' }, since: { type: 'string' } });
const cmdDeploy = async (args: string[]): Promise<void> => {
  const [verb, ...rest] = args;
  if (verb === 'run') { await simpleCmd('deploy.run', rest, (p, v) => p[0] && p[1] ? { project: p[0], target: p[1], ...(v.sha ? { sha: v.sha } : {}), ...(v['tap-id'] ? { tapId: v['tap-id'] } : {}) } : undefined, { sha: { type: 'string' }, 'tap-id': { type: 'string' } }); return; }
  if (verb === 'status') { await simpleCmd('deploy.status', rest, (p, v) => ({ ...(p[0] ? { project: p[0] } : {}), ...(v.id ? { id: v.id } : {}) }), { id: { type: 'string' } }); return; }
  if (verb === 'rollback') { await simpleCmd('deploy.rollback', rest, (p, v) => p[0] ? { id: p[0], ...(v['tap-id'] ? { tapId: v['tap-id'] } : {}) } : undefined, { 'tap-id': { type: 'string' } }); return; }
  usage(); process.exitCode = 2;
};

/** Table-driven dispatch, mirroring how the write commands share `simpleCmd`. */
const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  spawn: cmdSpawn, ps: cmdPs, logs: cmdLogs, inspect: cmdInspect, wait: cmdWait, steer: cmdSteer, stop: cmdStop, gate: cmdGate,
  pr: cmdPr, 'pr-status': cmdPrStatus, review: cmdReview, merge: cmdMerge, status: cmdStatus, cap: cmdCap, budget: cmdBudget, daemon: cmdDaemon, serve: cmdServe, shutdown: cmdShutdown,
  inbox: cmdInbox, reply: cmdReply, tap: cmdTap, supervisor: cmdSupervisor, wake: cmdWake, jev: cmdJev, scorecard: cmdScorecard, deploy: cmdDeploy,
};

async function main(): Promise<void> {
  if (process.argv[2] === '--version') { console.log(VERSION); return; }
  const [cmd, ...rest] = process.argv.slice(2);
  const handler = cmd ? COMMANDS[cmd] : undefined;
  if (!handler) { usage(); process.exitCode = 2; return; }
  return handler(rest);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
