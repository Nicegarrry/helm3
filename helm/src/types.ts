/**
 * Shared contracts for the Helm harness. Every module codes against these.
 * Keep this file small; if a type is used by one module only, it lives there.
 */
import { z } from 'zod';

// ---------- Worker result (what a Pi worker must end its turn with) ----------

export const workerResultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'partial']),
  summary: z.string().min(1).max(4000),
  changedFiles: z.array(z.string().min(1)).max(500).default([]),
  commandsRun: z.array(z.string().min(1)).max(200).default([]),
  notes: z.string().max(8000).optional(),
}).strict();
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const WORKER_STATES = ['queued', 'running', 'idle', 'succeeded', 'failed', 'stopped', 'interrupted', 'unknown'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];
export const WORKER_ROLES = ['builder', 'reviewer'] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

// ---------- Store rows (SQLite) ----------

export type WorkerRow = Readonly<{
  workerId: string;
  repo: string;            // absolute path of the source repository on disk
  repoSlug: string;        // owner/name if known, else basename
  role: WorkerRole;
  model: string;           // "provider/model" as Pi names it
  objective: string;
  acceptance: string | null;
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

export type PrRow = Readonly<{
  number: number;
  workerId: string;
  url: string;
  head: string;
  createdAt: string;
}>;

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

// ---------- Store interface ----------

export interface Store {
  insertWorker(row: WorkerRow): void;
  updateWorker(workerId: string, patch: Partial<Omit<WorkerRow, 'workerId' | 'createdAt'>>): void;
  getWorker(workerId: string): WorkerRow | undefined;
  findByIdempotencyKey(key: string): WorkerRow | undefined;
  listWorkers(filter?: { repo?: string; state?: WorkerState }): WorkerRow[];
  appendEvent(workerId: string, kind: string, data?: Record<string, unknown>): EventRow;
  listEvents(workerId: string, opts?: { afterSeq?: number; limit?: number }): EventRow[];
  insertGate(row: GateRow): void;
  listGates(workerId: string): GateRow[];
  insertPr(row: PrRow): void;
  getPrByWorker(workerId: string): PrRow | undefined;
  getPrByNumber(number: number): PrRow | undefined;
  addSpend(row: SpendRow): void;
  spendFor(workerId: string): SpendSummary;
  spendTotal(): SpendSummary;
  /** Mark every `running` worker as `interrupted`. Called once on daemon start. Returns affected ids. */
  markInterrupted(): string[];
  close(): void;
}

// ---------- Workspace ----------

export type WorktreeInfo = Readonly<{ path: string; branch: string; baseSha: string }>;

export interface Workspace {
  /** Resolve `ref` in `repo` to a full SHA. */
  resolveSha(repo: string, ref: string): Promise<string>;
  defaultBranch(repo: string): Promise<string>;
  /** `git worktree add -b <branch> <path> <baseSha>` under root. */
  create(repo: string, root: string, branch: string, baseSha: string): Promise<WorktreeInfo>;
  remove(repo: string, path: string): Promise<void>;
  head(path: string): Promise<string>;
  isClean(path: string): Promise<boolean>;
  diffStat(path: string, baseSha: string): Promise<string>;
  /** Stage everything and commit; returns new head. No-op (returns head) if nothing to commit. */
  commitAll(path: string, message: string): Promise<string>;
  push(path: string, branch: string): Promise<void>;
}

// ---------- Gates ----------

export type GateCheck = Readonly<{ name: string; command: string }>;

export interface GateRunner {
  /** Run each check in `cwd` sequentially; capture output to files under `logDir`. */
  run(cwd: string, checks: readonly GateCheck[], logDir: string, opts?: { timeoutMs?: number }): Promise<Omit<GateRow, 'gateId' | 'workerId' | 'head' | 'at'>>;
  /** Read helm.gates from `<repo>/helm.json` or fall back to defaults derived from package.json scripts. */
  defaultChecks(repo: string): Promise<GateCheck[]>;
}

// ---------- GitHub ----------

export type PrStatus = Readonly<{
  number: number;
  state: 'open' | 'closed' | 'merged';
  head: string;
  mergeable: boolean | null;
  checks: ReadonlyArray<{ name: string; status: string; conclusion: string | null }>;
  reviews: ReadonlyArray<{ author: string; state: string }>;
  url: string;
}>;

export interface GitHub {
  openPr(input: { cwd: string; base: string; head: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }>;
  prStatus(repoSlug: string, number: number): Promise<PrStatus>;
  comment(repoSlug: string, number: number, body: string): Promise<void>;
  merge(repoSlug: string, number: number, expectedHead: string): Promise<void>;
}

// ---------- Worker runtime ----------

export type WorkerRunInput = Readonly<{
  workerId: string;
  role: WorkerRole;
  model: string;           // "provider/model"
  worktree: string;
  objective: string;
  acceptance: string | null;
  contextPaths: readonly string[];
  allowWorkflows: boolean;
  sessionFile: string | null; // resume when set
  sessionDir: string;         // where new session files go
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
  /** Return false to stop the turn (spend cap hit or stop requested). Checked at tool-call boundaries. */
  shouldContinue(): boolean;
}>;

// ---------- Tool boundary ----------

export type ToolOk<T> = { ok: true } & T;
export type ToolErr = { ok: false; reason: string };
export type ToolOutcome<T> = ToolOk<T> | ToolErr;

export const spawnInput = z.object({
  repo: z.string().min(1),
  objective: z.string().min(1).max(20000),
  acceptance: z.string().max(20000).optional(),
  model: z.string().min(1),
  baseRef: z.string().min(1).optional(),
  role: z.enum(WORKER_ROLES).default('builder'),
  contextPaths: z.array(z.string().min(1)).max(64).default([]),
  allowWorkflows: z.boolean().default(false),
  idempotencyKey: z.string().min(1).max(200).optional(),
}).strict();
export const inspectInput = z.object({ workerId: z.string().min(1), tail: z.number().int().min(0).max(500).default(20) }).strict();
export const listInput = z.object({ repo: z.string().min(1).optional(), state: z.enum(WORKER_STATES).optional() }).strict();
export const steerInput = z.object({ workerId: z.string().min(1), message: z.string().min(1).max(20000) }).strict();
export const stopInput = z.object({ workerId: z.string().min(1) }).strict();
export const gateInput = z.object({ workerId: z.string().min(1), checks: z.array(z.object({ name: z.string().min(1), command: z.string().min(1) })).max(20).optional() }).strict();
export const prOpenInput = z.object({ workerId: z.string().min(1), title: z.string().max(200).optional(), body: z.string().max(60000).optional(), draft: z.boolean().default(true) }).strict();
export const prStatusInput = z.object({ number: z.number().int().positive().optional(), workerId: z.string().min(1).optional() }).strict();
export const reviewInput = z.object({ workerId: z.string().min(1).optional(), number: z.number().int().positive().optional(), model: z.string().min(1) }).strict();
export const prMergeInput = z.object({ number: z.number().int().positive(), expectedHead: z.string().regex(/^[0-9a-f]{40}$/) }).strict();
export const emptyInput = z.object({}).strict();

export const TOOL_NAMES = ['worker.spawn', 'worker.inspect', 'worker.list', 'worker.steer', 'worker.stop', 'gate.run', 'pr.open', 'pr.status', 'review.request', 'run.status', 'pr.merge'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// ---------- Config ----------

export type HelmConfig = Readonly<{
  home: string;            // $HELM_HOME, default ~/.helm
  spendCapUsd: number;     // 0 = no cap
  maxWorkers: number;
  gateTimeoutMs: number;
}>;
