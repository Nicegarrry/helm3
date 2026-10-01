/** Shared contracts for the Helm harness. */
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
function omitEmptyStrings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitEmptyStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
      if (typeof entry === 'string' && entry.trim() === '') return [];
      return [[key, omitEmptyStrings(entry)]];
    }));
  }
  return value;
}

export const workerResultSchema = z.preprocess(omitEmptyStrings, z.object({
  status: z.enum(['succeeded', 'failed', 'partial', 'question']),
  summary: z.string().min(1).max(4000),
  changedFiles: z.array(z.string().min(1)).max(500).default([]),
  commandsRun: z.array(z.string().min(1)).max(200).default([]),
  question: z.string().min(1).max(4000).optional(),
  notes: z.string().max(8000).optional(),
  claims: z.array(z.string().max(300, 'at most 300 chars')).max(12, 'at most 12').optional(),
  acceptance: z.object({ command: z.string().min(1), files: z.array(z.string().min(1)) }).optional(),
}).strict().superRefine((result, ctx) => {
  if (result.status === 'question' && !result.question) {
    ctx.addIssue({ code: 'custom', path: ['question'], message: 'question is required when status is question' });
  }
}));
export type WorkerResult = z.infer<typeof workerResultSchema>;
export const WORKER_STATES = ['queued', 'running', 'idle', 'waiting', 'succeeded', 'failed', 'stopped', 'interrupted', 'unknown'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];
export const WORKER_ROLES = ['builder', 'reviewer', 'validator'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];
export type WorkerNetwork = Readonly<{ allow: readonly string[] }>;
export const LOAD_CLASSES = ['light', 'medium', 'heavy'] as const;
export type LoadClass = (typeof LOAD_CLASSES)[number];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const; export type Priority = (typeof PRIORITIES)[number];
export const INBOX_STATES = ['open', 'answered', 'superseded'] as const;
export type InboxState = (typeof INBOX_STATES)[number];
export type InboxRow = Readonly<{
  id: string;
  workerId: string;
  project: string;
  question: string;
  state: InboxState;
  answer: string | null;
  answeredBy: string | null;
  triage: Record<string, unknown> | null;
  createdAt: string;
  answeredAt: string | null;
}>;

export type WorkerRow = Readonly<{
  workerId: string;
  repo: string;            // absolute path of the source repository on disk
  repoSlug: string;        // owner/name if known, else basename
  role: WorkerRole;
  model: string;           // "provider/model" as Pi names it
  objective: string;
  acceptance: string | null;
  contextPaths: readonly string[];
  allowWorkflows: boolean;
  network?: WorkerNetwork;
  baseRef: string;
  baseSha: string;
  branch: string;
  worktree: string;        // absolute path
  state: WorkerState;
  head: string | null;     // last known commit in the worktree
  sessionFile: string | null; // Pi session file for resume
  result: WorkerResult | null;
  rawResultText: string | null; // saved when parsing failed
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}>;
export type WorkerMeta = Readonly<{
  workerId: string;
  issue: number | null;
  prBase: string | null;
  baselineId: string | null;
  tier: number | null;
  score: number | null;
  chosenModel: string | null;
  policyApplied: Readonly<{ lanes: readonly ('codex' | 'pi' | 'claude')[]; subscriptionOnly: boolean }> | null;
  skippedCandidates: readonly Readonly<{ model: string; reason: string; tier: number }>[];
  skills: readonly string[];
}>;

export type EventRow = Readonly<{
  seq: number;             // monotonic per store
  workerId: string;
  at: string;
  kind: string;            // e.g. 'spawned', 'turn.start', 'tool.call', 'tool.refused', 'usage', 'result', 'state', 'error'
  data: Record<string, unknown>;
}>;

export type GateRow = Readonly<{
  gateId: string;
  workerId: string;
  head: string;
  passed: boolean;
  checks: ReadonlyArray<{ name: string; command: string; exitCode: number | null; outputPath: string; durationMs: number }>;
  at: string;
}>;
export type BaselineRow = Readonly<{ id: string; repoSlug: string; issue: number; validatorId: string; baseRef: string; baseSha: string; testCommit: string; command: string; files: readonly string[]; red: number; outputPath: string; at: string }>;
export type PrRow = Readonly<{
  repoSlug: string;
  number: number;
  workerId: string;
  url: string;
  head: string;
  createdAt: string;
  state: 'open' | 'merged' | 'closed' | null;
  checkedAt: string | null;
}>;
export type PrInput = Omit<PrRow, 'repoSlug' | 'state' | 'checkedAt'> & { repoSlug?: string; state?: PrRow['state']; checkedAt?: string | null };
export type PrResolution = Readonly<{ pr?: PrRow; reason?: string }>;
export type SpendRow = Readonly<{
  workerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;  // null when the model has no known price
  at: string;
}>;
export type SpendSummary = Readonly<{
  spendUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  unknownCostEvents: number;
}>;
export const SPEND_LIMIT_NAMES = ['capUsd', 'warnUsd', 'maxWorkers'] as const;
export type SpendLimitName = (typeof SPEND_LIMIT_NAMES)[number];
export type SpendLimitSource = 'settings' | 'env' | 'default' | 'spend.set' | 'file';
export type SpendLimitRow = Readonly<{ name: SpendLimitName; value: number; source: SpendLimitSource; at: string; tapId: string | null }>;
export type SpendLimitState = Readonly<{ checksum: string; rows: readonly SpendLimitRow[]; at: string }>;
export interface Store {
  sql: DatabaseSync;
  insertWorker(row: WorkerRow): void;
  updateWorker(workerId: string, patch: Partial<Omit<WorkerRow, 'workerId' | 'createdAt'>>): void;
  getWorker(workerId: string): WorkerRow | undefined;
  getMeta(workerId: string): WorkerMeta | undefined;
  setMeta(workerId: string, meta: Partial<Omit<WorkerMeta, 'workerId'>>): void;
  findByIdempotencyKey(key: string): WorkerRow | undefined;
  listWorkers(filter?: { repo?: string; state?: WorkerState }): WorkerRow[];
  appendEvent(workerId: string, kind: string, data?: Record<string, unknown>, at?: string): EventRow;
  latestEvent(workerId: string): EventRow | undefined;
  listEvents(workerId: string, opts?: { afterSeq?: number; limit?: number }): EventRow[];
  /** Events across every worker, ascending seq, `seq > afterSeq`. Default limit 100, capped at 1000. */
  listAllEvents(opts?: { afterSeq?: number; limit?: number }): EventRow[];
  getCursor(name: string): number;
  setCursor(name: string, seq: number): void;
  insertGate(row: GateRow): void;
  listGates(workerId: string): GateRow[];
  insertPr(row: PrInput): void;
  updatePr(row: PrRow): void;
  getPrByWorker(workerId: string): PrRow | undefined;
  getPrByNumber(repoSlug: string, number: number): PrRow | undefined;
  listPrs(): PrRow[];
  resolvePrByNumber(number: number, project?: string): PrResolution;
  addSpend(row: SpendRow): void;
  spendFor(workerId: string): SpendSummary;
  spendTotal(): SpendSummary;
  /** The last `limit` spend rows (by insertion order), returned ascending by `at`. Feeds the cumulative spend chart. */
  spendSeries(limit: number): Array<{ at: string; costUsd: number | null }>;
  getSpendLimits(): SpendLimitRow[];
  setSpendLimits(rows: readonly SpendLimitRow[]): void;
  getSpendLimitState(): SpendLimitState | undefined;
  setSpendLimitState(state: SpendLimitState): void;
  /** Mark every `running` worker as `interrupted`. Called once on daemon start. Returns affected ids. */
  markInterrupted(): string[];
  close(): void;
}

export type WorktreeInfo = Readonly<{ path: string; branch: string; baseSha: string }>;

export interface Workspace {
  /** Resolve `ref` in `repo` to a full SHA. */
  resolveSha(repo: string, ref: string): Promise<string>;
  defaultBranch(repo: string): Promise<string>;
  /** `git worktree add -b <branch> <path> <baseSha>` under root. */
  create(repo: string, root: string, branch: string, baseSha: string): Promise<WorktreeInfo>;
  remove(repo: string, path: string): Promise<void>;
  prune?(repo: string): Promise<void>;
  deleteBranch?(repo: string, branch: string): Promise<void>;
  isTrackedClean?(path: string): Promise<boolean>;
  /** Whether an origin ref other than `excludeBranch` contains `head`. */
  contains?(repo: string, head: string, excludeBranch?: string): Promise<boolean>;
  /** Whether any origin remote ref contains `head`, including the worker branch. */
  reachableFromOrigin?(repo: string, head: string): Promise<boolean>;
  head(path: string): Promise<string>;
  isClean(path: string): Promise<boolean>;
  diffStat(path: string, baseSha: string): Promise<string>;
  /** Stage everything and commit; returns new head. No-op (returns head) if nothing to commit. */
  patchId(repo: string, baseSha: string, head: string): Promise<string>;
  commitAll(path: string, message: string, repo?: string): Promise<string>;
  push(path: string, branch: string): Promise<void>;
  /** Clone `owner/name` into `dest`, preferring `gh repo clone` (uses gh auth) and falling back to https. */
  clone(slug: string, dest: string): Promise<void>;
  /** Fetch origin, optionally pinning a branch into refs/helm/base/<branch>. */
  fetch(repo: string, branch?: string, source?: string): Promise<void>;
}

export type GateCheck = Readonly<{ name: string; command: string }>;

export interface GateRunner {
  /** Run each check in `cwd` sequentially; capture output to files under `logDir`. */
  run(cwd: string, checks: readonly GateCheck[], logDir: string, opts?: { timeoutMs?: number; nodeModulesRoot?: string; keepNodeModules?: boolean; signal?: AbortSignal; sandbox?: boolean; onNodeModulesError?: (message: string) => void; onUnsandboxed?: (reason: string) => void; onRefused?: (reason: string) => void; onPid?: (pid: number) => void }): Promise<Omit<GateRow, 'gateId' | 'workerId' | 'head' | 'at'>>;
  /** Read helm.gates from `<repo>/helm.json` or fall back to defaults derived from package.json scripts. */
  defaultChecks(repo: string, sha?: string): Promise<GateCheck[]>;
}

export type PrStatus = Readonly<{
  number: number;
  state: 'open' | 'closed' | 'merged';
  head: string;
  mergeable: boolean | null;
  draft: boolean;
  /** `status` is lower-case and is `completed` only when the check has finished; `conclusion` is lower-case and null until then, for check runs and commit-status contexts alike. */
  checks: ReadonlyArray<{ name: string; status: string; conclusion: string | null }>;
  reviews: ReadonlyArray<{ author: string; state: string }>;
  url: string;
  title?: string;
  base?: string;
  body?: string;
}>;

/** Raw fields returned by gh pr list. */
export type WorkerPr = Readonly<{ headRefName: string; number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergedAt: string | null; body: string; headRefOid: string }>;

export interface GitHub {
  openPr(input: { cwd: string; base: string; head: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }>;
  findPr?(repoSlug: string, head: string): Promise<{ number: number; url: string } | undefined>;
  updatePr?(repoSlug: string, number: number, input: { title?: string; body?: string }): Promise<void>;
  issueTitle?(repoSlug: string, number: number): Promise<string | undefined>;
  issue?(repoSlug: string, number: number): Promise<GitHubIssue | undefined>;
  prStatus(repoSlug: string, number: number): Promise<PrStatus>;
  comment(repoSlug: string, id: number): Promise<GitHubComment>;
  postComment(repoSlug: string, number: number, body: string): Promise<string>;
  listWorkerPrs?(repoSlug: string, mergedSince: string): Promise<WorkerPr[]>;
  merge(repoSlug: string, number: number, expectedHead: string): Promise<void>;
}

export type GitHubComment = Readonly<{ body: string; issueNumber?: number; issueUrl?: string; pullRequestUrl?: string }>;
export type GitHubIssue = Readonly<{ title?: string; body?: string; comments?: ReadonlyArray<{ author?: string; body: string }> }>;

export type WorkerRunInput = Readonly<{
  workerId: string;
  role: WorkerRole;
  model: string;           // "provider/model"
  worktree: string;
  objective: string;
  acceptance: string | null;
  contextPaths: readonly string[];
  allowWorkflows: boolean;
  network?: WorkerNetwork;
  sessionFile: string | null; // resume when set
  sessionDir: string;         // where new session files go
  tempDir?: string;            // per-worker temp directory for sandboxed CLI processes
}>;

export type WorkerRunOutcome = Readonly<{
  result: WorkerResult | null;
  rawText: string;
  sessionFile: string | null;
}>;

export interface WorkerRunner {
  /** Run one turn (objective or steer message). Emits events through `emit`; resolves when the turn ends. */
  run(input: WorkerRunInput, message: string, hooks: WorkerHooks): Promise<WorkerRunOutcome>;
}

export type WorkerHooks = Readonly<{
  emit(kind: string, data?: Record<string, unknown>): void;
  onUsage(usage: Omit<SpendRow, 'workerId' | 'at'>): void;
  /** The Pi session file, reported as soon as it is opened rather than when the turn returns. */
  onSession(sessionFile: string): void;
  /** The process tree root for the current turn, for capacity/RSS accounting. */
  onPid?(pid: number): void;
  /** Return false to stop the turn (spend cap hit or stop requested). Checked at tool-call boundaries. */
  shouldContinue(): boolean;
}>;
export type ToolOk<T> = { ok: true } & T;
export type ToolErr = { ok: false; reason: string };
export type ToolOutcome<T> = ToolOk<T> | ToolErr;

export type SupervisorHost = 'herdr' | 'tmux';
export type SupervisorRow = Readonly<{
  project: string;
  repo: string;
  host: SupervisorHost;
  label: string;
  createdAt: string;
  lastWakeAt: string | null;
}>;
export type WakeRow = Readonly<{
  id: string;
  project: string;
  kind: string;
  workerId: string | null;
  summary: string;
  command: boolean;
  createdAt: string;
  deliveredAt: string | null;
  ackedAt: string | null;
}>;
export const spawnInput = z.object({
  repo: z.string().min(1),
  objective: z.string().min(1).max(20000),
  issue: z.number().int().positive().optional(),
  acceptance: z.string().max(20000).optional(),
  model: z.string().min(1).optional(),
  difficulty: z.enum(['super-easy', 'easy', 'normal']).optional(),
  baseRef: z.string().min(1).optional(),
  baselineId: z.string().min(1).optional(),
  role: z.enum(WORKER_ROLES).default('builder'),
  contextPaths: z.array(z.string().min(1)).max(64).default([]),
  allowWorkflows: z.boolean().default(false),
  network: z.object({ allow: z.array(z.string().min(1)) }).strict().optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  skills: z.array(z.string().min(1)).optional(),
  loadClass: z.enum(LOAD_CLASSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  requestedBy: z.enum(['owner', 'auto']).optional(),
  lanes: z.array(z.enum(['codex', 'pi', 'claude'])).max(3).optional(),
}).strict();
export const inspectInput = z.object({ workerId: z.string().min(1), tail: z.number().int().min(0).max(500).default(5), verbose: z.boolean().optional() }).strict();
export const listInput = z.object({ repo: z.string().min(1).optional(), state: z.enum(WORKER_STATES).optional(), verbose: z.boolean().optional() }).strict();
export const steerInput = z.object({ workerId: z.string().min(1), message: z.string().min(1).max(20000) }).strict();
export const retryInput = z.object({ workerId: z.string().min(1), kind: z.enum(['gate', 'acceptance', 'claims', 'review', 'tests_edited', 'conflict']).optional() }).strict();
export const stopInput = z.object({ workerId: z.string().min(1) }).strict();
export const budgetOpenInput = z.object({
  project: z.string().min(1), label: z.string().min(1), capUsd: z.number().positive(), codexTokens: z.number().int().positive().optional(), tapId: z.string().regex(/^t-[0-9a-f]+$/).optional(),
}).strict();
export const budgetCloseInput = z.object({ project: z.string().min(1) }).strict();
export const budgetStatusInput = z.object({ project: z.string().min(1).optional() }).strict();
export const envelopeGetInput = z.object({ project: z.string().min(1) }).strict();
export const envelopeCheckInput = z.object({ project: z.string().min(1), actions: z.array(z.string().min(1).max(2000)).min(1).max(13), kind: z.string().min(1).optional(), baseRef: z.string().min(1).optional(), workerId: z.string().min(1).optional() }).strict();
export const tapRequestInput = z.object({ project: z.string().min(1), kind: z.string().min(1), action: z.string().min(1).max(4000) }).strict();
export const tapConfirmInput = z.object({ id: z.string().regex(/^t-[0-9a-f]+$/), code: z.string().regex(/^\d{6}$/) }).strict();
export const inboxListInput = z.object({ project: z.string().min(1).optional(), state: z.enum(INBOX_STATES).default('open') }).strict();
export const inboxReplyInput = z.object({ id: z.string().regex(/^q-[0-9a-f]+$/), answer: z.string().min(1).max(20000), by: z.string().min(1).max(200).default('supervisor') }).strict();
export const waitInput = z.object({
  workerIds: z.array(z.string().min(1)).min(1).max(20),
  // Bounded under Claude Code's idle window for MCP tool calls (30 minutes on stdio, 5 on
  // HTTP) so a wait is never aborted for silence. A caller that sees `timedOut` waits again.
  timeoutMs: z.number().int().min(1000).max(1_500_000).default(600_000),
}).strict();
export const gateInput = z.object({ workerId: z.string().min(1), checks: z.array(z.object({ name: z.string().min(1), command: z.string().min(1) })).max(20).optional(), verbose: z.boolean().optional() }).strict();
export const baselineInput = z.object({ workerId: z.string().min(1) }).strict();
export const claimsCheckInput = z.object({ workerId: z.string().min(1) }).strict();
export const prOpenInput = z.object({ workerId: z.string().min(1), title: z.string().max(200).optional(), body: z.string().max(60000).optional(), draft: z.boolean().default(true), base: z.string().min(1).optional(), verbose: z.boolean().optional() }).strict();
export const prStatusInput = z.object({ project: z.string().min(1).optional(), repoSlug: z.string().min(1).optional(), number: z.number().int().positive().optional(), workerId: z.string().min(1).optional() }).strict();
export const reviewInput = z.object({ project: z.string().min(1).optional(), repoSlug: z.string().min(1).optional(), workerId: z.string().min(1).optional(), number: z.number().int().positive().optional(), model: z.string().min(1).optional(), allowSameFamily: z.boolean().default(false) }).strict();
export const prMergeInput = z.object({ project: z.string().min(1).optional(), repoSlug: z.string().min(1).optional(), number: z.number().int().positive(), expectedHead: z.string().regex(/^[0-9a-f]{40}$/) }).strict();
export const reviewRecordInput = z.object({
  project: z.string().min(1).optional(), repoSlug: z.string().min(1).optional(), number: z.number().int().positive(), head: z.string().regex(/^[0-9a-f]{40}$/), commentUrl: z.string().url(), reviewer: z.string().min(1), verdict: z.enum(['approve', 'request_changes']),
}).strict();
export const daemonInput = z.object({ action: z.enum(['status', 'drain', 'resume', 'shutdown', 'restart', 'upgrade']), upgradeId: z.string().uuid().optional(), expectedBootId: z.string().uuid().optional(), timeoutMs: z.number().int().min(1).max(86_400_000).optional() }).strict();
export const emptyInput = z.object({}).strict();
export const runStatusInput = z.object({ verbose: z.boolean().optional() }).strict();
export const supervisorRegisterInput = z.object({ project: z.string().min(1), repo: z.string().min(1), host: z.enum(['herdr', 'tmux']), label: z.string().min(1) }).strict();
export const supervisorListInput = emptyInput;
export const wakeListInput = z.object({ project: z.string().min(1), ack: z.boolean().default(false), verbose: z.boolean().optional() }).strict();
export const supervisorRotateInput = z.object({ project: z.string().min(1), focus: z.string().min(1).max(4000) }).strict();
export const notifyOwnerInput = z.object({ project: z.string().min(1), text: z.string().min(1).max(4000) }).strict();
export const jevCheckInput = z.object({ preset: z.enum(['issue', 'dedupe', 'verdict', 'raw']), project: z.string().min(1).optional(), input: z.unknown() }).strict();
export const jevLabelInput = z.object({ id: z.number().int().positive(), label: z.string().min(1).max(200) }).strict();
export { memoryWriteInput, memoryLogInput, memoryListInput } from './memory.js';

export const mergeEnqueueInput = z.object({ project: z.string().min(1).optional(), repoSlug: z.string().min(1).optional(), number: z.number().int().positive() }).strict();
export const mergeQueueInput = z.object({ project: z.string().min(1) }).strict();
export const mergeDequeueInput = z.object({ project: z.string().min(1).optional(), repoSlug: z.string().min(1).optional(), number: z.number().int().positive() }).strict();
export const deployRunInput = z.object({ project: z.string().min(1), target: z.string().min(1), sha: z.string().min(1).optional(), tapId: z.string().optional() }).strict();
export const deployStatusInput = z.object({ project: z.string().min(1).optional(), id: z.string().min(1).optional() }).strict();
export const deployRollbackInput = z.object({ id: z.string().min(1), tapId: z.string().optional() }).strict();

export const routingCheckInput = z.object({}).strict();
export const spendSetInput = z.object({
  capUsd: z.number().nonnegative().optional(), warnUsd: z.number().nonnegative().optional(), maxWorkers: z.number().int().nonnegative().optional(),
  tapId: z.string().regex(/^t-[0-9a-f]+$/).optional(),
}).strict();
export const TOOL_NAMES = ['ticket.cancel', 'ticket.bump', 'worker.spawn', 'worker.inspect', 'worker.list', 'worker.wait', 'worker.steer', 'worker.retry', 'worker.stop', 'gate.run', 'claims.check', 'gate.baseline', 'pr.open', 'pr.status', 'review.request', 'review.record', 'run.status', 'spend.set', 'pr.merge', 'daemon.control', 'budget.open', 'budget.close', 'budget.status', 'envelope.get', 'envelope.check', 'tap.request', 'tap.confirm', 'supervisor.register', 'supervisor.list', 'wake.list', 'supervisor.rotate', 'inbox.list', 'inbox.reply', 'notify.owner', 'notify.nick', 'jev.check', 'jev.label', 'merge.enqueue', 'merge.queue', 'merge.dequeue', 'memory.write', 'memory.log', 'memory.list', 'scorecard.export', 'deploy.run', 'deploy.status', 'deploy.rollback', 'routing.check'] as const;
export type ToolName = string;
export type HelmConfig = Readonly<{
  home: string;            // $HELM_HOME, default ~/.helm
  spendCapUsd: number;     // 0 = no cap
  spendWarnUsd?: number;   // soft cap: warn, never block. Default 80% of the cap when a cap is set
  maxWorkers: number;
  gateTimeoutMs: number;
  spendEnv?: Readonly<{ capUsd?: number; warnUsd?: number; maxWorkers?: number }>;
}>;
