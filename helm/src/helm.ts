/**
 * The Helm service: composes Store, Workspace, GateRunner, GitHub and WorkerRunner and
 * implements the ten (plus pr.merge) tools. Every public method returns a ToolOutcome and
 * never throws across the boundary. See DESIGN.md and docs/one-shot-brief.md sections 3-7.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { z } from 'zod';
import type {
  GateRow,
  GateRunner,
  GitHub,
  HelmConfig,
  PrRow,
  PrStatus,
  Store,
  ToolOutcome,
  WorkerHooks,
  WorkerResult,
  WorkerRow,
  WorkerRunInput,
  WorkerRunOutcome,
  WorkerRunner,
  WorkerState,
  Workspace,
} from './types.js';
import {
  gateInput,
  inspectInput,
  listInput,
  prMergeInput,
  prOpenInput,
  prStatusInput,
  reviewInput,
  spawnInput,
  steerInput,
  stopInput,
} from './types.js';

const exec = promisify(execFile);

export type SpawnInput = z.infer<typeof spawnInput>;
export type InspectInput = z.infer<typeof inspectInput>;
export type ListInput = z.infer<typeof listInput>;
export type SteerInput = z.infer<typeof steerInput>;
export type StopInput = z.infer<typeof stopInput>;
export type GateInput = z.infer<typeof gateInput>;
export type PrOpenInput = z.infer<typeof prOpenInput>;
export type PrStatusInput = z.infer<typeof prStatusInput>;
export type ReviewInput = z.infer<typeof reviewInput>;
export type PrMergeInput = z.infer<typeof prMergeInput>;

/** What a builder/reviewer prompt is built from. Owned here since types.ts does not define it. */
export type PromptInput = Readonly<{
  objective: string;
  acceptance: string | null;
  contextPaths: readonly string[];
}>;

export type HelmPrompts = Readonly<{
  builder(input: PromptInput): string;
  reviewer(input: PromptInput): string;
}>;

export type HelmDeps = Readonly<{
  config: HelmConfig;
  store: Store;
  workspace: Workspace;
  gates: GateRunner;
  github: GitHub;
  runner: WorkerRunner;
  prompts: HelmPrompts;
  now?: () => Date;
  /** How long `stop()` waits for a running turn to settle before giving up. Default 10s; tests may lower it. */
  stopTimeoutMs?: number;
}>;

const STEERABLE_STATES: ReadonlySet<WorkerState> = new Set(['idle', 'succeeded', 'failed', 'interrupted']);
const ACTIVE_STATES: ReadonlySet<WorkerState> = new Set(['queued', 'running']);

type OnDone = (workerId: string, result: WorkerResult | null, outcome: WorkerRunOutcome) => Promise<void>;

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs `fn` and turns any thrown error (including one from `must`/`requireValue` below) into
 * `{ ok: false, reason }`, so every tool method can express a refusal as a plain throw. */
async function guard<T>(fn: () => Promise<ToolOutcome<T>>): Promise<ToolOutcome<T>> {
  try {
    return await fn();
  } catch (err) {
    return refuse(errMessage(err));
  }
}

/** Throws `reason` when `condition` is falsy. Meant for use inside a `guard`-wrapped method. */
function must(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

/** Returns `value`, or throws `reason` when it is null/undefined. The "find X or refuse" helper:
 * used for every worker/PR lookup so the refusal message is written once at the call site. */
function requireValue<T>(value: T | null | undefined, reason: string): T {
  if (value === null || value === undefined) throw new Error(reason);
  return value;
}

function genId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/** Extract "owner/name" from a git remote URL (ssh or https), or null if it doesn't parse. */
function parseOwnerRepo(url: string): string | null {
  const trimmed = url.trim();
  const match = trimmed.match(/[/:]([^/:]+)\/([^/]+?)(\.git)?\/?$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export class Helm {
  /** Public so server.ts can find $HELM_HOME (for serve.json) without a second config load. */
  readonly config: HelmConfig;
  private readonly store: Store;
  private readonly workspace: Workspace;
  private readonly gates: GateRunner;
  private readonly github: GitHub;
  private readonly runner: WorkerRunner;
  private readonly prompts: HelmPrompts;
  private readonly now?: () => Date;
  private readonly running = new Map<string, Promise<void>>();
  /** Workers with a stop requested for their current turn; cleared only once that turn settles (see runTurn). */
  private readonly stopRequested = new Set<string>();
  /** Workers whose current turn actually observed the stop request via hooks.shouldContinue(). */
  private readonly stopObserved = new Set<string>();
  private readonly stopTimeoutMs: number;
  /** Tail of an in-process promise-chain mutex serializing spawn/steer/reviewRequest admission sections. */
  private lock: Promise<void> = Promise.resolve();

  constructor(deps: HelmDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.workspace = deps.workspace;
    this.gates = deps.gates;
    this.github = deps.github;
    this.runner = deps.runner;
    this.prompts = deps.prompts;
    this.now = deps.now;
    this.stopTimeoutMs = deps.stopTimeoutMs ?? 10_000;
  }

  /** Runs `fn` exclusively with respect to every other call queued through this lock. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: () => void = () => {};
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Await a worker's in-flight turn, if any. Exposed for tests. */
  async settle(workerId: string): Promise<void> {
    await this.running.get(workerId);
  }

  /** Called once on daemon start: every `running` worker becomes `interrupted`. */
  markInterruptedOnStart(): string[] {
    return this.store.markInterrupted();
  }

  async spawn(input: SpawnInput): Promise<ToolOutcome<{ workerId: string; branch: string; worktree: string }>> {
    return guard(() => this.withLock(() => this.spawnLocked(input)));
  }

  /** The admission-and-create section of spawn, always run under `this.lock` so maxWorkers,
   * idempotencyKey and worktree creation cannot race with a concurrent spawn/steer. `onDone` is
   * set only by reviewRequest, which calls this directly to post its result as a PR comment. */
  private async spawnLocked(
    input: SpawnInput,
    onDone?: OnDone,
  ): Promise<ToolOutcome<{ workerId: string; branch: string; worktree: string }>> {
    if (input.idempotencyKey) {
      const existing = this.store.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { ok: true, workerId: existing.workerId, branch: existing.branch, worktree: existing.worktree };
    }
    const active = this.store.listWorkers().filter((w) => ACTIVE_STATES.has(w.state)).length;
    must(active < this.config.maxWorkers, `max workers reached (${this.config.maxWorkers})`);
    must(!this.spendCapExceeded(), 'spend cap reached');
    const repo = requireValue(await this.resolveRepo(input.repo), 'repo must be an absolute local path or owner/name');
    const repoSlug = await this.repoSlugFor(repo);
    const baseRef = input.baseRef ?? (await this.workspace.defaultBranch(repo));
    const baseSha = await this.workspace.resolveSha(repo, baseRef);
    const workerId = genId('w');
    const branch = `helm/${workerId}`;
    const worktree = join(this.config.home, 'worktrees', repoSlug.replace(/\//g, '__'), workerId);
    mkdirSync(dirname(worktree), { recursive: true });
    await this.workspace.create(repo, worktree, branch, baseSha);
    const createdAt = this.nowIso();
    const row: WorkerRow = {
      workerId, repo, repoSlug, role: input.role, model: input.model, objective: input.objective,
      acceptance: input.acceptance ?? null, contextPaths: [...input.contextPaths], allowWorkflows: input.allowWorkflows,
      baseRef, baseSha, branch, worktree, state: 'queued', head: null, sessionFile: null, result: null,
      rawResultText: null, idempotencyKey: input.idempotencyKey ?? null, createdAt, updatedAt: createdAt,
    };
    try {
      this.store.insertWorker(row);
    } catch (err) {
      try { await this.workspace.remove(repo, worktree); } catch { /* best effort cleanup */ }
      throw err;
    }
    this.store.appendEvent(workerId, 'spawned', { repo, repoSlug, role: input.role, model: input.model, baseRef, baseSha, branch, worktree });
    const promptInput: PromptInput = { objective: input.objective, acceptance: input.acceptance ?? null, contextPaths: input.contextPaths };
    const message = input.role === 'reviewer' ? this.prompts.reviewer(promptInput) : this.prompts.builder(promptInput);
    this.startRun(workerId, message, onDone);
    return { ok: true, workerId, branch, worktree };
  }

  async inspect(input: InspectInput): Promise<ToolOutcome<{
    state: WorkerState; model: string; branch: string; head: string | null; spendUsd: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    diffStat: string; result: WorkerResult | null; events: ReturnType<Store['listEvents']>;
  }>> {
    return guard(async () => {
      const row = requireValue(this.store.getWorker(input.workerId), 'worker not found');
      const spend = this.store.spendFor(input.workerId);
      let diffStat = '';
      try { diffStat = await this.workspace.diffStat(row.worktree, row.baseSha); } catch { diffStat = ''; }
      const all = this.store.listEvents(input.workerId, { limit: 1_000_000 });
      const events = input.tail > 0 ? all.slice(-input.tail) : [];
      return {
        ok: true, state: row.state, model: row.model, branch: row.branch, head: row.head,
        spendUsd: spend.spendUsd, tokens: spend.tokens, diffStat, result: row.result, events,
      };
    });
  }

  async list(input: ListInput): Promise<ToolOutcome<{
    workers: Array<{ workerId: string; state: WorkerState; role: WorkerRow['role']; model: string; branch: string; head: string | null; createdAt: string }>;
  }>> {
    return guard(async () => {
      const rows = this.store.listWorkers({ repo: input.repo, state: input.state });
      const workers = rows.map((r) => ({ workerId: r.workerId, state: r.state, role: r.role, model: r.model, branch: r.branch, head: r.head, createdAt: r.createdAt }));
      return { ok: true, workers };
    });
  }

  async steer(input: SteerInput): Promise<ToolOutcome<{ turn: number }>> {
    return guard(() => this.withLock(() => this.steerLocked(input)));
  }

  private async steerLocked(input: SteerInput): Promise<ToolOutcome<{ turn: number }>> {
    const row = requireValue(this.store.getWorker(input.workerId), 'worker not found');
    must(STEERABLE_STATES.has(row.state), `worker is ${row.state}, not steerable`);
    must(!this.running.has(input.workerId), 'worker already has a turn in flight');
    must(!this.spendCapExceeded(), 'spend cap reached');
    const priorTurns = this.store.listEvents(input.workerId, { limit: 1_000_000 }).filter((e) => e.kind === 'result').length;
    this.startRun(input.workerId, input.message);
    return { ok: true, turn: priorTurns + 1 };
  }

  async stop(input: StopInput): Promise<ToolOutcome<{ state: WorkerState }>> {
    return guard(async () => {
      const row = requireValue(this.store.getWorker(input.workerId), 'worker not found');
      must(row.state === 'running', `worker is not running (state: ${row.state})`);
      this.stopRequested.add(input.workerId);
      this.store.appendEvent(input.workerId, 'stop.requested');
      const settled = await this.waitForSettle(input.workerId, this.stopTimeoutMs);
      if (!settled) {
        // The turn never settled: leave `stopRequested` set so the flag is not lost, and
        // hooks.shouldContinue() keeps returning false for it if/when it does check again.
        return { ok: true, state: 'unknown' };
      }
      // runTurn's completion path already cleared stopRequested/stopObserved and wrote the
      // final state (forced to 'stopped' only if the turn actually observed the request).
      const finalRow = this.store.getWorker(input.workerId);
      return { ok: true, state: finalRow?.state ?? 'unknown' };
    });
  }

  async gate(input: GateInput): Promise<ToolOutcome<Omit<GateRow, 'gateId' | 'workerId' | 'at'>>> {
    return guard(async () => {
      const row = requireValue(this.store.getWorker(input.workerId), 'worker not found');
      must(await this.workspace.isClean(row.worktree), 'worktree is not clean');
      const head = await this.workspace.head(row.worktree);
      const checks = input.checks ?? (await this.gates.defaultChecks(row.repo));
      const gateId = genId('g');
      const logDir = join(this.config.home, 'logs', input.workerId, `gate-${gateId}`);
      const outcome = await this.gates.run(row.worktree, checks, logDir, { timeoutMs: this.config.gateTimeoutMs });
      const gateRow: GateRow = { gateId, workerId: input.workerId, head, passed: outcome.passed, checks: outcome.checks, at: this.nowIso() };
      this.store.insertGate(gateRow);
      this.store.appendEvent(input.workerId, 'gate', { gateId, passed: outcome.passed, head });
      return { ok: true, head, passed: outcome.passed, checks: outcome.checks };
    });
  }

  async prOpen(input: PrOpenInput): Promise<ToolOutcome<{ number: number; url: string; head: string }>> {
    return guard(async () => {
      const row = requireValue(this.store.getWorker(input.workerId), 'worker not found');
      const head = requireValue(row.head, 'worker has no commits yet');
      const passing = this.store.listGates(input.workerId).filter((g) => g.head === head && g.passed);
      must(passing.length > 0, `no passing gate at head ${head}`);
      await this.workspace.push(row.worktree, row.branch);
      const title = input.title ?? row.result?.summary?.split('\n')[0] ?? row.objective.slice(0, 72);
      const body = input.body ?? `${row.result?.summary ?? ''}\n\nGate: passed at ${head}`;
      const opened = await this.github.openPr({ cwd: row.worktree, base: row.baseRef, head: row.branch, title, body, draft: input.draft });
      const prRow: PrRow = { number: opened.number, workerId: input.workerId, url: opened.url, head, createdAt: this.nowIso() };
      this.store.insertPr(prRow);
      this.store.appendEvent(input.workerId, 'pr', { number: opened.number, url: opened.url });
      return { ok: true, number: opened.number, url: opened.url, head };
    });
  }

  async prStatus(input: PrStatusInput): Promise<ToolOutcome<PrStatus>> {
    return guard(async () => {
      let repoSlug: string;
      let number = input.number;
      if (number !== undefined) {
        const worker = input.workerId ? this.store.getWorker(input.workerId) : undefined;
        if (worker) {
          repoSlug = worker.repoSlug;
        } else {
          const pr = requireValue(this.store.getPrByNumber(number), 'pr not found');
          repoSlug = requireValue(this.store.getWorker(pr.workerId), 'pr worker not found').repoSlug;
        }
      } else {
        const workerId = requireValue(input.workerId, 'number or workerId required');
        const pr = requireValue(this.store.getPrByWorker(workerId), 'no pr for worker');
        number = pr.number;
        repoSlug = requireValue(this.store.getWorker(workerId), 'worker not found').repoSlug;
      }
      const status = await this.github.prStatus(repoSlug, number);
      return { ok: true, ...status };
    });
  }

  async reviewRequest(input: ReviewInput): Promise<ToolOutcome<{ reviewWorkerId: string }>> {
    return guard(async () => {
      const byNumber = input.number !== undefined ? this.store.getPrByNumber(input.number) : undefined;
      const byWorker = input.number === undefined && input.workerId ? this.store.getPrByWorker(input.workerId) : undefined;
      const pr = requireValue(byNumber ?? byWorker, 'pr not found');
      const sourceWorker = requireValue(this.store.getWorker(pr.workerId), 'source worker not found');
      const objective = `Review PR #${pr.number} (${pr.url}) on branch ${sourceWorker.branch} in ${sourceWorker.repoSlug}. Read the diff, run relevant checks, and report findings as the worker result.`;
      const spawnPayload: SpawnInput = {
        repo: sourceWorker.repo, objective, model: input.model, baseRef: sourceWorker.branch,
        role: 'reviewer', contextPaths: [], allowWorkflows: false,
      };
      const onDone: OnDone = async (workerId, result) => {
        const body = result ? `${result.summary}${result.notes ? `\n\n${result.notes}` : ''}` : 'Review did not produce a usable result.';
        await this.github.comment(sourceWorker.repoSlug, pr.number, body);
        this.store.appendEvent(workerId, 'review.posted', { number: pr.number });
      };
      const outcome = await guard(() => this.withLock(() => this.spawnLocked(spawnPayload, onDone)));
      if (!outcome.ok) return outcome;
      return { ok: true, reviewWorkerId: outcome.workerId };
    });
  }

  async runStatus(): Promise<ToolOutcome<{ spendUsd: number; spendCapUsd: number; activeWorkers: number; maxWorkers: number; unknownCostEvents: number }>> {
    return guard(async () => {
      const total = this.store.spendTotal();
      const activeWorkers = this.store.listWorkers().filter((w) => ACTIVE_STATES.has(w.state)).length;
      return {
        ok: true, spendUsd: total.spendUsd, spendCapUsd: this.config.spendCapUsd,
        activeWorkers, maxWorkers: this.config.maxWorkers, unknownCostEvents: total.unknownCostEvents,
      };
    });
  }

  async prMerge(input: PrMergeInput): Promise<ToolOutcome<{ merged: true }>> {
    return guard(async () => {
      const pr = requireValue(this.store.getPrByNumber(input.number), 'pr not found');
      const worker = requireValue(this.store.getWorker(pr.workerId), 'pr worker not found');
      const status = await this.github.prStatus(worker.repoSlug, input.number);
      must(status.state === 'open', `pr is ${status.state}, not open`);
      must(status.mergeable === true, 'pr is not mergeable');
      must(status.head === input.expectedHead, `head mismatch: expected ${input.expectedHead}, got ${status.head}`);
      const failing = status.checks.find((c) => c.conclusion !== null && c.conclusion !== 'success');
      if (failing) return refuse(`check "${failing.name}" did not succeed`);
      await this.github.merge(worker.repoSlug, input.number, input.expectedHead);
      return { ok: true, merged: true };
    });
  }

  private nowIso(): string {
    return (this.now ? this.now() : new Date()).toISOString();
  }

  private spendCapExceeded(): boolean {
    return this.config.spendCapUsd > 0 && this.store.spendTotal().spendUsd >= this.config.spendCapUsd;
  }

  /** Absolute local paths are used as-is; `owner/name` is cloned once under $HELM_HOME/repos and fetched on later use. */
  private async resolveRepo(repo: string): Promise<string | undefined> {
    if (/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      const dest = join(this.config.home, 'repos', repo.replace('/', '__'));
      if (existsSync(join(dest, '.git'))) {
        try { await this.workspace.fetch(dest); } catch { /* offline is fine; use what we have */ }
      } else {
        mkdirSync(dirname(dest), { recursive: true });
        await this.workspace.clone(repo, dest);
      }
      return dest;
    }
    if (isAbsolute(repo) && existsSync(repo) && statSync(repo).isDirectory()) return repo;
    return undefined;
  }

  private async repoSlugFor(repo: string): Promise<string> {
    try {
      const { stdout } = await exec('git', ['-C', repo, 'remote', 'get-url', 'origin']);
      const slug = parseOwnerRepo(stdout);
      if (slug) return slug;
    } catch {
      // no origin remote, or git failed; fall back below.
    }
    return basename(repo);
  }

  private async waitForSettle(workerId: string, timeoutMs: number): Promise<boolean> {
    const running = this.running.get(workerId);
    if (!running) return true;
    let timedOut = false;
    const timer = new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs));
    await Promise.race([running, timer]);
    return !timedOut;
  }

  /** Start (or resume) one turn in the background. Tracked in `running` so stop/settle can wait on it. */
  private startRun(workerId: string, message: string, onDone?: OnDone): void {
    const promise = this.runTurn(workerId, message, onDone).catch((err) => {
      this.store.appendEvent(workerId, 'error', { message: `unhandled: ${errMessage(err)}` });
    });
    this.running.set(workerId, promise);
    void promise.finally(() => { if (this.running.get(workerId) === promise) this.running.delete(workerId); });
  }

  private async runTurn(workerId: string, message: string, onDone?: OnDone): Promise<void> {
    const row = this.store.getWorker(workerId);
    if (!row) return;
    const prevState = row.state;
    this.store.updateWorker(workerId, { state: 'running' });
    this.store.appendEvent(workerId, 'state', { from: prevState, to: 'running' });
    const runInput: WorkerRunInput = {
      workerId, role: row.role, model: row.model, worktree: row.worktree, objective: row.objective,
      acceptance: row.acceptance, contextPaths: row.contextPaths, allowWorkflows: row.allowWorkflows,
      sessionFile: row.sessionFile, sessionDir: join(this.config.home, 'sessions', workerId),
    };
    const hooks: WorkerHooks = {
      emit: (kind, data) => {
        this.store.appendEvent(workerId, kind, data);
      },
      onUsage: (usage) => {
        this.store.addSpend({ ...usage, workerId, at: this.nowIso() });
      },
      shouldContinue: () => {
        if (this.stopRequested.has(workerId)) {
          this.stopObserved.add(workerId);
          return false;
        }
        return !this.spendCapExceeded();
      },
    };
    try {
      const outcome = await this.runner.run(runInput, message, hooks);
      const result = outcome.result;
      if (row.role === 'builder' && result?.status !== 'failed') {
        try {
          const commitMessage = result?.summary ?? `helm: ${workerId} turn complete`;
          const head = await this.workspace.commitAll(row.worktree, commitMessage);
          this.store.updateWorker(workerId, { head });
        } catch (err) {
          this.store.appendEvent(workerId, 'error', { message: `commit failed: ${errMessage(err)}` });
        }
      }
      let nextState: WorkerState =
        result === null ? 'failed' : result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : 'idle';
      // Only report 'stopped' when this turn actually observed the stop request (via
      // hooks.shouldContinue()); a turn that completed on its own keeps its real outcome.
      if (this.stopObserved.has(workerId)) nextState = 'stopped';
      this.stopRequested.delete(workerId);
      this.stopObserved.delete(workerId);
      this.store.updateWorker(workerId, { state: nextState, sessionFile: outcome.sessionFile ?? row.sessionFile, result, rawResultText: result === null ? outcome.rawText : null });
      this.store.appendEvent(workerId, 'result', result ? { ...result } : { rawText: outcome.rawText });
      this.store.appendEvent(workerId, 'state', { from: 'running', to: nextState });
      if (onDone) {
        try {
          await onDone(workerId, result, outcome);
        } catch (err) {
          this.store.appendEvent(workerId, 'error', { message: `onDone failed: ${errMessage(err)}` });
        }
      }
    } catch (err) {
      this.stopRequested.delete(workerId);
      this.stopObserved.delete(workerId);
      this.store.updateWorker(workerId, { state: 'unknown' });
      this.store.appendEvent(workerId, 'error', { message: errMessage(err) });
      this.store.appendEvent(workerId, 'state', { from: 'running', to: 'unknown' });
    }
  }
}
