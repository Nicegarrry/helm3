/** Helm service: composes the runtime and implements the worker, budget, and lifecycle tools. See DESIGN.md. */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { z } from 'zod';
import type {
  EventRow,
  BaselineRow,
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
  SupervisorRow,
  WakeRow,
} from './types.js';
import {
  budgetCloseInput,
  budgetOpenInput,
  budgetStatusInput,
  baselineInput,
  envelopeGetInput,
  gateInput,
  inspectInput,
  listInput,
  prMergeInput,
  prOpenInput,
  prStatusInput,
  reviewInput,
  spawnInput,
  steerInput,
  waitInput,
  stopInput,
  inboxListInput,
  inboxReplyInput,
} from './types.js';
import { answerInbox, createInboxId, getInbox, insertInbox, listInbox, supersedeOpenInbox } from './inbox.js';
import { createBaseline, ensureBaselineTable, getBaseline } from './baseline.js';
import { loadRepoConfig } from './repoconfig.js';

import { Lifecycle } from './lifecycle.js';
import { loadSettings, type Settings } from './settings.js';
import { attachWorker, budgetForWorker, budgetStatus, budgetWarningEmitted, closeBudget, ensureBudgetTables, listBudgetStatuses, openBudget, openBudgetFor, type BudgetStatus } from './budget.js';
import { envelopeBudgetGuard, envelopePath, readEnvelope, type EnvelopeView } from './envelope.js';
import type { SupervisorRegisterInput, SupervisorRotateInput, SupervisorService, WakeListInput } from './supervise.js';
import type { DiscordService } from './discord.js';
import type { ReviewRecordInput, ReviewService } from './review.js';
import type { JevCheckService } from './jevcheck.js';
import type { ClaimsService } from './claims.js';
import { createMemory, type MemoryService } from './memory.js';

const exec = promisify(execFile);

export type SpawnInput = z.infer<typeof spawnInput>;
export type InspectInput = z.infer<typeof inspectInput>;
export type ListInput = z.infer<typeof listInput>;
export type SteerInput = z.infer<typeof steerInput>;
export type StopInput = z.infer<typeof stopInput>;
export type GateInput = z.infer<typeof gateInput>;
export type BaselineInput = z.infer<typeof baselineInput>;
export type PrOpenInput = z.infer<typeof prOpenInput>;
export type PrStatusInput = z.infer<typeof prStatusInput>;
export type ReviewInput = z.infer<typeof reviewInput>;
export type PrMergeInput = z.infer<typeof prMergeInput>;
export type WaitInput = z.infer<typeof waitInput>;
export type BudgetOpenInput = z.infer<typeof budgetOpenInput>;
export type BudgetCloseInput = z.infer<typeof budgetCloseInput>;
export type BudgetStatusInput = z.infer<typeof budgetStatusInput>;
export type EnvelopeGetInput = z.infer<typeof envelopeGetInput>;
export type InboxListInput = z.infer<typeof inboxListInput>;
export type InboxReplyInput = z.infer<typeof inboxReplyInput>;

/** What a builder/reviewer prompt is built from. Owned here since types.ts does not define it. */
export type PromptInput = Readonly<{
  objective: string;
  acceptance: string | null;
  contextPaths: readonly string[];
}>;

export type HelmPrompts = Readonly<{
  builder(input: PromptInput): string;
  reviewer(input: PromptInput): string;
  validator(input: PromptInput): string;
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
  /** How often worker.wait re-reads the store while blocking. */
  waitPollMs?: number;
  settings?: Settings;
  supervisor?: SupervisorService;
  discord?: DiscordService;
  review?: ReviewService;
  jevChecker?: JevCheckService;
  claims?: ClaimsService;
}>;

const STEERABLE_STATES: ReadonlySet<WorkerState> = new Set(['idle', 'waiting', 'succeeded', 'failed', 'interrupted']);
const ACTIVE_STATES: ReadonlySet<WorkerState> = new Set(['queued', 'running']);
/** Check conclusions that do not block a merge. Lower-case: github.ts normalises them. */
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped']);

type OnDone = (workerId: string, result: WorkerResult | null, outcome: WorkerRunOutcome) => Promise<void>;

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Turns thrown errors into the harness's stable refusal shape. */
async function runGuard<T>(fn: () => Promise<ToolOutcome<T>>): Promise<ToolOutcome<T>> {
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

/** Returns `value`, or throws `reason` when it is null/undefined. */
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

export type OverviewWorker = {
  workerId: string; state: WorkerState; role: WorkerRow['role']; model: string; repoSlug: string; branch: string; head: string | null;
  objective: string; createdAt: string; updatedAt: string; elapsedMs: number; spendUsd: number; tokens: number; unknownCostEvents: number;
  /** The dashboard summarises `data` client-side (ui.ts `summarize`), the one place that text is shaped. */
  lastEvent: { kind: string; at: string; data: Record<string, unknown> } | null; resultStatus: WorkerResult['status'] | null;
};
export type OverviewModel = { model: string; workers: number; active: number; spendUsd: number; tokens: number };
export type SpendPoint = { at: string; spendUsd: number };
export type Overview = {
  daemon: ReturnType<Lifecycle['status']>;
  observedAt: string;
  run: { spendUsd: number; spendCapUsd: number; spendWarnUsd: number; aboveSoftCap: boolean; activeWorkers: number; maxWorkers: number; unknownCostEvents: number };
  workers: OverviewWorker[]; models: OverviewModel[];
  /** Cumulative spend over time (last SPEND_SERIES_POINTS spend rows, ascending by `at`; unknown cost counts as 0). */
  spendSeries: SpendPoint[];
};
/** One worker's drill-down: the overview row plus everything the page shows on its detail panel. */
export type WorkerDetail = {
  worker: OverviewWorker;
  result: WorkerResult | null;
  rawResultText: string | null;
  diffStat: string;
  gates: GateRow[];
  pr: PrRow | null;
  events: EventRow[];
};

const SPEND_SERIES_POINTS = 300;
const DETAIL_EVENT_TAIL = 200;
const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 1000;

/** Review family: leading letters of the last model path segment, independent of provider. */
export function modelFamily(model: string): string {
  const id = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const last = id.split('/').pop() ?? id;
  const m = /^[a-z]+/i.exec(last);
  return (m ? m[0] : last).toLowerCase();
}

// Explicit model overrides remain available; automatic choices exclude Kimi K3 and Qwen Max.
const TASK_MODELS = { normal: 'codex/gpt-5.6-luna:high', easy: 'codex/gpt-5.6-luna:medium', 'super-easy': 'codex/gpt-5.6-luna:medium' } as const;

export type ToolGuard = (input: unknown) => string | null | Promise<string | null>;
export type ModelChooser = (input: SpawnInput) => string | null | undefined | Promise<string | null | undefined>;

export class Helm {
  readonly lifecycle: Lifecycle;
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
  private readonly waitPollMs: number;
  private readonly settings: Settings;
  private readonly guards = new Map<string, ToolGuard[]>();
  private readonly modelChoosers: ModelChooser[] = [];
  readonly supervisor?: SupervisorService;
  readonly discord?: DiscordService;
  private readonly review?: ReviewService;
  readonly jevChecker?: JevCheckService;
  readonly claims?: ClaimsService;
  private readonly memory: MemoryService;
  /** Tail of an in-process promise-chain mutex serializing spawn/steer/reviewRequest admission sections. */
  private lock: Promise<void> = Promise.resolve();

  constructor(deps: HelmDeps) {
    this.config = deps.config;
    this.lifecycle = new Lifecycle(deps.config.home, () => [...this.running.keys()]);
    this.store = deps.store;
    this.workspace = deps.workspace;
    this.gates = deps.gates;
    this.github = deps.github;
    this.runner = deps.runner;
    this.prompts = deps.prompts;
    this.now = deps.now;
    this.stopTimeoutMs = deps.stopTimeoutMs ?? 10_000;
    this.waitPollMs = deps.waitPollMs ?? 500;
    this.settings = deps.settings ?? loadSettings(deps.config.home);
    ensureBudgetTables(this.store);
    ensureBaselineTable(this.store);
    this.supervisor = deps.supervisor;
    this.discord = deps.discord;
    this.review = deps.review;
    this.guard('pr.open', async (raw) => {
      const input = raw as PrOpenInput;
      const worker = this.store.getWorker(input.workerId);
      const meta = worker ? this.store.getMeta(worker.workerId) : undefined;
      if (!worker || !meta?.baselineId) return null;
      const baseline = getBaseline(this.store, meta.baselineId);
      if (!baseline) return `baseline not found: ${meta.baselineId}`;
      let head: string;
      try { head = await this.workspace.head(worker.worktree); } catch (err) {
        return `could not read worker head: ${err instanceof Error ? err.message : String(err)}`;
      }
      const acceptance = this.store.listGates(worker.workerId)
        .filter((gate) => gate.head === head)
        .flatMap((gate) => gate.checks)
        .find((check) => check.name === 'acceptance');
      if (!acceptance || acceptance.exitCode !== 0) return `acceptance check did not pass at head ${head ?? 'unknown'}`;
      try {
        const { stdout } = await exec('git', ['diff', '--name-only', `${baseline.testCommit}..${head}`, '--', ...baseline.files], { cwd: worker.worktree });
        const edited = stdout.split('\n').map((file) => file.trim()).filter(Boolean);
        if (edited.length > 0) return `baseline tests edited: ${edited.join(', ')}`;
      } catch (err) {
        return `could not verify baseline tests: ${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
    });
    if (this.review) this.guard('pr.merge', (input) => this.review!.guard(input));
    this.jevChecker = deps.jevChecker;
    this.guard('budget.open', (input) => envelopeBudgetGuard(this.config.home, input as BudgetOpenInput));
    this.claims = deps.claims;
    if (this.claims) this.guard('pr.merge', (input) => this.claims!.guard(input));
    this.memory = createMemory({ store: this.store, home: this.config.home, settings: this.settings, now: () => this.now ? new Date(this.now()) : new Date() });
  }

  async memoryWrite(input: import('./memory.js').MemoryWriteInput): Promise<ToolOutcome<{ path: string }>> { return this.memory.write(input); }
  async memoryLog(input: import('./memory.js').MemoryLogInput): Promise<ToolOutcome<{ path: string }>> { return this.memory.log(input); }
  async memoryList(input: import('./memory.js').MemoryListInput): Promise<ToolOutcome<{ memories: Array<{ path: string; title: string; summary: string }> }>> { return this.memory.list(input); }

  async jevCheck(input: import('./jevcheck.js').JevCheckInput): Promise<ToolOutcome<Record<string, unknown>>> { return this.jevChecker ? this.jevChecker.check(input) : { ok: false, reason: 'jev service unavailable' }; }
  async jevLabel(input: { id: number; label: string }): Promise<ToolOutcome<{ id: number; label: string }>> { return this.jevChecker ? this.jevChecker.label(input) : { ok: false, reason: 'jev service unavailable' }; }
  async claimsCheck(input: import('./claims.js').ClaimsCheckInput): Promise<ToolOutcome<Record<string, unknown>>> {
    if (!this.claims) return { ok: false, reason: 'claims service unavailable' };
    return runGuard(() => this.claims!.check(input));
  }

  /** Register a refusal hook; hooks run in registration order and the first reason wins. */
  guard(tool: string, fn: ToolGuard): void {
    const hooks = this.guards.get(tool) ?? [];
    hooks.push(fn);
    this.guards.set(tool, hooks);
  }

  /** Register model selection before spawn admission takes the mutex. */
  chooseModel(fn: ModelChooser): void {
    this.modelChoosers.push(fn);
  }

  private async refusal(tool: string, input: unknown): Promise<string | null> {
    for (const fn of this.guards.get(tool) ?? []) {
      const reason = await fn(input);
      if (reason) return reason;
    }
    return null;
  }

  private async chosenModel(input: SpawnInput): Promise<SpawnInput> {
    if (input.model || input.difficulty) return input;
    let chosen = input;
    for (const fn of this.modelChoosers) {
      const model = await fn(chosen);
      if (model) chosen = { ...chosen, model };
    }
    return chosen;
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

  async spawn(input: SpawnInput): Promise<ToolOutcome<{ workerId: string; branch: string; worktree: string; warning?: string }>> {
    return runGuard(async () => {
      const chosen = await this.chosenModel(input);
      const reason = await this.refusal('worker.spawn', chosen);
      if (reason) return refuse(reason);
      return this.withLock(() => this.spawnLocked(chosen));
    });
  }

  /** Locked spawn admission; onDone keeps review posting inside the worker lifetime. */
  private async spawnLocked(
    input: SpawnInput,
    onDone?: OnDone,
  ): Promise<ToolOutcome<{ workerId: string; branch: string; worktree: string }>> {
    if (input.idempotencyKey) {
      const existing = this.store.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { ok: true, workerId: existing.workerId, branch: existing.branch, worktree: existing.worktree };
    }
    const model = input.model ?? TASK_MODELS[input.difficulty ?? 'normal'];
    const active = this.store.listWorkers().filter((w) => ACTIVE_STATES.has(w.state)).length;
    must(active < this.config.maxWorkers, `max workers reached (${this.config.maxWorkers})`);
    must(!this.spendCapExceeded(), 'spend cap reached');
    const repo = requireValue(await this.resolveRepo(input.repo), 'repo must be an absolute local path or owner/name');
    const repoSlug = await this.repoSlugFor(repo);
    const admittedBudget = this.assertBudget(repoSlug);
    const baseline = input.baselineId ? requireValue(getBaseline(this.store, input.baselineId), `baseline not found: ${input.baselineId}`) : undefined;
    if (baseline && baseline.repoSlug !== repoSlug) return refuse(`baseline belongs to ${baseline.repoSlug}, not ${repoSlug}`);
    const baseRef = baseline?.testCommit ?? input.baseRef ?? (await this.workspace.defaultBranch(repo));
    const baseSha = await this.workspace.resolveSha(repo, baseRef);
    const workerId = genId('w');
    const branch = `helm/${workerId}`;
    const worktree = join(this.config.home, 'worktrees', repoSlug.replace(/\//g, '__'), workerId);
    mkdirSync(dirname(worktree), { recursive: true });
    await this.workspace.create(repo, worktree, branch, baseSha);
    const createdAt = this.nowIso();
    const row: WorkerRow = {
      workerId, repo, repoSlug, role: input.role, model, objective: input.objective,
      acceptance: input.acceptance ?? null, contextPaths: [...input.contextPaths], allowWorkflows: input.allowWorkflows,
      baseRef, baseSha, branch, worktree, state: 'queued', head: null, sessionFile: null, result: null,
      rawResultText: null, idempotencyKey: input.idempotencyKey ?? null, createdAt, updatedAt: createdAt,
    };
    try {
      this.store.insertWorker(row);
      if (input.issue !== undefined || baseline) this.store.setMeta(workerId, {
        ...(input.issue !== undefined ? { issue: input.issue } : {}),
        ...(baseline ? { issue: baseline.issue, baselineId: baseline.id, prBase: baseline.baseRef } : {}),
      });
      attachWorker(this.store, workerId, admittedBudget.id);
    } catch (err) {
      try { await this.workspace.remove(repo, worktree); } catch { /* best effort cleanup */ }
      throw err;
    }
    this.store.appendEvent(workerId, 'spawned', { repo, repoSlug, role: input.role, model, baseRef, baseSha, branch, worktree });
    const promptInput: PromptInput = { objective: input.objective, acceptance: input.acceptance ?? null, contextPaths: input.contextPaths };
    const message = input.role === 'reviewer' ? this.prompts.reviewer(promptInput)
      : input.role === 'validator' ? this.prompts.validator(promptInput)
        : this.prompts.builder(promptInput);
    this.startRun(workerId, message, onDone);
    return { ok: true, workerId, branch, worktree, ...(this.aboveSoftCap() ? { warning: `spend is above the soft cap of $${this.spendWarnUsd().toFixed(2)}` } : {}) };
  }

  async inspect(input: InspectInput): Promise<ToolOutcome<{
    state: WorkerState; model: string; branch: string; head: string | null; spendUsd: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    diffStat: string; result: WorkerResult | null; events: ReturnType<Store['listEvents']>;
  }>> {
    return runGuard(async () => {
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
    return runGuard(async () => {
      const rows = this.store.listWorkers({ repo: input.repo, state: input.state });
      const workers = rows.map((r) => ({ workerId: r.workerId, state: r.state, role: r.role, model: r.model, branch: r.branch, head: r.head, createdAt: r.createdAt }));
      return { ok: true, workers };
    });
  }

  async supervisorRegister(input: SupervisorRegisterInput): Promise<ToolOutcome<{ supervisor: SupervisorRow }>> {
    return this.supervisor ? this.supervisor.register(input) : { ok: false, reason: 'supervisor service unavailable' };
  }

  async supervisorList(): Promise<ToolOutcome<{ supervisors: SupervisorRow[] }>> {
    return this.supervisor ? this.supervisor.list() : { ok: false, reason: 'supervisor service unavailable' };
  }

  async wakeList(input: WakeListInput): Promise<ToolOutcome<{ wakes: WakeRow[] }>> {
    return this.supervisor ? this.supervisor.wakes(input) : { ok: false, reason: 'supervisor service unavailable' };
  }

  async supervisorRotate(input: SupervisorRotateInput): Promise<ToolOutcome<{ wakes: WakeRow[] }>> {
    return this.supervisor ? this.supervisor.rotate(input) : { ok: false, reason: 'supervisor service unavailable' };
  }

  async steer(input: SteerInput): Promise<ToolOutcome<{ turn: number; warning?: string }>> {
    return runGuard(() => this.withLock(() => this.steerLocked(input)));
  }

  private async steerLocked(input: SteerInput): Promise<ToolOutcome<{ turn: number; warning?: string }>> {
    const row = requireValue(this.store.getWorker(input.workerId), 'worker not found');
    must(STEERABLE_STATES.has(row.state), `worker is ${row.state}, not steerable`);
    must(!this.running.has(input.workerId), 'worker already has a turn in flight');
    must(!this.spendCapExceeded(), 'spend cap reached');
    this.assertBudget(row.repoSlug, input.workerId);
    const priorTurns = this.store.listEvents(input.workerId, { limit: 1_000_000 }).filter((e) => e.kind === 'result').length;
    supersedeOpenInbox(this.store.sql, input.workerId);
    this.startRun(input.workerId, input.message);
    return { ok: true, turn: priorTurns + 1, ...(this.aboveSoftCap() ? { warning: `spend is above the soft cap of $${this.spendWarnUsd().toFixed(2)}` } : {}) };
  }

  async inboxList(input: InboxListInput): Promise<ToolOutcome<{ inbox: ReturnType<typeof listInbox> }>> {
    return runGuard(async () => ({ ok: true, inbox: listInbox(this.store.sql, { project: input.project, state: input.state ?? 'open' }) }));
  }

  async inboxReply(input: InboxReplyInput): Promise<ToolOutcome<{ id: string; workerId: string; turn: number; state: 'answered'; warning?: string }>> {
    return runGuard(() => this.withLock(async () => {
      const item = requireValue(getInbox(this.store.sql, input.id), 'inbox item not found');
      must(item.state === 'open', `inbox item is ${item.state}, not open`);
      const worker = requireValue(this.store.getWorker(item.workerId), 'worker not found');
      must(worker.state === 'waiting', `worker is ${worker.state}, not waiting`);
      must(!this.running.has(worker.workerId), 'worker already has a turn in flight');
      must(!this.spendCapExceeded(), 'spend cap reached');
      this.assertBudget(worker.repoSlug, worker.workerId);
      const answeredAt = this.nowIso();
      must(answerInbox(this.store.sql, item.id, input.answer, input.by, answeredAt), 'inbox item is no longer open');
      const priorTurns = this.store.listEvents(worker.workerId, { limit: 1_000_000 }).filter((e) => e.kind === 'result').length;
      this.startRun(worker.workerId, `Answer to your question: ${input.answer}\nContinue the objective.`);
      return { ok: true, id: item.id, workerId: worker.workerId, turn: priorTurns + 1, state: 'answered', ...(this.aboveSoftCap() ? { warning: `spend is above the soft cap of $${this.spendWarnUsd().toFixed(2)}` } : {}) };
    }));
  }

  async stop(input: StopInput): Promise<ToolOutcome<{ state: WorkerState }>> {
    return runGuard(async () => {
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
    return runGuard(async () => {
      const row = requireValue(this.store.getWorker(input.workerId), 'worker not found');
      must(await this.workspace.isClean(row.worktree), 'worktree is not clean');
      const head = await this.workspace.head(row.worktree);
      const checks = [...(input.checks ?? (await this.gates.defaultChecks(row.repo, row.baseSha)))];
      const meta = this.store.getMeta(row.workerId);
      const baseline = meta?.baselineId ? requireValue(getBaseline(this.store, meta.baselineId), `baseline not found: ${meta.baselineId}`) : undefined;
      if (baseline) {
        const command = (await loadRepoConfig(row.repo, baseline.baseSha, false).catch(() => undefined))?.acceptance?.command ?? baseline.command;
        checks.push({ name: 'acceptance', command });
      }
      const gateId = genId('g');
      const logDir = join(this.config.home, 'logs', input.workerId, `gate-${gateId}`);
      const outcome = await this.gates.run(row.worktree, checks, logDir, { timeoutMs: this.config.gateTimeoutMs });
      const gateRow: GateRow = { gateId, workerId: input.workerId, head, passed: outcome.passed, checks: outcome.checks, at: this.nowIso() };
      this.store.insertGate(gateRow);
      this.store.appendEvent(input.workerId, 'gate', { gateId, passed: outcome.passed, head });
      return { ok: true, head, passed: outcome.passed, checks: outcome.checks };
    });
  }

  async baseline(input: BaselineInput): Promise<ToolOutcome<BaselineRow>> {
    return runGuard(async () => {
      const row = requireValue(this.store.getWorker(input.workerId), 'worker not found');
      return createBaseline({ store: this.store, gates: this.gates, config: this.config, worker: row, now: this.nowIso() });
    });
  }

  async prOpen(input: PrOpenInput): Promise<ToolOutcome<{ number: number; url: string; head: string }>> {
    return runGuard(async () => {
      const reason = await this.refusal('pr.open', input);
      if (reason) return refuse(reason);
      const row = requireValue(this.store.getWorker(input.workerId), 'worker not found');
      const head = requireValue(row.head, 'worker has no commits yet');
      const passing = this.store.listGates(input.workerId).filter((g) => g.head === head && g.passed);
      must(passing.length > 0, `no passing gate at head ${head}`);
      await this.workspace.push(row.worktree, row.branch);
      const title = input.title ?? row.result?.summary?.split('\n')[0] ?? row.objective.slice(0, 72);
      const meta = this.store.getMeta(row.workerId);
      const baseline = meta?.baselineId ? requireValue(getBaseline(this.store, meta.baselineId), `baseline not found: ${meta.baselineId}`) : undefined;
      const body = `${input.body ?? `${row.result?.summary ?? ''}\n\nGate: passed at ${head}`}\n\n${baseline ? `red at ${baseline.baseSha}, green at ${head}` : ''}`;
      const opened = await this.github.openPr({ cwd: row.worktree, base: meta?.prBase ?? row.baseRef, head: row.branch, title, body, draft: input.draft });
      const prRow: PrRow = { number: opened.number, workerId: input.workerId, url: opened.url, head, createdAt: this.nowIso() };
      this.store.insertPr(prRow);
      this.store.appendEvent(input.workerId, 'pr', { number: opened.number, url: opened.url });
      return { ok: true, number: opened.number, url: opened.url, head };
    });
  }

  async prStatus(input: PrStatusInput): Promise<ToolOutcome<PrStatus>> {
    return runGuard(async () => {
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
    return runGuard(async () => {
      if (!input.model) return refuse('record Claude reviews with review.record');
      const byNumber = input.number !== undefined ? this.store.getPrByNumber(input.number) : undefined;
      const byWorker = input.number === undefined && input.workerId ? this.store.getPrByWorker(input.workerId) : undefined;
      const pr = requireValue(byNumber ?? byWorker, 'pr not found');
      const sourceWorker = requireValue(this.store.getWorker(pr.workerId), 'source worker not found');
      const model = input.model;
      must(model !== sourceWorker.model, `reviewer must not be the builder's model (${sourceWorker.model})`);
      must(input.allowSameFamily || modelFamily(model) !== modelFamily(sourceWorker.model),
        `reviewer model family '${modelFamily(model)}' matches the builder's; pick another family or pass allowSameFamily`);
      const objective = `Review PR #${pr.number} (${pr.url}) on branch ${sourceWorker.branch} in ${sourceWorker.repoSlug}. Read the diff, run relevant checks, and report findings as the worker result.`;
      const spawnPayload: SpawnInput = {
        repo: sourceWorker.repo, objective, model, baseRef: sourceWorker.branch,
        role: 'reviewer', contextPaths: [], allowWorkflows: false,
      };
      const onDone: OnDone = async (workerId, result) => {
        const body = result ? `${result.summary}${result.notes ? `\n\n${result.notes}` : ''}` : 'Review did not produce a usable result.';
        await this.github.postComment(sourceWorker.repoSlug, pr.number, body);
        this.store.appendEvent(workerId, 'review.posted', { number: pr.number });
      };
      const outcome = await runGuard(() => this.withLock(() => this.spawnLocked(spawnPayload, onDone)));
      if (!outcome.ok) return outcome;
      return { ok: true, reviewWorkerId: outcome.workerId };
    });
  }

  /** Read-only dashboard data: run status, every worker with spend and last event, and a per-model rollup. */
  async reviewRecord(input: ReviewRecordInput): Promise<ToolOutcome<unknown>> {
    if (!this.review) return refuse('review service is not configured');
    return this.review.record(input);
  }

  async overview(): Promise<ToolOutcome<Overview>> {
    return runGuard(async () => {
      const status = await this.runStatus();
      if (!status.ok) throw new Error(status.reason);
      const now = this.nowIso();
      const workers: OverviewWorker[] = this.store.listWorkers().map((r) => this.overviewWorker(r, now));
      const byModel = new Map<string, OverviewModel>();
      for (const w of workers) {
        const m = byModel.get(w.model) ?? { model: w.model, workers: 0, active: 0, spendUsd: 0, tokens: 0 };
        m.workers += 1; if (ACTIVE_STATES.has(w.state)) m.active += 1; m.spendUsd += w.spendUsd; m.tokens += w.tokens;
        byModel.set(w.model, m);
      }
      let running = 0;
      const spendSeries: SpendPoint[] = this.store.spendSeries(SPEND_SERIES_POINTS).map((p) => {
        running += p.costUsd ?? 0;
        return { at: p.at, spendUsd: running };
      });
      const { ok: _ok, ...run } = status;
      return { ok: true, daemon: this.lifecycle.status(), observedAt: now, run, workers, models: [...byModel.values()].sort((a, b) => b.spendUsd - a.spendUsd), spendSeries };
    });
  }

  /** One worker's drill-down for the dashboard: overview row, result, diff stat, gates, PR and the last events. */
  async workerDetail(workerId: string): Promise<ToolOutcome<WorkerDetail>> {
    return runGuard(async () => {
      const row = requireValue(this.store.getWorker(workerId), 'worker not found');
      let diffStat = '';
      try { diffStat = await this.workspace.diffStat(row.worktree, row.baseSha); } catch { diffStat = ''; }
      const events = this.store.listEvents(workerId, { limit: 1_000_000 }).slice(-DETAIL_EVENT_TAIL);
      return {
        ok: true,
        worker: this.overviewWorker(row, this.nowIso()),
        result: row.result,
        rawResultText: row.rawResultText,
        diffStat,
        gates: this.store.listGates(workerId),
        pr: this.store.getPrByWorker(workerId) ?? null,
        events,
      };
    });
  }

  /** Events across every worker with `seq > afterSeq`, ascending, for the dashboard's incremental poll. */
  async recentEvents(afterSeq = 0, limit = EVENTS_DEFAULT_LIMIT): Promise<ToolOutcome<{ events: EventRow[] }>> {
    return runGuard(async () => {
      const safeAfter = Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
      const safeLimit = Number.isFinite(limit) ? Math.min(EVENTS_MAX_LIMIT, Math.max(1, Math.floor(limit))) : EVENTS_DEFAULT_LIMIT;
      return { ok: true, events: this.store.listAllEvents({ afterSeq: safeAfter, limit: safeLimit }) };
    });
  }

  /** The per-worker row shared by overview() and workerDetail(), so both views agree on every field. */
  private overviewWorker(r: WorkerRow, now: string): OverviewWorker {
    const spend = this.store.spendFor(r.workerId);
    const last = this.store.listEvents(r.workerId, { limit: 1_000_000 }).at(-1);
    const end = ACTIVE_STATES.has(r.state) ? now : r.updatedAt;
    return {
      workerId: r.workerId, state: r.state, role: r.role, model: r.model, repoSlug: r.repoSlug, branch: r.branch, head: r.head,
      objective: r.objective.length > 160 ? `${r.objective.slice(0, 157)}...` : r.objective,
      createdAt: r.createdAt, updatedAt: r.updatedAt, elapsedMs: Math.max(0, Date.parse(end) - Date.parse(r.createdAt)),
      spendUsd: spend.spendUsd, tokens: spend.tokens.input + spend.tokens.output + spend.tokens.cacheRead + spend.tokens.cacheWrite,
      unknownCostEvents: spend.unknownCostEvents,
      lastEvent: last ? { kind: last.kind, at: last.at, data: last.data } : null,
      resultStatus: r.result?.status ?? null,
    };
  }

  /** Soft cap: explicit HELM_SPEND_WARN_USD, else 80% of the hard cap, else none. */
  spendWarnUsd(): number {
    const explicit = this.config.spendWarnUsd ?? 0;
    if (explicit > 0) return explicit;
    return this.config.spendCapUsd > 0 ? Math.round(this.config.spendCapUsd * 0.8 * 100) / 100 : 0;
  }

  private aboveSoftCap(): boolean { const w = this.spendWarnUsd(); return w > 0 && this.store.spendTotal().spendUsd >= w; }

  async runStatus(): Promise<ToolOutcome<{ daemon: ReturnType<Lifecycle['status']>; spendUsd: number; spendCapUsd: number; spendWarnUsd: number; aboveSoftCap: boolean; activeWorkers: number; maxWorkers: number; unknownCostEvents: number; projects: BudgetStatus[] }>> {
    return runGuard(async () => {
      const total = this.store.spendTotal();
      const activeWorkers = this.store.listWorkers().filter((w) => ACTIVE_STATES.has(w.state)).length;
      return {
        ok: true, daemon: this.lifecycle.status(), spendUsd: total.spendUsd, spendCapUsd: this.config.spendCapUsd, spendWarnUsd: this.spendWarnUsd(), aboveSoftCap: this.aboveSoftCap(),
        activeWorkers, maxWorkers: this.config.maxWorkers, unknownCostEvents: total.unknownCostEvents, projects: listBudgetStatuses(this.store),
      };
    });
  }

  async budgetOpen(input: BudgetOpenInput): Promise<ToolOutcome<{ budget: BudgetStatus }>> {
    return runGuard(async () => {
      const reason = await this.refusal('budget.open', input);
      if (reason) return refuse(reason);
      const row = openBudget(this.store, {
        project: input.project, label: input.label, capUsd: input.capUsd, capCodexTokens: input.codexTokens,
        openedAt: this.nowIso(),
      });
      return { ok: true, budget: budgetStatus(this.store, row) };
    });
  }

  async envelopeGet(input: EnvelopeGetInput): Promise<ToolOutcome<EnvelopeView>> {
    envelopePath(this.config.home, input.project);
    return { ok: true, ...readEnvelope(this.config.home, input.project) };
  }

  async budgetClose(input: BudgetCloseInput): Promise<ToolOutcome<{ budget: BudgetStatus }>> {
    return runGuard(async () => {
      const row = requireValue(closeBudget(this.store, input.project, this.nowIso()), `no open budget for ${input.project}`);
      return { ok: true, budget: budgetStatus(this.store, row) };
    });
  }

  async budgetStatus(input: BudgetStatusInput): Promise<ToolOutcome<{ budgets: BudgetStatus[] }>> {
    return runGuard(async () => ({ ok: true, budgets: listBudgetStatuses(this.store, input.project) }));
  }

  /** Wait for a settled worker or timeout; periodically re-read the store, without client polling. */
  async wait(input: WaitInput): Promise<ToolOutcome<{
    settled: Array<{ workerId: string; state: WorkerState; head: string | null; result: WorkerRow['result'] }>;
    pending: string[]; timedOut: boolean; waitedMs: number;
  }>> {
    return runGuard(async () => {
      const started = Date.now();
      for (;;) {
        const rows = input.workerIds.map((id) => requireValue(this.store.getWorker(id), `worker not found: ${id}`));
        const settled = rows.filter((r) => !ACTIVE_STATES.has(r.state));
        const waitedMs = Date.now() - started;
        if (settled.length > 0 || waitedMs >= input.timeoutMs) {
          return {
            ok: true,
            settled: settled.map((r) => ({ workerId: r.workerId, state: r.state, head: r.head, result: r.result })),
            pending: rows.filter((r) => ACTIVE_STATES.has(r.state)).map((r) => r.workerId),
            timedOut: settled.length === 0,
            waitedMs,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, this.waitPollMs));
      }
    });
  }

  async prMerge(input: PrMergeInput): Promise<ToolOutcome<{ merged: true }>> {
    return runGuard(async () => {
      const reason = await this.refusal('pr.merge', input);
      if (reason) return refuse(reason);
      const pr = requireValue(this.store.getPrByNumber(input.number), 'pr not found');
      const worker = requireValue(this.store.getWorker(pr.workerId), 'pr worker not found');
      const status = await this.github.prStatus(worker.repoSlug, input.number);
      must(status.state === 'open', `pr is ${status.state}, not open`);
      must(!status.draft, 'pr is a draft; mark it ready for review first');
      must(status.mergeable !== null, 'github has not finished computing mergeability; try again shortly');
      must(status.mergeable === true, 'pr has conflicts with its base');
      must(status.head === input.expectedHead, `head mismatch: expected ${input.expectedHead}, got ${status.head}`);
      const unfinished = status.checks.find((c) => c.status !== 'completed');
      if (unfinished) return refuse(`check "${unfinished.name}" has not finished (${unfinished.status})`);
      const failing = status.checks.find((c) => !PASSING_CONCLUSIONS.has(c.conclusion ?? ''));
      if (failing) return refuse(`check "${failing.name}" did not succeed (${failing.conclusion ?? 'no conclusion'})`);
      await this.github.merge(worker.repoSlug, input.number, input.expectedHead);
      this.store.appendEvent(pr.workerId, 'pr.merged', { number: input.number, url: pr.url, head: input.expectedHead, project: worker.repoSlug });
      return { ok: true, merged: true };
    });
  }

  async notifyNick(input: { project: string; text: string }): Promise<ToolOutcome<{ sent: true }>> {
    if (!this.discord) return { ok: false, reason: 'Discord is not configured' };
    const result = await this.discord.notifyNick(input.project, input.text);
    return result.ok ? { ok: true, sent: true } : result;
  }

  private nowIso(): string {
    return (this.now ? this.now() : new Date()).toISOString();
  }

  private spendCapExceeded(): boolean {
    return this.config.spendCapUsd > 0 && this.store.spendTotal().spendUsd >= this.config.spendCapUsd;
  }

  private ensureProjectBudget(project: string) {
    const existing = openBudgetFor(this.store, project);
    if (existing) return existing;
    const now = this.nowIso();
    return openBudget(this.store, {
      project,
      label: `auto-${now.slice(0, 10)}`,
      capUsd: this.settings.budgets.defaultCapUsd,
      capCodexTokens: this.settings.budgets.defaultCodexTokens,
      openedAt: now,
    });
  }

  private assertBudget(project: string, workerId?: string): BudgetStatus {
    let budget = workerId ? budgetForWorker(this.store, workerId) : openBudgetFor(this.store, project);
    if (!budget) budget = this.ensureProjectBudget(project);
    if (workerId) attachWorker(this.store, workerId, budget.id);
    const current = budgetStatus(this.store, budget);
    must(!current.exhausted, `budget exhausted (${budget.label} $${current.spentUsd.toFixed(2)}/$${budget.capUsd.toFixed(2)})`);
    return current;
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
      onSession: (sessionFile) => {
        this.store.updateWorker(workerId, { sessionFile });
      },
      onUsage: (usage) => {
        const before = this.store.spendTotal().spendUsd;
        this.store.addSpend({ ...usage, workerId, at: this.nowIso() });
        const warn = this.spendWarnUsd();
        const after = this.store.spendTotal().spendUsd;
        if (warn > 0 && before < warn && after >= warn) this.store.appendEvent(workerId, 'spend.warning', { spendUsd: after, spendWarnUsd: warn, spendCapUsd: this.config.spendCapUsd });
        const budget = budgetForWorker(this.store, workerId);
        if (budget) {
          const current = budgetStatus(this.store, budget);
          if (current.warning && !budgetWarningEmitted(this.store, budget.id)) {
            this.store.appendEvent(workerId, 'spend.warning', {
              project: budget.project, label: budget.label, budgetId: budget.id,
              spentUsd: current.spentUsd, capUsd: current.capUsd,
              spentCodexTokens: current.spentCodexTokens, capCodexTokens: current.capCodexTokens,
            });
          }
        }
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
      if ((row.role === 'builder' || row.role === 'validator') && result?.status !== 'failed') {
        try {
          const commitMessage = result?.summary ?? `helm: ${workerId} turn complete`;
          const head = await this.workspace.commitAll(row.worktree, commitMessage);
          this.store.updateWorker(workerId, { head });
        } catch (err) {
          this.store.appendEvent(workerId, 'error', { message: `commit failed: ${errMessage(err)}` });
        }
      }
      let inboxId: string | undefined;
      if (result?.status === 'question') {
        const question = requireValue(result.question, 'question result is missing question');
        inboxId = createInboxId();
        insertInbox(this.store.sql, { id: inboxId, workerId, project: row.repoSlug, question, createdAt: this.nowIso() });
      }
      let nextState: WorkerState =
        result === null ? 'failed' : result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : result.status === 'question' ? 'waiting' : 'idle';
      // Only report 'stopped' when this turn actually observed the stop request (via
      // hooks.shouldContinue()); a turn that completed on its own keeps its real outcome.
      if (this.stopObserved.has(workerId)) nextState = 'stopped';
      this.stopRequested.delete(workerId);
      this.stopObserved.delete(workerId);
      // `row` was read before the turn, so its sessionFile predates hooks.onSession; fall back to
      // what the store holds now rather than reinstating the stale value.
      const recordedSessionFile = this.store.getWorker(workerId)?.sessionFile ?? row.sessionFile;
      this.store.updateWorker(workerId, { state: nextState, sessionFile: outcome.sessionFile ?? recordedSessionFile, result, rawResultText: result === null ? outcome.rawText : null });
      this.store.appendEvent(workerId, 'result', result ? { ...result } : { rawText: outcome.rawText });
      if (inboxId && result?.status === 'question') this.store.appendEvent(workerId, 'ask', { inboxId, question: result.question });
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
