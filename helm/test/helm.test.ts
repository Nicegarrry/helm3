import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Helm, modelFamily, type HelmPrompts, type SpawnInput } from '../src/helm.js';
import type {
  EventRow,
  GateRow,
  GateRunner,
  GitHub,
  HelmConfig,
  PrRow,
  PrStatus,
  SpendRow,
  SpendSummary,
  Store,
  WorkerHooks,
  WorkerRow,
  WorkerRunInput,
  WorkerRunOutcome,
  WorkerRunner,
  WorkerState,
  Workspace,
} from '../src/types.js';

// ---------- in-memory fakes for the five interfaces Helm depends on ----------

function createFakeStore(): Store {
  const workers = new Map<string, WorkerRow>();
  const events: EventRow[] = [];
  const gates: GateRow[] = [];
  const prs: PrRow[] = [];
  const spend: SpendRow[] = [];
  let seq = 0;

  function summarize(rows: SpendRow[]): SpendSummary {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let spendUsd = 0;
    let unknownCostEvents = 0;
    for (const r of rows) {
      tokens.input += r.inputTokens;
      tokens.output += r.outputTokens;
      tokens.cacheRead += r.cacheReadTokens;
      tokens.cacheWrite += r.cacheWriteTokens;
      if (r.costUsd === null) unknownCostEvents += 1;
      else spendUsd += r.costUsd;
    }
    return { spendUsd, tokens, unknownCostEvents };
  }

  return {
    insertWorker(row) {
      workers.set(row.workerId, row);
    },
    updateWorker(workerId, patch) {
      const cur = workers.get(workerId);
      if (!cur) return;
      workers.set(workerId, { ...cur, ...patch, updatedAt: new Date().toISOString() } as WorkerRow);
    },
    getWorker(workerId) {
      return workers.get(workerId);
    },
    findByIdempotencyKey(key) {
      return [...workers.values()].find((w) => w.idempotencyKey === key);
    },
    listWorkers(filter) {
      return [...workers.values()].filter((w) => (!filter?.repo || w.repo === filter.repo) && (!filter?.state || w.state === filter.state));
    },
    appendEvent(workerId, kind, data = {}) {
      seq += 1;
      const row: EventRow = { seq, workerId, at: new Date().toISOString(), kind, data };
      events.push(row);
      return row;
    },
    listEvents(workerId, opts) {
      const afterSeq = opts?.afterSeq ?? 0;
      const limit = opts?.limit ?? 1000;
      return events.filter((e) => e.workerId === workerId && e.seq > afterSeq).slice(0, limit);
    },
    listAllEvents(opts) {
      const afterSeq = opts?.afterSeq ?? 0;
      const limit = Math.min(opts?.limit ?? 100, 1000);
      return events.filter((e) => e.seq > afterSeq).slice(0, limit);
    },
    insertGate(row) {
      gates.push(row);
    },
    listGates(workerId) {
      return gates.filter((g) => g.workerId === workerId);
    },
    insertPr(row) {
      prs.push(row);
    },
    getPrByWorker(workerId) {
      return [...prs].reverse().find((p) => p.workerId === workerId);
    },
    getPrByNumber(number) {
      return prs.find((p) => p.number === number);
    },
    addSpend(row) {
      spend.push(row);
    },
    spendFor(workerId) {
      return summarize(spend.filter((s) => s.workerId === workerId));
    },
    spendTotal() {
      return summarize(spend);
    },
    spendSeries(limit) {
      return [...spend].sort((a, b) => a.at.localeCompare(b.at)).slice(-limit).map((s) => ({ at: s.at, costUsd: s.costUsd }));
    },
    markInterrupted() {
      const ids: string[] = [];
      for (const w of workers.values()) {
        if (w.state === 'running') {
          workers.set(w.workerId, { ...w, state: 'interrupted' as WorkerState });
          ids.push(w.workerId);
        }
      }
      return ids;
    },
    close() {
      // no-op
    },
  };
}

function createFakeWorkspace() {
  const worktrees = new Map<string, { branch: string; baseSha: string; head: string; clean: boolean }>();
  const pushed: Array<{ path: string; branch: string }> = [];
  let shaCounter = 0;

  const cloned: string[] = [];
  const fetched: string[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const workspace: Workspace = {
    async clone(slug, dest) { cloned.push(`${slug} -> ${dest}`); mkdirSync(join(dest, '.git'), { recursive: true }); },
    async fetch(repo) { fetched.push(repo); },
    async resolveSha(_repo, ref) {
      return `base-sha-${ref}`;
    },
    async defaultBranch() {
      return 'main';
    },
    async create(_repo, root, branch, baseSha) {
      created.push(root);
      worktrees.set(root, { branch, baseSha, head: baseSha, clean: true });
      return { path: root, branch, baseSha };
    },
    async remove(_repo, path) {
      removed.push(path);
      worktrees.delete(path);
    },
    async head(path) {
      return worktrees.get(path)?.head ?? 'unknown';
    },
    async isClean(path) {
      return worktrees.get(path)?.clean ?? true;
    },
    async diffStat() {
      return '1 file changed';
    },
    async commitAll(path) {
      const wt = worktrees.get(path);
      if (!wt) throw new Error(`unknown worktree: ${path}`);
      shaCounter += 1;
      wt.head = `sha-${shaCounter}`;
      wt.clean = true;
      return wt.head;
    },
    async push(path, branch) {
      pushed.push({ path, branch });
    },
  };

  return {
    workspace,
    pushed,
    cloned,
    fetched,
    created,
    removed,
    markDirty(path: string): void {
      const wt = worktrees.get(path);
      if (wt) wt.clean = false;
    },
  };
}

function createFakeGates(defaultResult: { passed: boolean; checks: GateRow['checks'] } = { passed: true, checks: [{ name: 'test', command: 'npm test', exitCode: 0, outputPath: '/tmp/out', durationMs: 5 }] }): GateRunner {
  return {
    async run() {
      return defaultResult;
    },
    async defaultChecks() {
      return [{ name: 'test', command: 'npm test' }];
    },
  };
}

function createFakeGitHub() {
  const prs = new Map<number, PrStatus>();
  const comments: Array<{ repoSlug: string; number: number; body: string }> = [];
  const merged: Array<{ repoSlug: string; number: number; expectedHead: string }> = [];
  let nextNumber = 1;

  const github: GitHub = {
    async openPr({ head: branch }) {
      const number = nextNumber++;
      const url = `https://github.com/acme/repo/pull/${number}`;
      prs.set(number, { number, state: 'open', head: `pr-head-${branch}`, mergeable: true, checks: [], reviews: [], url });
      return { number, url };
    },
    async prStatus(_repoSlug, number) {
      const pr = prs.get(number);
      if (!pr) throw new Error(`pr not found: ${number}`);
      return pr;
    },
    async comment(repoSlug, number, body) {
      comments.push({ repoSlug, number, body });
    },
    async merge(repoSlug, number, expectedHead) {
      merged.push({ repoSlug, number, expectedHead });
      const pr = prs.get(number);
      if (pr) prs.set(number, { ...pr, state: 'merged' });
    },
  };

  return {
    github,
    comments,
    merged,
    setPrStatus(number: number, patch: Partial<PrStatus>): void {
      const pr = prs.get(number);
      if (pr) prs.set(number, { ...pr, ...patch });
    },
  };
}

function createFakeRunner(behavior: (input: WorkerRunInput, message: string, hooks: WorkerHooks) => Promise<WorkerRunOutcome>): WorkerRunner {
  return { run: behavior };
}

/** A worker result meaning "done, succeeded". */
function succeeded(summary = 'did the thing'): WorkerRunner {
  return createFakeRunner(async (input, _message, hooks) => {
    hooks.onUsage({ model: input.model, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
    return { result: { status: 'succeeded', summary, changedFiles: ['a.ts'], commandsRun: ['npm test'] }, rawText: '', sessionFile: `${input.sessionDir}/session.json` };
  });
}

/** A runner whose turns stay pending until `resolveNext` is called, oldest turn first. */
function createControllableRunner() {
  const pending: Array<{ resolve: (outcome: WorkerRunOutcome) => void; hooks: WorkerHooks }> = [];
  const runner: WorkerRunner = {
    run: (_input, _message, hooks) => new Promise<WorkerRunOutcome>((resolve) => pending.push({ resolve, hooks })),
  };
  return {
    runner,
    resolveNext(outcome: WorkerRunOutcome): void {
      const entry = pending.shift();
      if (!entry) throw new Error('no pending turn to resolve');
      entry.resolve(outcome);
    },
    /** The hooks object the oldest still-pending turn was called with, so a test can call
     * hooks.shouldContinue() itself to simulate the runner checking it at a tool boundary. */
    peekHooks(): WorkerHooks {
      const entry = pending[0];
      if (!entry) throw new Error('no pending turn');
      return entry.hooks;
    },
  };
}

const FAKE_PROMPTS: HelmPrompts = {
  builder: (i) => `BUILD: ${i.objective}`,
  reviewer: (i) => `REVIEW: ${i.objective}`,
};

const cleanupDirs: string[] = [];
test.after(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function makeHelm(overrides: Partial<{ config: Partial<HelmConfig>; runner: WorkerRunner; gates: GateRunner; github: GitHub; stopTimeoutMs: number }> = {}) {
  const store = createFakeStore();
  const { workspace, pushed, cloned, fetched, created, removed, markDirty } = createFakeWorkspace();
  const githubFake = createFakeGitHub();
  const config: HelmConfig = { home: mkTempDir('helm-home-'), spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 5000, ...overrides.config };
  const helm = new Helm({
    config,
    store,
    workspace,
    gates: overrides.gates ?? createFakeGates(),
    github: overrides.github ?? githubFake.github,
    runner: overrides.runner ?? succeeded(),
    prompts: FAKE_PROMPTS,
    stopTimeoutMs: overrides.stopTimeoutMs,
  });
  return { helm, store, workspace, pushed, cloned, fetched, created, removed, markDirty, github: githubFake, config };
}

function spawnBody(repo: string, overrides: Partial<SpawnInput> = {}): SpawnInput {
  return { repo, objective: 'do the work', model: 'acme/model-1', role: 'builder', contextPaths: [], allowWorkflows: false, ...overrides };
}

// ---------- tests ----------

test('spawn runs a builder turn, commits on success, and reaches succeeded', async () => {
  const { helm, store } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const outcome = await helm.spawn(spawnBody(repo));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  await helm.settle(outcome.workerId);
  const row = store.getWorker(outcome.workerId);
  assert.equal(row?.state, 'succeeded');
  assert.ok(row?.head, 'head should be recorded after a successful commit');
  assert.equal(row?.result?.status, 'succeeded');
});

test('spawn with owner/name clones once under $HELM_HOME/repos and fetches on reuse', async () => {
  const { helm, store, cloned, fetched, config } = makeHelm();
  const first = await helm.spawn(spawnBody('acme/widgets'));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await helm.settle(first.workerId);
  const expectedRepo = join(config.home, 'repos', 'acme__widgets');
  assert.deepEqual(cloned, [`acme/widgets -> ${expectedRepo}`]);
  assert.equal(store.getWorker(first.workerId)?.repo, expectedRepo);
  const second = await helm.spawn(spawnBody('acme/widgets'));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await helm.settle(second.workerId);
  assert.equal(cloned.length, 1, 'no second clone');
  assert.deepEqual(fetched, [expectedRepo]);
  const bad = await helm.spawn(spawnBody('relative/path/not/a/slug'));
  assert.equal(bad.ok, false);
});

test('spawn is idempotent via idempotencyKey', async () => {
  const { helm } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const first = await helm.spawn(spawnBody(repo, { idempotencyKey: 'k1' }));
  const second = await helm.spawn(spawnBody(repo, { idempotencyKey: 'k1', objective: 'a different objective' }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.equal(second.workerId, first.workerId);
});

test('spawn refuses once active workers reach maxWorkers', async () => {
  const { runner } = createControllableRunner();
  const { helm } = makeHelm({ config: { maxWorkers: 1 }, runner });
  const repo = mkTempDir('helm-repo-');
  const first = await helm.spawn(spawnBody(repo));
  assert.equal(first.ok, true);
  const second = await helm.spawn(spawnBody(repo));
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /max workers/);
});

test('two concurrent spawns respect maxWorkers via the admission mutex (F6)', async () => {
  const { runner } = createControllableRunner();
  const { helm } = makeHelm({ config: { maxWorkers: 1 }, runner });
  const repo = mkTempDir('helm-repo-');
  const [first, second] = await Promise.all([
    helm.spawn(spawnBody(repo)),
    helm.spawn(spawnBody(repo)),
  ]);
  const oks = [first, second].filter((o) => o.ok);
  assert.equal(oks.length, 1, 'exactly one concurrent spawn should be admitted under maxWorkers=1');
});

test('two concurrent spawns with the same idempotencyKey share one workerId and one worktree create (F6)', async () => {
  const { runner } = createControllableRunner();
  const { helm, created } = makeHelm({ runner });
  const repo = mkTempDir('helm-repo-');
  const [first, second] = await Promise.all([
    helm.spawn(spawnBody(repo, { idempotencyKey: 'dup-1' })),
    helm.spawn(spawnBody(repo, { idempotencyKey: 'dup-1' })),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.equal(second.workerId, first.workerId);
  assert.equal(created.length, 1, 'worktree should be created exactly once');
});

test('spawn removes the worktree (best effort) if insertWorker throws (F6)', async () => {
  const store = createFakeStore();
  const originalInsertWorker = store.insertWorker.bind(store);
  let failNextInsert = true;
  store.insertWorker = (row) => {
    if (failNextInsert) {
      failNextInsert = false;
      throw new Error('insert boom');
    }
    originalInsertWorker(row);
  };
  const { workspace, created, removed } = createFakeWorkspace();
  const config: HelmConfig = { home: mkTempDir('helm-home-'), spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 5000 };
  const helm = new Helm({
    config,
    store,
    workspace,
    gates: createFakeGates(),
    github: createFakeGitHub().github,
    runner: succeeded(),
    prompts: FAKE_PROMPTS,
  });
  const repo = mkTempDir('helm-repo-');
  const outcome = await helm.spawn(spawnBody(repo));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /insert boom/);
  assert.equal(created.length, 1, 'worktree was created before the failure');
  assert.deepEqual(removed, created, 'the created worktree should have been removed');
});

test('spawn refuses once the spend cap is reached', async () => {
  const { helm } = makeHelm({ config: { spendCapUsd: 0.005 } }); // succeeded() records $0.01 per turn
  const repo = mkTempDir('helm-repo-');
  const first = await helm.spawn(spawnBody(repo));
  assert.equal(first.ok, true);
  if (first.ok) await helm.settle(first.workerId);
  const second = await helm.spawn(spawnBody(repo));
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /spend cap/);
});

test('soft spend cap: warning event, run.status flag, and spawn warning, without blocking', async () => {
  const { helm, store } = makeHelm({ config: { spendCapUsd: 1, spendWarnUsd: 0.015 } }); // succeeded() records $0.01 per turn
  const repo = mkTempDir('helm-repo-');
  const first = await helm.spawn(spawnBody(repo));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await helm.settle(first.workerId);
  let status = await helm.runStatus();
  assert.equal(status.ok && status.aboveSoftCap, false);
  const second = await helm.spawn(spawnBody(repo));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await helm.settle(second.workerId);
  status = await helm.runStatus();
  assert.equal(status.ok && status.spendWarnUsd, 0.015);
  assert.equal(status.ok && status.aboveSoftCap, true);
  assert.ok(store.listEvents(second.workerId).some((e) => e.kind === 'spend.warning'), 'warning event on the worker that crossed it');
  const third = await helm.spawn(spawnBody(repo));
  assert.equal(third.ok, true, 'soft cap never blocks');
  if (third.ok) assert.match(third.warning ?? '', /soft cap/);
});

test('soft spend cap defaults to 80% of the hard cap', async () => {
  const { helm } = makeHelm({ config: { spendCapUsd: 5 } });
  assert.equal(helm.spendWarnUsd(), 4);
  const none = makeHelm();
  assert.equal(none.helm.spendWarnUsd(), 0);
});

test('modelFamily strips provider and vendor prefixes', () => {
  assert.equal(modelFamily('opencode-go/qwen3.8-flash'), 'qwen');
  assert.equal(modelFamily('opencode-go/glm-5.3-flash'), 'glm');
  assert.equal(modelFamily('google/gemini-3.8-flash'), 'gemini');
  assert.equal(modelFamily('openrouter/nvidia/nemotron-3-ultra:free'), 'nemotron');
  assert.equal(modelFamily('openai-codex/gpt-5.6-luna'), 'gpt');
  assert.equal(modelFamily('anthropic/claude-sonnet-5'), 'claude');
});

test('review.request refuses the builder model and its family unless allowSameFamily', async () => {
  const { helm } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo, { model: 'opencode-go/qwen3.8-flash' }));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  await helm.gate({ workerId: spawned.workerId });
  const opened = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.equal(opened.ok, true);
  const same = await helm.reviewRequest({ workerId: spawned.workerId, model: 'opencode-go/qwen3.8-flash', allowSameFamily: false });
  assert.equal(same.ok, false);
  if (!same.ok) assert.match(same.reason, /builder's model/);
  const family = await helm.reviewRequest({ workerId: spawned.workerId, model: 'openrouter/qwen/qwen3.7-plus', allowSameFamily: false });
  assert.equal(family.ok, false);
  if (!family.ok) assert.match(family.reason, /family 'qwen'/);
  const forced = await helm.reviewRequest({ workerId: spawned.workerId, model: 'openrouter/qwen/qwen3.7-plus', allowSameFamily: true });
  assert.equal(forced.ok, true);
  if (forced.ok) await helm.settle(forced.reviewWorkerId);
  const other = await helm.reviewRequest({ workerId: spawned.workerId, model: 'google/gemini-3.8-flash', allowSameFamily: false });
  assert.equal(other.ok, true);
  if (other.ok) await helm.settle(other.reviewWorkerId);
});

test('gate.run refuses on a dirty worktree', async () => {
  const { helm, markDirty } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  markDirty(spawned.worktree);
  const outcome = await helm.gate({ workerId: spawned.workerId });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /not clean/);
});

test('pr.open is refused without a passing gate at head, then allowed once gated', async () => {
  const { helm, pushed } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);

  const refused = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /gate/);

  const gated = await helm.gate({ workerId: spawned.workerId });
  assert.equal(gated.ok, true);

  const opened = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.equal(opened.ok, true);
  assert.equal(pushed.length, 1);
});

test('steer is refused while running and allowed once idle', async () => {
  const { runner, resolveNext } = createControllableRunner();
  const { helm } = makeHelm({ runner });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;

  const whileRunning = await helm.steer({ workerId: spawned.workerId, message: 'keep going' });
  assert.equal(whileRunning.ok, false);

  resolveNext({ result: { status: 'partial', summary: 'stopped midway', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null });
  await helm.settle(spawned.workerId);

  const afterIdle = await helm.steer({ workerId: spawned.workerId, message: 'keep going' });
  assert.equal(afterIdle.ok, true);
  resolveNext({ result: { status: 'succeeded', summary: 'finished', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null });
  await helm.settle(spawned.workerId);
});

test('two concurrent steer() calls on an idle worker: exactly one succeeds (F2)', async () => {
  const { runner, resolveNext } = createControllableRunner();
  const { helm } = makeHelm({ runner });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  resolveNext({ result: { status: 'succeeded', summary: 'first turn done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null });
  await helm.settle(spawned.workerId);

  const [first, second] = await Promise.all([
    helm.steer({ workerId: spawned.workerId, message: 'go again' }),
    helm.steer({ workerId: spawned.workerId, message: 'also go again' }),
  ]);
  const oks = [first, second].filter((o) => o.ok);
  assert.equal(oks.length, 1, 'exactly one concurrent steer should be accepted');
});

test('steer refuses once the spend cap is reached (F3)', async () => {
  const { helm } = makeHelm({ config: { spendCapUsd: 0.005 } }); // succeeded() records $0.01 per turn
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);

  const outcome = await helm.steer({ workerId: spawned.workerId, message: 'keep going' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /spend cap/);
});

test('stop marks a running worker stopped once its turn observes the stop and settles', async () => {
  const { runner, resolveNext, peekHooks } = createControllableRunner();
  const { helm, store } = makeHelm({ runner });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;

  const stopPromise = helm.stop({ workerId: spawned.workerId });
  await new Promise((r) => setImmediate(r));
  // Simulate the runner checking the stop flag at a tool-call boundary before settling.
  assert.equal(peekHooks().shouldContinue(), false);
  resolveNext({ result: { status: 'partial', summary: 'stopped', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null });
  const stopped = await stopPromise;
  assert.equal(stopped.ok, true);
  if (stopped.ok) assert.equal(stopped.state, 'stopped');
  assert.equal(store.getWorker(spawned.workerId)?.state, 'stopped');
});

test('stop does not force "stopped" when the turn never observed the stop request (F7)', async () => {
  const { runner, resolveNext } = createControllableRunner();
  const { helm, store } = makeHelm({ runner });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;

  const stopPromise = helm.stop({ workerId: spawned.workerId });
  await new Promise((r) => setImmediate(r));
  // The turn completes on its own without ever calling hooks.shouldContinue().
  resolveNext({ result: { status: 'succeeded', summary: 'finished before the stop was seen', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null });
  const stopped = await stopPromise;
  assert.equal(stopped.ok, true);
  if (stopped.ok) assert.equal(stopped.state, 'succeeded');
  assert.equal(store.getWorker(spawned.workerId)?.state, 'succeeded');
});

test('stop refuses when the worker is not running', async () => {
  const { helm } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  const outcome = await helm.stop({ workerId: spawned.workerId });
  assert.equal(outcome.ok, false);
});

test('stop returns unknown and keeps the stop flag set when the turn never settles in time (F1)', async () => {
  const { runner, peekHooks } = createControllableRunner();
  const { helm } = makeHelm({ runner, stopTimeoutMs: 50 });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;

  const outcome = await helm.stop({ workerId: spawned.workerId });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.state, 'unknown');
  // The flag must still be set: shouldContinue() keeps returning false for this worker.
  assert.equal(peekHooks().shouldContinue(), false);
});

test('review.request spawns a reviewer that posts its result as a PR comment', async () => {
  const { helm, store, github } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  await helm.gate({ workerId: spawned.workerId });
  const opened = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const review = await helm.reviewRequest({ workerId: spawned.workerId, model: 'acme/reviewer', allowSameFamily: false });
  assert.equal(review.ok, true);
  if (!review.ok) return;
  await helm.settle(review.reviewWorkerId);

  assert.equal(github.comments.length, 1);
  assert.equal(github.comments[0]?.number, opened.number);
  assert.equal(store.getWorker(review.reviewWorkerId)?.role, 'reviewer');
  const events = store.listEvents(review.reviewWorkerId);
  assert.ok(events.some((e) => e.kind === 'review.posted'));
});

test('pr.merge guards on open state, mergeability, exact head, and green checks', async () => {
  const { helm, github } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  await helm.gate({ workerId: spawned.workerId });
  const opened = await helm.prOpen({ workerId: spawned.workerId, draft: false });
  if (!opened.ok) return;

  const wrongHead = await helm.prMerge({ number: opened.number, expectedHead: 'f'.repeat(40) });
  assert.equal(wrongHead.ok, false);

  github.setPrStatus(opened.number, { head: opened.head, mergeable: false });
  const notMergeable = await helm.prMerge({ number: opened.number, expectedHead: opened.head });
  assert.equal(notMergeable.ok, false);

  github.setPrStatus(opened.number, { head: opened.head, mergeable: true, checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] });
  const failingChecks = await helm.prMerge({ number: opened.number, expectedHead: opened.head });
  assert.equal(failingChecks.ok, false);

  github.setPrStatus(opened.number, { head: opened.head, mergeable: true, checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
  const merged = await helm.prMerge({ number: opened.number, expectedHead: opened.head });
  assert.equal(merged.ok, true);
  assert.equal(github.merged.length, 1);
});

test('markInterruptedOnStart flips running workers to interrupted', async () => {
  const { runner } = createControllableRunner();
  const { helm, store } = makeHelm({ runner });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  if (!spawned.ok) return;
  assert.equal(store.getWorker(spawned.workerId)?.state, 'running');
  const ids = helm.markInterruptedOnStart();
  assert.deepEqual(ids, [spawned.workerId]);
  assert.equal(store.getWorker(spawned.workerId)?.state, 'interrupted');
});

test('workerDetail returns the overview row plus result, diff stat, gates, pr and events for a spawned worker', async () => {
  const { helm } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  assert.equal((await helm.gate({ workerId: spawned.workerId })).ok, true);
  const opened = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const detail = await helm.workerDetail(spawned.workerId);
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  assert.equal(detail.worker.workerId, spawned.workerId);
  assert.equal(detail.worker.state, 'succeeded');
  assert.equal(detail.worker.resultStatus, 'succeeded');
  assert.equal(detail.result?.status, 'succeeded');
  assert.equal(detail.rawResultText, null);
  assert.equal(detail.diffStat, '1 file changed');
  assert.equal(detail.gates.length, 1);
  assert.equal(detail.gates[0]?.passed, true);
  assert.equal(detail.pr?.number, opened.number);
  const kinds = detail.events.map((e) => e.kind);
  assert.equal(kinds[0], 'spawned');
  assert.ok(kinds.includes('gate') && kinds.includes('pr'), `events should include gate and pr: ${kinds.join(',')}`);
  for (let i = 1; i < detail.events.length; i += 1) assert.ok((detail.events[i]?.seq ?? 0) > (detail.events[i - 1]?.seq ?? 0), 'events ascend by seq');

  // The overview row and the detail row are built by the same helper, so they agree field for field.
  const overview = await helm.overview();
  assert.equal(overview.ok, true);
  if (!overview.ok) return;
  const { elapsedMs: _a, ...fromOverview } = overview.workers.find((w) => w.workerId === spawned.workerId) ?? ({} as never);
  const { elapsedMs: _b, ...fromDetail } = detail.worker;
  assert.deepEqual(fromDetail, fromOverview);
});

test('workerDetail refuses an unknown worker', async () => {
  const { helm } = makeHelm();
  const detail = await helm.workerDetail('w-nope');
  assert.deepEqual(detail, { ok: false, reason: 'worker not found' });
});

test('recentEvents pages across all workers by seq', async () => {
  const { helm } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const first = await helm.spawn(spawnBody(repo));
  const second = await helm.spawn(spawnBody(repo));
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  await helm.settle(first.workerId);
  await helm.settle(second.workerId);

  const page1 = await helm.recentEvents(0, 3);
  assert.equal(page1.ok, true);
  if (!page1.ok) return;
  assert.equal(page1.events.length, 3);
  assert.deepEqual(page1.events.map((e) => e.seq), [1, 2, 3]);

  const last = page1.events.at(-1)?.seq ?? 0;
  const page2 = await helm.recentEvents(last);
  assert.equal(page2.ok, true);
  if (!page2.ok) return;
  assert.ok(page2.events.length > 0);
  assert.ok(page2.events.every((e) => e.seq > last), 'only events after the cursor');
  const workerIds = new Set(page2.events.map((e) => e.workerId));
  assert.ok(workerIds.has(first.workerId) && workerIds.has(second.workerId), 'spans both workers');

  const tail = page2.events.at(-1)?.seq ?? 0;
  const empty = await helm.recentEvents(tail);
  assert.equal(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.events, []);
});

test('overview includes a cumulative spendSeries', async () => {
  const { helm } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const first = await helm.spawn(spawnBody(repo));
  const second = await helm.spawn(spawnBody(repo));
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  await helm.settle(first.workerId);
  await helm.settle(second.workerId);

  const overview = await helm.overview();
  assert.equal(overview.ok, true);
  if (!overview.ok) return;
  assert.equal(overview.spendSeries.length, 2, 'one point per usage row');
  assert.ok(Math.abs((overview.spendSeries[0]?.spendUsd ?? 0) - 0.01) < 1e-9);
  assert.ok(Math.abs((overview.spendSeries[1]?.spendUsd ?? 0) - 0.02) < 1e-9, 'second point is cumulative');
  assert.ok((overview.spendSeries[0]?.at ?? '') <= (overview.spendSeries[1]?.at ?? ''), 'ascending by at');
  assert.ok(Math.abs((overview.spendSeries.at(-1)?.spendUsd ?? 0) - overview.run.spendUsd) < 1e-9, 'last point matches the run total');
});
