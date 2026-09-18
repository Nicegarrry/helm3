/**
 * The `helm` command line. Reads (ps, logs, inspect, status) open the store directly;
 * writes POST to the running `helm serve --http` daemon. See DESIGN.md.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
import { builderPrompt, reviewerPrompt } from './prompt.js';
import { Helm } from './helm.js';
import { serve, formatWorkerTable } from './server.js';

function usage(): void {
  console.error(`usage: helm <command> [options]
  spawn --repo <path> --objective <text> --model <m> [--base-ref r] [--role builder|reviewer]
        [--context path]... [--allow-workflows] [--acceptance text] [--idempotency-key k]
  ps [--repo path] [--state s] [--json]
  logs <id> [-f] [--json]
  inspect <id> [--tail n] [--json]
  steer <id> "<message>" [--json]
  stop <id> [--json]
  gate <id> [--json]
  pr <id> [--title t] [--body b] [--draft] [--json]
  pr-status <id|#n> [--json]
  review <id|#n> --model m [--json]
  merge <#n> --head <sha> [--json]
  status [--json]
  serve [--stdio|--http] [--port n]`);
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
  const res = await fetch(`http://127.0.0.1:${live.port}/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
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

/** Shared shape for the thin read commands: parse args, open the store, run, close the store.
 * `run` prints its own output (JSON or text); a `run` that never returns (e.g. `logs -f`)
 * simply leaves the store open, same as the write commands leave the daemon call outstanding. */
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
  simpleCmd('worker.spawn', args, (_p, v) => (v.repo && v.objective && v.model
    ? { repo: resolve(process.cwd(), v.repo as string), objective: v.objective, acceptance: v.acceptance, model: v.model,
        baseRef: v['base-ref'], role: v.role, contextPaths: v.context ?? [], allowWorkflows: v['allow-workflows'] ?? false,
        idempotencyKey: v['idempotency-key'] }
    : undefined), {
    repo: { type: 'string' }, objective: { type: 'string' }, acceptance: { type: 'string' }, model: { type: 'string' },
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
    console.log(`worker:  ${payload.workerId}`);
    console.log(`state:   ${payload.state}`);
    console.log(`model:   ${payload.model}`);
    console.log(`branch:  ${payload.branch}`);
    console.log(`head:    ${payload.head ?? '-'}`);
    console.log(`spend:   $${payload.spendUsd.toFixed(4)}`);
    if (payload.result) console.log(`result:  ${payload.result.status} - ${payload.result.summary}`);
    if (payload.diffStat) console.log(`diff:\n${payload.diffStat}`);
    console.log('events:');
    for (const e of payload.events) console.log(`  [${e.at}] ${e.kind} ${JSON.stringify(e.data)}`);
  }, { tail: { type: 'string' } });

const cmdSteer = (args: string[]) =>
  simpleCmd('worker.steer', args, (p) => (p[0] && p.length > 1 ? { workerId: p[0], message: p.slice(1).join(' ') } : undefined));

const cmdStop = (args: string[]) => simpleCmd('worker.stop', args, (p) => (p[0] ? { workerId: p[0] } : undefined));

const cmdGate = (args: string[]) => simpleCmd('gate.run', args, (p) => (p[0] ? { workerId: p[0] } : undefined));

const cmdPr = (args: string[]) =>
  simpleCmd('pr.open', args, (p, v) => (p[0] ? { workerId: p[0], title: v.title, body: v.body, draft: v.draft ?? true } : undefined),
    { title: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' } });

const cmdPrStatus = (args: string[]) => simpleCmd('pr.status', args, (p) => (p[0] ? prIdent(p[0]) : undefined));

const cmdReview = (args: string[]) =>
  simpleCmd('review.request', args, (p, v) => (p[0] && v.model ? { ...prIdent(p[0]), model: v.model } : undefined), { model: { type: 'string' } });

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

async function cmdServe(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { stdio: { type: 'boolean' }, http: { type: 'boolean' }, port: { type: 'string' } } });
  const config = loadConfig();
  ensureHome(config);
  const live = readLiveServeJson(join(config.home, 'serve.json'));
  if (live) { console.error(`helm serve is already running (pid ${live.pid})`); process.exitCode = 2; return; }
  const store = openStore(join(config.home, 'helm.sqlite'));
  const helm = new Helm({
    config, store, workspace: gitWorkspace(), gates: gateRunner(), github: ghGitHub(),
    runner: piWorkerRunner(), prompts: { builder: builderPrompt, reviewer: reviewerPrompt },
  });
  helm.markInterruptedOnStart();
  const mode = values.stdio && !values.http ? 'stdio' : 'http';
  const handle = await serve({ helm, mode, port: values.port ? Number(values.port) : 0 });
  console.error(mode === 'http' ? `helm serve listening on http://127.0.0.1:${handle.port}` : 'helm serve listening on stdio');
  const shutdown = async () => {
    await handle.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** Table-driven dispatch, mirroring how the write commands share `simpleCmd`. */
const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  spawn: cmdSpawn, ps: cmdPs, logs: cmdLogs, inspect: cmdInspect, steer: cmdSteer, stop: cmdStop, gate: cmdGate,
  pr: cmdPr, 'pr-status': cmdPrStatus, review: cmdReview, merge: cmdMerge, status: cmdStatus, serve: cmdServe,
};

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const handler = cmd ? COMMANDS[cmd] : undefined;
  if (!handler) { usage(); process.exitCode = 2; return; }
  return handler(rest);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
