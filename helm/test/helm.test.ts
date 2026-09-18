import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Helm, type HelmPrompts, type SpawnInput } from '../src/helm.js';
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
      worktrees.set(root, { branch, baseSha, head: baseSha, clean: true });
      return { path: root, branch, baseSha };
    },
    async remove(_repo, path) {
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
  const pending: Array<(outcome: WorkerRunOutcome) => void> = [];
  const runner: WorkerRunner = {
    run: () => new Promise<WorkerRunOutcome>((resolve) => pending.push(resolve)),
  };
  return {
    runner,
    resolveNext(outcome: WorkerRunOutcome): void {
      const fn = pending.shift();
      if (!fn) throw new Error('no pending turn to resolve');
      fn(outcome);
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

function makeHelm(overrides: Partial<{ config: Partial<HelmConfig>; runner: WorkerRunner; gates: GateRunner; github: GitHub }> = {}) {
  const store = createFakeStore();
  const { workspace, pushed, cloned, fetched, markDirty } = createFakeWorkspace();
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
  });
  return { helm, store, workspace, pushed, cloned, fetched, markDirty, github: githubFake, config };
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

test('stop marks a running worker stopped once its turn settles', async () => {
  const { runner, resolveNext } = createControllableRunner();
  const { helm, store } = makeHelm({ runner });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;

  const stopPromise = helm.stop({ workerId: spawned.workerId });
  await new Promise((r) => setImmediate(r));
  resolveNext({ result: { status: 'partial', summary: 'stopped', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null });
  const stopped = await stopPromise;
  assert.equal(stopped.ok, true);
  if (stopped.ok) assert.equal(stopped.state, 'stopped');
  assert.equal(store.getWorker(spawned.workerId)?.state, 'stopped');
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

  const review = await helm.reviewRequest({ workerId: spawned.workerId, model: 'acme/reviewer' });
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
