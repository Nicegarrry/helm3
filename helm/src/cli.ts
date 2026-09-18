/**
 * The `helm` command line. Reads (ps, logs, inspect, status) open the store directly;
 * writes POST to the running `helm serve --http` daemon. See DESIGN.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { EventRow, WorkerRow } from './types.js';
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
  console.error(
    [
      'usage: helm <command> [options]',
      '  spawn --repo <path> --objective <text> --model <m> [--base-ref r] [--role builder|reviewer]',
      '        [--context path]... [--allow-workflows] [--acceptance text] [--idempotency-key k]',
      '  ps [--repo path] [--state s] [--json]',
      '  logs <id> [-f] [--json]',
      '  inspect <id> [--tail n] [--json]',
      '  steer <id> "<message>" [--json]',
      '  stop <id> [--json]',
      '  gate <id> [--json]',
      '  pr <id> [--title t] [--body b] [--draft] [--json]',
      '  pr-status <id|#n> [--json]',
      '  review <id|#n> --model m [--json]',
      '  merge <#n> --head <sha> [--json]',
      '  status [--json]',
      '  serve [--stdio|--http] [--port n]',
    ].join('\n'),
  );
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
  if (json) {
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
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

async function postTool(name: string, body: unknown): Promise<unknown> {
  const config = loadConfig();
  const serveJsonPath = join(config.home, 'serve.json');
  if (!existsSync(serveJsonPath)) {
    console.error('helm serve is not running (start it with: helm serve --http)');
    process.exitCode = 2;
    return undefined;
  }
  const { port } = JSON.parse(readFileSync(serveJsonPath, 'utf8')) as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

async function cmdSpawn(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      objective: { type: 'string' },
      acceptance: { type: 'string' },
      model: { type: 'string' },
      'base-ref': { type: 'string' },
      role: { type: 'string' },
      context: { type: 'string', multiple: true },
      'allow-workflows': { type: 'boolean' },
      'idempotency-key': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  if (!values.repo || !values.objective || !values.model) {
    usage();
    process.exitCode = 2;
    return;
  }
  const body = {
    repo: resolve(process.cwd(), values.repo),
    objective: values.objective,
    acceptance: values.acceptance,
    model: values.model,
    baseRef: values['base-ref'],
    role: values.role,
    contextPaths: values.context ?? [],
    allowWorkflows: values['allow-workflows'] ?? false,
    idempotencyKey: values['idempotency-key'],
  };
  printOutcome(await postTool('worker.spawn', body), values.json === true);
}

function toWorkerRowSummary(r: WorkerRow) {
  return { workerId: r.workerId, state: r.state, role: r.role, model: r.model, branch: r.branch, head: r.head, createdAt: r.createdAt };
}

async function cmdPs(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { repo: { type: 'string' }, state: { type: 'string' }, json: { type: 'boolean' } } });
  const { store } = openReadStore();
  const rows = store.listWorkers({ repo: values.repo, state: values.state as WorkerRow['state'] | undefined });
  store.close();
  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(formatWorkerTable(rows.map(toWorkerRowSummary)));
}

function printEvent(e: EventRow, json: boolean): void {
  console.log(json ? JSON.stringify(e) : `[${e.at}] #${e.seq} ${e.kind} ${JSON.stringify(e.data)}`);
}

async function cmdLogs(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { follow: { type: 'boolean', short: 'f' }, json: { type: 'boolean' } } });
  const workerId = positionals[0];
  if (!workerId) {
    usage();
    process.exitCode = 2;
    return;
  }
  const { store } = openReadStore();
  let afterSeq = 0;
  for (const e of store.listEvents(workerId, { limit: 100_000 })) {
    printEvent(e, values.json === true);
    afterSeq = e.seq;
  }
  if (!values.follow) {
    store.close();
    return;
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    for (const e of store.listEvents(workerId, { afterSeq, limit: 1000 })) {
      printEvent(e, values.json === true);
      afterSeq = e.seq;
    }
  }
}

async function cmdInspect(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { tail: { type: 'string' }, json: { type: 'boolean' } } });
  const workerId = positionals[0];
  if (!workerId) {
    usage();
    process.exitCode = 2;
    return;
  }
  const { store } = openReadStore();
  const row = store.getWorker(workerId);
  if (!row) {
    console.error('worker not found');
    store.close();
    process.exitCode = 1;
    return;
  }
  const spend = store.spendFor(workerId);
  let diffStat = '';
  try {
    diffStat = await gitWorkspace().diffStat(row.worktree, row.baseSha);
  } catch {
    diffStat = '';
  }
  const tail = values.tail ? Number(values.tail) : 20;
  const events = tail > 0 ? store.listEvents(workerId, { limit: 1_000_000 }).slice(-tail) : [];
  store.close();
  const payload = { workerId, state: row.state, model: row.model, branch: row.branch, head: row.head, spendUsd: spend.spendUsd, tokens: spend.tokens, diffStat, result: row.result, events };
  if (values.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
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
}

type ParsedValues = Record<string, string | boolean | string[] | undefined>;

/** Shared shape for the thin write commands: parse args, build a tool body, POST, print. */
async function simpleCmd(
  toolName: string,
  args: string[],
  build: (positionals: string[], values: ParsedValues) => unknown,
  extraOptions: Record<string, { type: 'string' | 'boolean'; multiple?: boolean; short?: string }> = {},
): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, ...extraOptions } });
  const body = build(positionals, values as ParsedValues);
  if (body === undefined) {
    usage();
    process.exitCode = 2;
    return;
  }
  printOutcome(await postTool(toolName, body), values.json === true);
}

const cmdSteer = (args: string[]) =>
  simpleCmd('worker.steer', args, (p) => (p[0] && p.length > 1 ? { workerId: p[0], message: p.slice(1).join(' ') } : undefined));

const cmdStop = (args: string[]) => simpleCmd('worker.stop', args, (p) => (p[0] ? { workerId: p[0] } : undefined));

const cmdGate = (args: string[]) => simpleCmd('gate.run', args, (p) => (p[0] ? { workerId: p[0] } : undefined));

const cmdPr = (args: string[]) =>
  simpleCmd(
    'pr.open',
    args,
    (p, v) => (p[0] ? { workerId: p[0], title: v.title, body: v.body, draft: v.draft ?? true } : undefined),
    { title: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' } },
  );

const cmdPrStatus = (args: string[]) => simpleCmd('pr.status', args, (p) => (p[0] ? prIdent(p[0]) : undefined));

const cmdReview = (args: string[]) =>
  simpleCmd('review.request', args, (p, v) => (p[0] && v.model ? { ...prIdent(p[0]), model: v.model } : undefined), {
    model: { type: 'string' },
  });

const cmdMerge = (args: string[]) =>
  simpleCmd(
    'pr.merge',
    args,
    (p, v) => (p[0] && v.head ? { number: Number(p[0].replace('#', '')), expectedHead: v.head } : undefined),
    { head: { type: 'string' } },
  );

async function cmdStatus(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const { config, store } = openReadStore();
  const total = store.spendTotal();
  const activeWorkers = store.listWorkers().filter((w) => w.state === 'queued' || w.state === 'running').length;
  store.close();
  const payload = { spendUsd: total.spendUsd, spendCapUsd: config.spendCapUsd, activeWorkers, maxWorkers: config.maxWorkers, unknownCostEvents: total.unknownCostEvents };
  if (values.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`spend:    $${payload.spendUsd.toFixed(4)}${payload.spendCapUsd > 0 ? ` / $${payload.spendCapUsd.toFixed(2)} cap` : ' (no cap)'}`);
  console.log(`workers:  ${payload.activeWorkers} / ${payload.maxWorkers} active`);
  console.log(`unknown-cost events: ${payload.unknownCostEvents}`);
}

async function cmdServe(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { stdio: { type: 'boolean' }, http: { type: 'boolean' }, port: { type: 'string' } } });
  const config = loadConfig();
  ensureHome(config);
  const store = openStore(join(config.home, 'helm.sqlite'));
  const helm = new Helm({
    config,
    store,
    workspace: gitWorkspace(),
    gates: gateRunner(),
    github: ghGitHub(),
    runner: piWorkerRunner(),
    prompts: { builder: builderPrompt, reviewer: reviewerPrompt },
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

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'spawn':
      return cmdSpawn(rest);
    case 'ps':
      return cmdPs(rest);
    case 'logs':
      return cmdLogs(rest);
    case 'inspect':
      return cmdInspect(rest);
    case 'steer':
      return cmdSteer(rest);
    case 'stop':
      return cmdStop(rest);
    case 'gate':
      return cmdGate(rest);
    case 'pr':
      return cmdPr(rest);
    case 'pr-status':
      return cmdPrStatus(rest);
    case 'review':
      return cmdReview(rest);
    case 'merge':
      return cmdMerge(rest);
    case 'status':
      return cmdStatus(rest);
    case 'serve':
      return cmdServe(rest);
    default:
      usage();
      process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
