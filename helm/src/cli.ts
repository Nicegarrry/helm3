/** The `helm` command line. */
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { EventRow, HelmConfig, Store, WorkerRow } from './types.js';
import { ensureHome, loadConfig } from './config.js';
import { openStore } from './store.js';
import { gitWorkspace } from './workspace.js';
import { gateRunner } from './gate.js';
import { ghGitHub } from './github.js';
import { piWorkerRunner } from './worker.js';
import { codexWorkerRunner, laneRunner } from './codex.js';
import { builderPrompt, reviewerPrompt } from './prompt.js';
import { Helm } from './helm.js';
import { serve, serveStdioProxy, formatWorkerTable, callDaemon } from './server.js';

import { ownDaemon, readMetadata, VERSION } from './lifecycle.js';
import { launchUpgrade } from '../bin/update.mjs';

function usage(): void {
  console.error(`usage: helm <command> [options]
  spawn --repo <path> --objective <text> [--model <m>] [--difficulty super-easy|easy|normal] [--base-ref r] [--role builder|reviewer]
        [--context path]... [--allow-workflows] [--acceptance text] [--idempotency-key k]
  ps [--repo path] [--state s] [--json]
  logs <id> [-f] [--json]
  inspect <id> [--tail n] [--json]
  wait <id>... [--timeout ms] [--json]
  steer <id> "<message>" [--json]
  stop <id> [--json]
  gate <id> [--json]
  pr <id> [--title t] [--body b] [--draft] [--json]
  pr-status <id|#n> [--json]
  review <id|#n> [--model m] [--json]
  merge <#n> --head <sha> [--json]
  status [--json]
  serve [--stdio|--http] [--port n]
  daemon --action status|drain|resume [--json]
  update --stage <git-ref> [--repo path] | --when-idle [--timeout ms]
  shutdown`);
}

function openReadStore() {
  const config = loadConfig();
  return { config, store: openStore(join(config.home, 'helm.sqlite')) };
}

function prIdent(ref: string): { number: number } | { workerId: string } {
  const stripped = ref.startsWith('#') ? ref.slice(1) : ref;
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
    ? { repo: resolve(process.cwd(), v.repo as string), objective: v.objective, acceptance: v.acceptance, model: v.model, difficulty: v.difficulty,
        baseRef: v['base-ref'], role: v.role, contextPaths: v.context ?? [], allowWorkflows: v['allow-workflows'] ?? false,
        idempotencyKey: v['idempotency-key'] }
    : undefined), {
    repo: { type: 'string' }, objective: { type: 'string' }, acceptance: { type: 'string' }, model: { type: 'string' }, difficulty: { type: 'string' },
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

const cmdStop = (args: string[]) => simpleCmd('worker.stop', args, (p) => (p[0] ? { workerId: p[0] } : undefined));

const cmdGate = (args: string[]) => simpleCmd('gate.run', args, (p) => (p[0] ? { workerId: p[0] } : undefined));

const cmdPr = (args: string[]) =>
  simpleCmd('pr.open', args, (p, v) => (p[0] ? { workerId: p[0], title: v.title, body: v.body, draft: v.draft ?? true } : undefined),
    { title: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' } });

const cmdPrStatus = (args: string[]) => simpleCmd('pr.status', args, (p) => (p[0] ? prIdent(p[0]) : undefined));

const cmdReview = (args: string[]) =>
  simpleCmd('review.request', args, (p, v) => (p[0] ? { ...prIdent(p[0]), model: v.model } : undefined), { model: { type: 'string' } });

const cmdMerge = (args: string[]) =>
  simpleCmd('pr.merge', args, (p, v) => (p[0] && v.head ? { number: Number(p[0].replace('#', '')), expectedHead: v.head } : undefined),
    { head: { type: 'string' } });

const cmdStatus = (args: string[]) =>
  readCmd(args, (_p, v, store, config) => {
    const total = store.spendTotal();
    const activeWorkers = store.listWorkers().filter((w) => w.state === 'queued' || w.state === 'running').length;
    const payload = { spendUsd: total.spendUsd, spendCapUsd: config.spendCapUsd, activeWorkers, maxWorkers: config.maxWorkers, unknownCostEvents: total.unknownCostEvents };
    if (v.json) { console.log(JSON.stringify(payload, null, 2)); return; }
    console.log(`spend:    $${payload.spendUsd.toFixed(4)}${payload.spendCapUsd > 0 ? ` / $${payload.spendCapUsd.toFixed(2)} cap` : ' (no cap)'}`);
    console.log(`workers:  ${payload.activeWorkers} / ${payload.maxWorkers} active`);
    console.log(`unknown-cost events: ${payload.unknownCostEvents}`);
  });

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
    console.error(`helm stdio front-end attached to daemon pid ${live.pid}; status page at http://127.0.0.1:${live.port}/`);
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
  const helm = new Helm({
    config, store, workspace: gitWorkspace(), gates: gateRunner(), github: ghGitHub(),
    runner: laneRunner({ pi: piWorkerRunner(), codex: codexWorkerRunner() }), prompts: { builder: builderPrompt, reviewer: reviewerPrompt },
  });
  helm.markInterruptedOnStart();
  const handle = await serve({ helm, port }).catch((err) => { store.close(); releaseOwner(); throw err; });
  console.error(`helm serve listening on http://127.0.0.1:${handle.port}`);
  const shutdown = async () => {
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

/** Table-driven dispatch, mirroring how the write commands share `simpleCmd`. */
const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  spawn: cmdSpawn, ps: cmdPs, logs: cmdLogs, inspect: cmdInspect, wait: cmdWait, steer: cmdSteer, stop: cmdStop, gate: cmdGate,
  pr: cmdPr, 'pr-status': cmdPrStatus, review: cmdReview, merge: cmdMerge, status: cmdStatus, daemon: cmdDaemon, serve: cmdServe, shutdown: cmdShutdown,
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
