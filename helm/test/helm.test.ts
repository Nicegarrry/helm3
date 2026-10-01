import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { Helm, modelFamily, type HelmPrompts, type SpawnInput } from '../src/helm.js';
import { budgetForWorker } from '../src/budget.js';
import { createModelCatalog } from '../src/routing/catalog.js';
import { openStore } from '../src/store.js';
import { createSupervisor } from '../src/supervise.js';
import { createToolRegistry } from '../src/tools.js';
import { loadSettings, type Settings } from '../src/settings.js';
import type { Jev } from '../src/jev.js';
import type {
  GateRow,
  GateRunner,
  GitHub,
  HelmConfig,
  PrRow,
  PrStatus,
  Store,
  WorkerHooks,
  WorkerRow,
  WorkerRunInput,
  WorkerRunOutcome,
  WorkerRunner,
  Workspace,
} from '../src/types.js';

// ---------- fakes for the five interfaces Helm depends on ----------

function createFakeStore(): Store {
  const store = openStore(':memory:');
  cleanupStores.push(store);
  return store;
}

/** Head each fake worktree last pushed; the fake GitHub reports it for the PR it opens from that worktree. */
const pushedHeads = new Map<string, string>();

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
    async patchId(_repo, _base, head) {
      return head;
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
      pushedHeads.set(path, worktrees.get(path)?.head ?? 'unknown');
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
  const opened: Array<{ base: string; head: string; title: string; body: string }> = [];
  const updates: Array<{ repoSlug: string; number: number; input: { title?: string; body?: string } }> = [];
  const existingByHead = new Map<string, { number: number; url: string }>();
  let nextNumber = 1;

  const github: GitHub = {
    async openPr({ cwd, base, head: branch, title, body }) {
      opened.push({ base, head: branch, title, body });
      const number = nextNumber++;
      const url = `https://github.com/acme/repo/pull/${number}`;
      prs.set(number, { number, state: 'open', head: pushedHeads.get(cwd) ?? `pr-head-${branch}`, mergeable: true, draft: false, checks: [], reviews: [], url });
      return { number, url };
    },
    async findPr(_repoSlug, head) { return existingByHead.get(head); },
    async updatePr(repoSlug, number, input) { updates.push({ repoSlug, number, input }); },
    async prStatus(_repoSlug, number) {
      const pr = prs.get(number);
      if (!pr) throw new Error(`pr not found: ${number}`);
      return pr;
    },
    async comment() { return { body: '', issueNumber: 1 }; },
    async postComment(repoSlug, number, body) {
      comments.push({ repoSlug, number, body });
      return `https://github.com/${repoSlug}/pull/${number}#issuecomment-${comments.length}`;
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
    opened,
    updates,
    setExistingPr(head: string, pr: { number: number; url: string }): void {
      existingByHead.set(head, pr);
      prs.set(pr.number, { number: pr.number, state: 'open', head: 'unknown', mergeable: true, draft: false, checks: [], reviews: [], url: pr.url });
    },
    setPrStatus(number: number, patch: Partial<PrStatus>): void {
      const pr = prs.get(number);
      prs.set(number, { number, state: 'open', head: 'unknown', mergeable: true, draft: false, checks: [], reviews: [], url: `https://example.invalid/${number}`, ...pr, ...patch });
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

function asksOnce(): WorkerRunner {
  return createFakeRunner(async (input, _message, hooks) => {
    hooks.onUsage({ model: input.model, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
    return { result: { status: 'question', summary: 'need an answer', question: 'Which path should I take?', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null };
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
  validator: (i) => `VALIDATE: ${i.objective}`,
};

const cleanupDirs: string[] = [];
const cleanupStores: Store[] = [];
test.after(() => {
  for (const store of cleanupStores) store.close();
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function mkTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

type HelmTestOverrides = Partial<{ config: Partial<HelmConfig>; runner: WorkerRunner; gates: GateRunner; github: GitHub; workerInstall: boolean; stopTimeoutMs: number; waitPollMs: number; jev: Jev; statfs: (path: string) => Promise<{ bavail: number; bsize: number }> }> & {
  settings?: Omit<Partial<Settings>, 'budgets'> & { budgets?: Partial<Settings['budgets']> };
};

function makeHelm(overrides: HelmTestOverrides = {}) {
  const store = createFakeStore();
  const { workspace, pushed, cloned, fetched, created, removed, markDirty } = createFakeWorkspace();
  const githubFake = createFakeGitHub();
  const config: HelmConfig = { home: mkTempDir('helm-home-'), spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 5000, ...overrides.config };
  const defaults = loadSettings(config.home);
  const settings: Settings = { ...defaults, ...overrides.settings, budgets: { ...defaults.budgets, ...overrides.settings?.budgets } };
  const routingCatalog = createModelCatalog({
    claudeLaneRegistered: false,
    sources: { codexModels: () => [], piModels: () => [], claudeAvailable: () => false },
    probe: { codex: () => true, pi: () => true, claude: () => false },
  });
  const supervisor = createSupervisor({ store, settings, hosts: { herdr: {} as never, tmux: {} as never } });
  const helm = new Helm({
    config,
    store,
    workspace,
    gates: overrides.gates ?? createFakeGates(),
    github: overrides.github ?? githubFake.github,
    runner: overrides.runner ?? succeeded(),
    prompts: FAKE_PROMPTS,
    routingCatalog,
    settings,
    supervisor,
    workerInstall: overrides.workerInstall,
    jev: overrides.jev,
    statfs: overrides.statfs,
    stopTimeoutMs: overrides.stopTimeoutMs,
    waitPollMs: overrides.waitPollMs,
    headWaitMs: 50,
    headPollMs: 5,
  });
  return { helm, store, workspace, pushed, cloned, fetched, created, removed, markDirty, github: githubFake, config };
}

function spawnBody(repo: string, overrides: Partial<SpawnInput> = {}): SpawnInput {
  return { repo, objective: 'do the work', model: 'acme/model-1', role: 'builder', contextPaths: [], allowWorkflows: false, ...overrides };
}

// ---------- tests ----------

test('envelope check does not clone or fetch when branch lookup has no local checkout', async () => {
  const { helm, cloned, fetched } = makeHelm();
  const outcome = await helm.envelopeCheck({ project: 'acme/app', actions: ['git push origin feature-x'] });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.decisions[0], { action: 'git push origin feature-x', decision: 'tap', source: 'hard', pTap: null });
  assert.deepEqual(cloned, []);
  assert.deepEqual(fetched, []);
});

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

function priorityJev(choices: { class?: string; size?: string } | Error): Jev {
  return { shadow: false, async ask(_purpose, input) {
    if (!('class' in input.questions)) return { ok: false, reason: 'unexpected question' };
    if (choices instanceof Error) throw choices;
    return { ok: true, answers: { class: { choice: choices.class }, size: { choice: choices.size } } };
  } };
}

function admissionEvent(store: Store, workerId: string) {
  return store.listEvents(workerId, { limit: 100 }).find((event) => event.kind === 'admission.priority')?.data;
}

test('a security-classified objective is bumped to high and recorded in admission.priority', async () => {
  const { helm, store } = makeHelm({ jev: priorityJev({ class: 'security', size: 's' }) });
  const outcome = await helm.spawn(spawnBody(mkTempDir('helm-priority-security-'), { priority: 'low', requestedBy: 'owner' }));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.deepEqual(admissionEvent(store, outcome.workerId), {
    stated: 'low', requestedBy: 'owner', class: 'security', size: 's', effective: 'high', score: 45,
    reasons: ['priority high +20', 'requested by owner +15', 'quick win (s) +10'],
  });
  const urgent = await helm.spawn(spawnBody(mkTempDir('helm-priority-urgent-'), { priority: 'urgent' }));
  assert.ok(urgent.ok);
  if (urgent.ok) assert.equal(admissionEvent(store, urgent.workerId)?.effective, 'urgent');
});

test('a Jev failure or unusable answer falls back to the stated priority without blocking the spawn', async () => {
  for (const jev of [priorityJev(new Error('jev down')), priorityJev({ class: 'nonsense', size: 'huge' }), undefined]) {
    const { helm, store } = makeHelm({ jev });
    const outcome = await helm.spawn(spawnBody(mkTempDir('helm-priority-fallback-'), { priority: 'high' }));
    assert.ok(outcome.ok);
    if (!outcome.ok) return;
    assert.deepEqual(admissionEvent(store, outcome.workerId), { stated: 'high', requestedBy: 'auto', class: null, size: null, effective: 'high', score: 20, reasons: ['priority high +20'] });
  }
});

test('a repo helm.json priority is the project default and an explicit priority overrides it', async () => {
  const { helm, store } = makeHelm();
  const repo = mkTempDir('helm-priority-default-');
  writeFileSync(join(repo, 'helm.json'), JSON.stringify({ priority: 'urgent' }));
  const defaulted = await helm.spawn(spawnBody(repo));
  const explicit = await helm.spawn(spawnBody(repo, { priority: 'low' }));
  assert.ok(defaulted.ok && explicit.ok);
  if (!defaulted.ok || !explicit.ok) return;
  assert.equal(admissionEvent(store, defaulted.workerId)?.stated, 'urgent');
  assert.equal(admissionEvent(store, explicit.workerId)?.stated, 'low');
  const plain = await helm.spawn(spawnBody(mkTempDir('helm-priority-none-')));
  assert.ok(plain.ok);
  if (plain.ok) assert.equal(admissionEvent(store, plain.workerId)?.stated, 'normal');
});

test('dispatched issue-title lookup runs after spawn admission and falls back on failure', async () => {
  let resolveTitle!: (title: string) => void;
  const lookup = new Promise<string>((resolve) => { resolveTitle = resolve; });
  const seed = makeHelm();
  const first = makeHelm({ github: { ...seed.github.github, issueTitle: async () => lookup } });
  const repo = mkTempDir('helm-dispatched-title-');
  const started = Date.now();
  const outcome = await first.helm.spawn(spawnBody(repo, { issue: 42, objective: 'first objective line\nmore detail' }));
  assert.ok(outcome.ok);
  assert.ok(Date.now() - started < 500, 'spawn should not wait for issue title lookup');
  if (!outcome.ok) return;
  resolveTitle('Issue title');
  await new Promise((resolve) => setImmediate(resolve));
  const dispatched = first.store.listEvents(outcome.workerId, { limit: 100 }).find((event) => event.kind === 'dispatched');
  assert.equal(dispatched?.data.issue, 42);
  assert.equal(dispatched?.data.title, 'Issue title');
  assert.equal(dispatched?.data.model, 'acme/model-1');

  const second = makeHelm({ github: { ...seed.github.github, issueTitle: async () => { throw new Error('unavailable'); } } });
  const fallback = await second.helm.spawn(spawnBody(mkTempDir('helm-dispatched-fallback-'), { issue: 43, objective: 'fallback title\nother detail' }));
  assert.ok(fallback.ok);
  if (fallback.ok) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(second.store.listEvents(fallback.workerId, { limit: 100 }).find((event) => event.kind === 'dispatched')?.data.title, 'fallback title');
  }
});

test('dispatch milestone rejection becomes a warning event instead of an unhandled rejection', async () => {
  const { helm, store } = makeHelm();
  const appendEvent = store.appendEvent.bind(store);
  store.appendEvent = (workerId, kind, data, at) => {
    if (kind === 'dispatched') throw new Error('milestone write failed');
    return appendEvent(workerId, kind, data, at);
  };
  const outcome = await helm.spawn(spawnBody(mkTempDir('helm-dispatched-warning-'), { issue: 44 }));
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  await new Promise((resolve) => setImmediate(resolve));
  const warning = store.listEvents(outcome.workerId).find((event) => event.kind === 'dispatched.warning');
  assert.equal(warning?.data.message, 'dispatch milestone failed: milestone write failed');
});

test('worker.spawn with issue: injects issue title, body, and last 3 comments into brief', async () => {
  let capturedMessage = '';
  const runner = createFakeRunner(async (_input, message) => {
    capturedMessage = message;
    return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null };
  });
  const seed = makeHelm();
  const github: GitHub = {
    ...seed.github.github,
    issue: async (_repo, number) => ({
      title: 'Fix widget overflow',
      body: 'Widget overflows container when screen is narrow.',
      comments: [
        { author: 'carol', body: 'Old comment that should be skipped' },
        { author: 'alice', body: 'Confirmed on mobile' },
        { author: 'bob', body: 'Reproduced in Chrome too' },
        { author: 'dave', body: 'I will write tests' },
      ],
    }),
  };
  const { helm } = makeHelm({ runner, github });
  const repo = mkTempDir('helm-spawn-issue-');
  const outcome = await helm.spawn(spawnBody(repo, { issue: 294, objective: 'Fix widget' }));
  assert.ok(outcome.ok);
  assert.ok(capturedMessage.includes('Issue #294: Fix widget overflow'));
  assert.ok(capturedMessage.includes('Widget overflows container when screen is narrow.'));
  assert.ok(!capturedMessage.includes('Old comment that should be skipped'));
  assert.ok(capturedMessage.includes('alice: Confirmed on mobile'));
  assert.ok(capturedMessage.includes('bob: Reproduced in Chrome too'));
  assert.ok(capturedMessage.includes('dave: I will write tests'));
});

test('worker.spawn with issue: caps injected issue at 8000 chars', async () => {
  let capturedMessage = '';
  const runner = createFakeRunner(async (_input, message) => {
    capturedMessage = message;
    return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null };
  });
  const seed = makeHelm();
  const hugeBody = 'A'.repeat(10_000);
  const github: GitHub = {
    ...seed.github.github,
    issue: async () => ({
      title: 'Huge issue',
      body: hugeBody,
    }),
  };
  const { helm } = makeHelm({ runner, github });
  const repo = mkTempDir('helm-spawn-issue-cap-');
  const outcome = await helm.spawn(spawnBody(repo, { issue: 295, objective: 'Investigate' }));
  assert.ok(outcome.ok);
  assert.ok(capturedMessage.includes('Issue #295: Huge issue'));
  assert.ok(!capturedMessage.includes('A'.repeat(8001)));
  assert.ok(capturedMessage.includes('A'.repeat(7900)));
});

test('worker.spawn with issue: gracefully handles github.issue error', async () => {
  let capturedMessage = '';
  const runner = createFakeRunner(async (_input, message) => {
    capturedMessage = message;
    return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null };
  });
  const seed = makeHelm();
  const github: GitHub = {
    ...seed.github.github,
    issue: async () => { throw new Error('gh CLI error'); },
  };
  const { helm } = makeHelm({ runner, github });
  const repo = mkTempDir('helm-spawn-issue-err-');
  const outcome = await helm.spawn(spawnBody(repo, { issue: 296, objective: 'Handle error' }));
  assert.ok(outcome.ok);
  assert.ok(capturedMessage.includes('Handle error'));
});

test('a settled worker turn removes node_modules from every top-level package', async () => {
  const runner = createFakeRunner(async (input) => {
    mkdirSync(join(input.worktree, 'node_modules'), { recursive: true });
    mkdirSync(join(input.worktree, 'helm'), { recursive: true });
    writeFileSync(join(input.worktree, 'helm', 'package.json'), '{}');
    mkdirSync(join(input.worktree, 'helm', 'node_modules'), { recursive: true });
    mkdirSync(join(input.worktree, 'app', 'node_modules'), { recursive: true });
    writeFileSync(join(input.worktree, 'app', 'package.json'), '{}');
    return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null };
  });
  const { helm, store } = makeHelm({ runner });
  const outcome = await helm.spawn(spawnBody(mkTempDir('helm-repo-cleanup-')));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const waited = await helm.wait({ workerIds: [outcome.workerId], timeoutMs: 2000 });
  assert.equal(waited.ok, true);
  const row = store.getWorker(outcome.workerId)!;
  assert.equal(row.state, 'succeeded');
  assert.equal(existsSync(join(row.worktree, 'node_modules')), false);
  assert.equal(existsSync(join(row.worktree, 'helm', 'node_modules')), false);
  assert.equal(existsSync(join(row.worktree, 'app', 'node_modules')), false);
});

function installHarness(helmJson: object, gatesOverride?: GateRunner) {
  const repo = mkTempDir('helm-install-repo-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'helm.json'), JSON.stringify(helmJson));
  git('add', '.'); git('commit', '-qm', 'base');
  const installs: Array<{ commands: string[]; keepNodeModules?: boolean }> = [];
  const seen: Array<'dir' | 'symlink' | 'missing'> = [];
  const gates: GateRunner = {
    async run(cwd, checks, _logDir, options) {
      installs.push({ commands: checks.map((check) => check.command), keepNodeModules: options?.keepNodeModules });
      mkdirSync(join(cwd, 'node_modules'), { recursive: true });
      return { passed: true, checks: [] };
    },
    async defaultChecks() { return []; },
  };
  const messages: string[] = [];
  const runner = createFakeRunner(async (input, message) => {
    messages.push(message);
    const path = join(input.worktree, 'node_modules');
    seen.push(!existsSync(path) ? 'missing' : lstatSync(path).isSymbolicLink() ? 'symlink' : 'dir');
    return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null };
  });
  const made = makeHelm({ gates: gatesOverride ?? gates, runner, workerInstall: true });
  made.workspace.resolveSha = async (_repo, ref) => execFileSync('git', ['rev-parse', ref === 'main' ? 'HEAD' : ref], { cwd: repo, encoding: 'utf8' }).trim();
  return { ...made, installs, seen, messages, repo };
}

test('a failed install still runs the turn and prepends the install failure line to the message', async () => {
  const gates: GateRunner = {
    async run() { return { passed: false, checks: [{ name: 'install', command: 'npm ci', exitCode: 1, outputPath: '/tmp/install.log', durationMs: 1 }] }; },
    async defaultChecks() { return []; },
  };
  const { helm, store, seen, messages, repo } = installHarness({ gates: [{ name: 'install', command: 'npm ci' }] }, gates);
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  assert.deepEqual(seen, ['missing']);
  assert.equal(messages.length, 1);
  assert.ok(messages[0]!.startsWith('Dependency install failed: install exited 1; typecheck/tests may not run locally; the gate will run them.\n'), messages[0]);
  assert.ok(messages[0]!.endsWith('BUILD: do the work'));
  assert.equal(store.getWorker(spawned.workerId)?.state, 'succeeded');
});

test('worker turns see a real node_modules from the install gate step and hygiene removes it afterwards', async () => {
  const { helm, installs, seen, repo } = installHarness({ gates: [{ name: 'install', command: 'npm ci --no-audit --no-fund' }, { name: 'test', command: 'npm test' }] });
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  assert.deepEqual(seen, ['dir']);
  assert.deepEqual(installs, [{ commands: ['npm ci --no-audit --no-fund'], keepNodeModules: true }]);
  assert.equal(existsSync(join(spawned.worktree, 'node_modules')), false);
  assert.equal((await helm.steer({ workerId: spawned.workerId, message: 'again' })).ok, true);
  await helm.settle(spawned.workerId);
  assert.deepEqual(seen, ['dir', 'dir']);
  assert.equal(installs.length, 2);
  assert.equal(existsSync(join(spawned.worktree, 'node_modules')), false);
});

test('stop during the pre-turn install aborts it, never runs the turn, and settles stopped', async () => {
  let installing!: () => void;
  const started = new Promise<void>((resolve) => { installing = resolve; });
  let signal: AbortSignal | undefined;
  const gates: GateRunner = {
    async run(_cwd, _checks, _logDir, options) {
      signal = options?.signal;
      installing();
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ passed: false, checks: [] })));
    },
    async defaultChecks() { return []; },
  };
  const { helm, store, seen, repo } = installHarness({ gates: [{ name: 'install', command: 'npm ci' }] }, gates);
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await started;
  const stopped = await helm.stop({ workerId: spawned.workerId });
  assert.deepEqual(stopped, { ok: true, state: 'stopped' });
  assert.equal(signal?.aborted, true);
  assert.deepEqual(seen, []);
  assert.equal(store.getWorker(spawned.workerId)?.state, 'stopped');
});

test('workerInstall false in helm.json skips the worker install', async () => {
  const { helm, installs, seen, repo } = installHarness({ gates: [{ name: 'install', command: 'npm ci' }], workerInstall: false });
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  assert.deepEqual(seen, ['missing']);
  assert.deepEqual(installs, []);
});

test('gate node_modules cleanup failures are hygiene warnings', async () => {
  let cleanupError: ((message: string) => void) | undefined;
  const gates: GateRunner = {
    async run(_cwd, _checks, _logDir, options) {
      cleanupError = options?.onNodeModulesError;
      cleanupError?.('permission denied');
      return { passed: true, checks: [] };
    },
    async defaultChecks() { return [{ name: 'test', command: 'npm test' }]; },
  };
  const { helm, store } = makeHelm({ gates });
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-gate-cleanup-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  const result = await helm.gate({ workerId: spawned.workerId, checks: [{ name: 'test', command: 'npm test' }] });
  assert.equal(result.ok, true);
  assert.ok(cleanupError);
  assert.ok(store.listEvents(spawned.workerId).some((event) => event.kind === 'hygiene.warning' && event.data.message === 'permission denied'));
  assert.equal(store.listEvents(spawned.workerId).some((event) => event.kind === 'error' && event.data.message === 'permission denied'), false);
});

test('gate refreshes the current base ref for policy and records its resolved sha', async () => {
  let policyRef: string | undefined;
  const gates: GateRunner = {
    async run(_cwd, checks) {
      assert.deepEqual(checks, [{ name: 'current-base', command: 'echo current-base' }]);
      return { passed: true, checks: [] };
    },
    async defaultChecks(_repo, sha) {
      policyRef = sha;
      return [{ name: 'current-base', command: 'echo current-base' }];
    },
  };
  const { helm, store, fetched } = makeHelm({ gates });
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-gate-current-base-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  const result = await helm.gate({ workerId: spawned.workerId });
  assert.equal(result.ok, true);
  assert.deepEqual(fetched, [store.getWorker(spawned.workerId)?.repo]);
  assert.equal(policyRef, 'base-sha-refs/helm/base/main');
  assert.equal(store.listEvents(spawned.workerId).find((event) => event.kind === 'gate')?.data.baseSha, 'base-sha-refs/helm/base/main');
});

test('an infrastructure gate failure is retried once instead of steering the worker', async () => {
  let attempts = 0;
  const gates: GateRunner = {
    async run(_cwd, _checks, logDir) {
      attempts += 1;
      const outputPath = join(logDir, 'test.log');
      mkdirSync(logDir, { recursive: true });
      if (attempts === 1) {
        writeFileSync(outputPath, 'spawnSync git EAGAIN: resource temporarily unavailable');
        return { passed: false, checks: [{ name: 'test', command: 'npm test', exitCode: 1, outputPath, durationMs: 1 }] };
      }
      writeFileSync(outputPath, 'all clear');
      return { passed: true, checks: [{ name: 'test', command: 'npm test', exitCode: 0, outputPath, durationMs: 1 }] };
    },
    async defaultChecks() { return [{ name: 'test', command: 'npm test' }]; },
  };
  const { helm, store } = makeHelm({ gates });
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-gate-infra-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  const result = await helm.gate({ workerId: spawned.workerId, checks: [{ name: 'test', command: 'npm test' }] });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.passed, true);
  assert.equal(attempts, 2);
  assert.equal(store.listEvents(spawned.workerId).filter((event) => event.kind === 'gate.infra').length, 1);
  assert.equal(store.listGates(spawned.workerId).at(-1)?.passed, true);
});

test('gate sandbox fallback is recorded as an event for Discord milestones', async () => {
  const gates: GateRunner = {
    async run(_cwd, _checks, _logDir, options) {
      options?.onUnsandboxed?.('sandbox-exec failed to apply profile');
      return { passed: true, checks: [] };
    },
    async defaultChecks() { return [{ name: 'test', command: 'npm test' }]; },
  };
  const { helm, store } = makeHelm({ gates });
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-gate-unsandboxed-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  const result = await helm.gate({ workerId: spawned.workerId, checks: [{ name: 'test', command: 'npm test' }] });
  assert.equal(result.ok, true);
  assert.ok(store.listEvents(spawned.workerId).some((event) => event.kind === 'gate.unsandboxed' && event.data.reason === 'sandbox-exec failed to apply profile'));
});

test('gate refusal is recorded when the runner rejects the worktree', async () => {
  const gates: GateRunner = {
    async run(_cwd, _checks, _logDir, options) {
      options?.onRefused?.('worktree contains a symlink escaping the worktree: /tmp/worktree/node_modules');
      return { passed: false, checks: [] };
    },
    async defaultChecks() { return [{ name: 'test', command: 'npm test' }]; },
  };
  const { helm, store } = makeHelm({ gates });
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-gate-refused-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  const result = await helm.gate({ workerId: spawned.workerId, checks: [{ name: 'test', command: 'npm test' }] });
  assert.equal(result.ok, true);
  assert.ok(store.listEvents(spawned.workerId).some((event) => event.kind === 'gate.refused' && event.data.reason === 'worktree contains a symlink escaping the worktree: /tmp/worktree/node_modules'));
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

test('spawn queues once active workers reach maxWorkers', async () => {
  const { runner } = createControllableRunner();
  const { helm } = makeHelm({ config: { maxWorkers: 1 }, runner });
  const repo = mkTempDir('helm-repo-');
  const first = await helm.spawn(spawnBody(repo));
  assert.equal(first.ok, true);
  const second = await helm.spawn(spawnBody(repo));
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.queued, true);
});

test('one daemon Helm instance admits two repos through one queue while retaining their budgets and supervisors', async () => {
  const control = createControllableRunner();
  const { helm, store } = makeHelm({ config: { maxWorkers: 1 }, runner: control.runner });
  const alphaRepo = mkTempDir('helm-alpha-'), betaRepo = mkTempDir('helm-beta-');
  const alphaProject = basename(alphaRepo), betaProject = basename(betaRepo);
  const [alphaSupervisor, betaSupervisor] = await Promise.all([
    helm.supervisorRegister({ project: alphaProject, repo: alphaRepo, host: 'herdr', label: 'alpha' }),
    helm.supervisorRegister({ project: betaProject, repo: betaRepo, host: 'tmux', label: 'beta' }),
  ]);
  assert.ok(alphaSupervisor.ok && betaSupervisor.ok);

  const alpha = await helm.spawn(spawnBody(alphaRepo));
  const beta = await helm.spawn(spawnBody(betaRepo));
  assert.ok(alpha.ok && beta.ok);
  if (!alpha.ok || !beta.ok) return;
  assert.equal(beta.queued, true);
  assert.equal(budgetForWorker(store, alpha.workerId)?.project, alphaProject);
  assert.equal(budgetForWorker(store, beta.workerId)?.project, betaProject);
  assert.notEqual(budgetForWorker(store, alpha.workerId)?.id, budgetForWorker(store, beta.workerId)?.id);
  const registered = await helm.supervisorList();
  assert.ok(registered.ok);
  if (!registered.ok) return;
  assert.deepEqual(registered.supervisors.map((row) => row.project), [alphaProject, betaProject].sort());
  assert.deepEqual((await helm.capacity.status()).queue.map((job) => job.workerId), [beta.workerId]);

  const succeeded: WorkerRunOutcome = { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null };
  control.resolveNext(succeeded); await helm.settle(alpha.workerId);
  await helm.capacity.tick();
  assert.equal(store.getWorker(beta.workerId)?.state, 'running');
  control.resolveNext(succeeded); await helm.settle(beta.workerId);
});

test('spawn refuses when free disk is below half the hygiene threshold', async () => {
  const { helm } = makeHelm({ statfs: async () => ({ bavail: 7, bsize: 1024 ** 3 }) });
  const outcome = await helm.spawn(spawnBody(mkTempDir('helm-repo-')));
  assert.deepEqual(outcome, { ok: false, reason: 'disk low' });
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
  assert.equal(oks.length, 2, 'both concurrent spawns are accepted, with one queued under maxWorkers=1');
  assert.equal([first, second].filter((o) => o.ok && o.queued).length, 1);
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

test('spawn refuses an exhausted project budget while another project still spawns', async () => {
  const { helm } = makeHelm({ settings: { budgets: { defaultCapUsd: 0.01 } } });
  const firstRepo = mkTempDir('helm-repo-');
  const otherRepo = mkTempDir('helm-repo-');
  const first = await helm.spawn(spawnBody(firstRepo));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await helm.settle(first.workerId);

  const refused = await helm.spawn(spawnBody(firstRepo));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /budget exhausted/);

  const other = await helm.spawn(spawnBody(otherRepo));
  assert.equal(other.ok, true);
  if (other.ok) await helm.settle(other.workerId);
});

test('implicit project budget uses settings defaultCapUsd', async () => {
  const { helm } = makeHelm({ settings: { budgets: { defaultCapUsd: 3.25 } } });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  const status = await helm.runStatus();
  assert.equal(status.ok, true);
  if (status.ok) assert.equal(status.projects[0]?.capUsd, 3.25);
});

test('steer refuses an exhausted project budget', async () => {
  const { helm } = makeHelm({ settings: { budgets: { defaultCapUsd: 0.01 } } });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);

  const refused = await helm.steer({ workerId: spawned.workerId, message: 'continue' });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /budget exhausted/);
});

test('inbox.reply refuses an exhausted project budget', async () => {
  const { helm, store } = makeHelm({ runner: asksOnce(), settings: { budgets: { defaultCapUsd: 0.01 } } });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  const ask = store.listEvents(spawned.workerId).find((event) => event.kind === 'ask');
  assert.ok(ask?.data.inboxId);

  const refused = await helm.inboxReply({ id: ask?.data.inboxId as string, answer: 'use the safe path', by: 'test' });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /budget exhausted/);
});

test('budget spend.warning fires once at 80% and includes project and label', async () => {
  const warningRunner = createFakeRunner(async (input, _message, hooks) => {
    for (const costUsd of [0.016, 0.001]) hooks.onUsage({ model: input.model, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
    return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null };
  });
  const { helm, store } = makeHelm({ runner: warningRunner, settings: { budgets: { defaultCapUsd: 0.02 } } });
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);

  const warnings = store.listEvents(spawned.workerId).filter((event) => event.kind === 'spend.warning');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.data.project, store.getWorker(spawned.workerId)?.repoSlug);
  assert.match(String(warnings[0]?.data.label), /^auto-\d{4}-\d{2}-\d{2}$/);
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

test('modelFamily returns the model vendor and strips lane and provider prefixes', () => {
  assert.equal(modelFamily('opencode-go/qwen3.8-flash'), 'alibaba');
  assert.equal(modelFamily('opencode-go/glm-5.3-flash'), 'zhipu');
  assert.equal(modelFamily('opencode-go/kimi-k3'), 'moonshot');
  assert.equal(modelFamily('opencode-go/deepseek-v4'), 'deepseek');
  assert.equal(modelFamily('google/gemini-3.8-flash'), 'google');
  assert.equal(modelFamily('openrouter/nvidia/nemotron-3-ultra:free'), 'nvidia');
  assert.equal(modelFamily('openai-codex/gpt-6-luna'), 'openai');
  assert.equal(modelFamily('anthropic/claude-sonnet-5'), 'anthropic');
  assert.equal(modelFamily('claude/sonnet:high'), 'anthropic');
  assert.equal(modelFamily('codex/gpt-6-luna:high'), 'openai');
  assert.equal(modelFamily('acme/reviewer'), 'reviewer');
});

test('modelFamily groups models by vendor', () => {
  assert.equal(modelFamily('claude-sonnet-5'), modelFamily('claude-opus-5'));
  assert.equal(modelFamily('codex/gpt-6-luna'), modelFamily('codex/gpt-6.1-sol'));
  assert.notEqual(modelFamily('claude/sonnet'), modelFamily('codex/gpt-6-luna'));
  assert.equal(modelFamily('openrouter/qwen/qwen3.7-plus'), modelFamily('opencode-go/qwen3.8-flash'));
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
  if (!family.ok) assert.match(family.reason, /family 'alibaba'/);
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

test('gate.run and gate.baseline refuse while a worker turn is running', async () => {
  const controllable = createControllableRunner();
  const { helm } = makeHelm({ runner: controllable.runner });
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-repo-running-gate-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;

  const gate = await helm.gate({ workerId: spawned.workerId });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.reason, 'worker turn running; wait');
  const baseline = await helm.baseline({ workerId: spawned.workerId });
  assert.equal(baseline.ok, false);
  if (!baseline.ok) assert.equal(baseline.reason, 'worker turn running; wait');

  controllable.resolveNext({ result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null });
  await helm.settle(spawned.workerId);
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

test('pr.open updates an existing PR row after pushing and only edits passed metadata', async () => {
  const { helm, store, pushed, github } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  const worker = store.getWorker(spawned.workerId);
  assert.ok(worker?.head);
  store.insertPr({ number: 230, workerId: spawned.workerId, url: 'https://example.invalid/230', head: 'old-head', createdAt: new Date().toISOString() });
  github.setPrStatus(230, { head: worker.head });
  assert.equal((await helm.gate({ workerId: spawned.workerId })).ok, true);

  const updated = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.deepEqual(updated, { ok: true, number: 230, url: 'https://example.invalid/230', head: worker.head, updated: true });
  assert.equal(pushed.length, 1);
  assert.equal(store.getPrByWorker(spawned.workerId)?.head, worker.head);
  assert.deepEqual(github.updates, []);

  const edited = await helm.prOpen({ workerId: spawned.workerId, title: 'Updated title', body: 'Updated body', draft: true });
  assert.equal(edited.ok, true);
  assert.deepEqual(github.updates, [{ repoSlug: worker.repoSlug, number: 230, input: { title: 'Updated title', body: 'Updated body' } }]);
});

test('pr.open refuses an existing PR before pushing when its head has no passing gate', async () => {
  const { helm, store, pushed } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  store.insertPr({ number: 230, workerId: spawned.workerId, url: 'https://example.invalid/230', head: 'old-head', createdAt: new Date().toISOString() });

  const refused = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.equal(refused.ok, false);
  assert.equal(pushed.length, 0);
});

test('pr.open records an existing GitHub PR when the local row is missing', async () => {
  const { helm, store, github } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  const worker = store.getWorker(spawned.workerId);
  assert.ok(worker?.head);
  github.setExistingPr(worker.branch, { number: 230, url: 'https://example.invalid/230' });
  assert.equal((await helm.gate({ workerId: spawned.workerId })).ok, true);

  const opened = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.equal(opened.ok, true);
  assert.equal(store.getPrByWorker(spawned.workerId)?.head, worker.head);
});

test('pr.open refuses closed or merged existing PRs before pushing', async () => {
  for (const state of ['closed', 'merged'] as const) {
    const { helm, store, pushed, github } = makeHelm();
    const repo = mkTempDir('helm-repo-');
    const spawned = await helm.spawn(spawnBody(repo));
    assert.equal(spawned.ok, true);
    if (!spawned.ok) continue;
    await helm.settle(spawned.workerId);
    store.insertPr({ number: 230, workerId: spawned.workerId, url: 'https://example.invalid/230', head: 'old-head', createdAt: new Date().toISOString() });
    github.setPrStatus(230, { state });
    assert.equal((await helm.gate({ workerId: spawned.workerId })).ok, true);

    const refused = await helm.prOpen({ workerId: spawned.workerId, draft: true });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, new RegExp(`#230.*${state}`));
    assert.equal(pushed.length, 0);
  }
});

test('pr.open uses the default branch, worker prBase, and explicit base in order of precedence', async () => {
  const { helm, store, github } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const first = await helm.spawn(spawnBody(repo, { baseRef: 'release' }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await helm.settle(first.workerId);
  assert.equal((await helm.gate({ workerId: first.workerId })).ok, true);
  assert.equal((await helm.prOpen({ workerId: first.workerId, draft: true })).ok, true);

  const second = await helm.spawn(spawnBody(repo, { baseRef: 'release-2' }));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await helm.settle(second.workerId);
  store.setMeta(second.workerId, { prBase: 'develop' });
  assert.equal((await helm.gate({ workerId: second.workerId })).ok, true);
  assert.equal((await helm.prOpen({ workerId: second.workerId, draft: true })).ok, true);

  const third = await helm.spawn(spawnBody(repo, { baseRef: 'release-3' }));
  assert.equal(third.ok, true);
  if (!third.ok) return;
  await helm.settle(third.workerId);
  assert.equal((await helm.gate({ workerId: third.workerId })).ok, true);
  assert.equal((await helm.prOpen({ workerId: third.workerId, base: 'hotfix', draft: true })).ok, true);
  assert.deepEqual(github.opened.map((pr) => pr.base), ['main', 'develop', 'hotfix']);
});

test('merge.enqueue after an existing PR update uses the updated head', async () => {
  const { helm, store, github } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  store.insertPr({ number: 230, workerId: spawned.workerId, url: 'https://example.invalid/230', head: 'old-head', createdAt: new Date().toISOString() });
  github.setPrStatus(230, { head: store.getWorker(spawned.workerId)?.head ?? 'unknown' });
  assert.equal((await helm.gate({ workerId: spawned.workerId })).ok, true);
  const opened = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  github.setPrStatus(230, { head: opened.head });
  assert.equal((await helm.queue.enqueue({ number: 230 })).ok, true);
  await helm.queue.tick();
  const queued = helm.queue.queue({ project: store.getWorker(spawned.workerId)?.repoSlug ?? '' });
  assert.equal(queued.ok, true);
  if (queued.ok) assert.doesNotMatch(queued.items[0]?.reason ?? '', /head changed/);
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

test('steer refuses a worker whose worktree was removed and explains how to recover', async () => {
  const { helm, store } = makeHelm();
  const repo = mkTempDir('helm-repo-');
  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  store.appendEvent(spawned.workerId, 'worktree.removed');
  assert.deepEqual(await helm.steer({ workerId: spawned.workerId, message: 'continue' }), { ok: false, reason: 'worktree removed; respawn' });
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
  const ids = await helm.markInterruptedOnStart();
  assert.deepEqual(ids, [spawned.workerId]);
  assert.equal(store.getWorker(spawned.workerId)?.state, 'interrupted');
});

test('startup deploy recovery does not wait for a remote checkout', async () => {
  const { helm, store, workspace } = makeHelm();
  workspace.clone = async () => await new Promise<void>(() => {});
  store.sql.prepare('INSERT INTO deploys (id, project, target, kind, env, sha, state, bootId, reason, url, deploymentId, previousId, smoke, tapId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('d-startup', 'owner/missing', 'prod', 'vercel', '{}', 'a'.repeat(40), 'deploying', 'boot-previous', null, null, null, null, '{}', null, new Date().toISOString());
  const result = await Promise.race([
    helm.markInterruptedOnStart('boot-previous'),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('startup recovery blocked')), 250)),
  ]);
  assert.deepEqual(result, []);
  assert.equal((store.sql.prepare('SELECT state FROM deploys WHERE id = ?').get('d-startup') as { state: string }).state, 'deploying');
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

test('a turn killed before it returns still leaves a session file to resume from', async () => {
  // The crash this guards is the one the daemon actually suffers: the process dies mid-turn, so
  // the runner never returns and the end-of-turn write never happens. If the session file is
  // only recorded from the outcome, `steer` resumes with `sessionFile: null` and Pi starts a
  // brand-new session with none of the worker's context.
  const sessionFile = '/tmp/helm-crash-test/session.jsonl';
  const runner = createFakeRunner(async (_input, _message, hooks) => {
    hooks.onSession(sessionFile);
    throw new Error('daemon killed mid-turn');
  });
  const { helm, store } = makeHelm({ runner });
  const repo = mkTempDir('helm-repo-');

  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);

  assert.equal(store.getWorker(spawned.workerId)?.sessionFile, sessionFile);
});

test('the end-of-turn write does not reinstate a session file that predates onSession', async () => {
  // `row` is read before the turn starts, so it still carries the old value. A runner that
  // reports a session but returns no sessionFile of its own must not be rolled back to it.
  const sessionFile = '/tmp/helm-late-write/session.jsonl';
  const runner = createFakeRunner(async (input, _message, hooks) => {
    hooks.onSession(sessionFile);
    hooks.onUsage({ model: input.model, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
    return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null };
  });
  const { helm, store } = makeHelm({ runner });
  const repo = mkTempDir('helm-repo-');

  const spawned = await helm.spawn(spawnBody(repo));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  await helm.settle(spawned.workerId);

  assert.equal(store.getWorker(spawned.workerId)?.sessionFile, sessionFile);
});

// ---------- worker.wait ----------

const settledOutcome: WorkerRunOutcome = {
  result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null,
};

test('worker.wait blocks while the worker runs and returns it the moment it settles', async () => {
  const { runner, resolveNext } = createControllableRunner();
  const { helm } = makeHelm({ runner, waitPollMs: 5 });
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-repo-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;

  let resolved = false;
  const waiting = helm.wait({ workerIds: [spawned.workerId], timeoutMs: 5000 }).then((r) => { resolved = true; return r; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(resolved, false, 'wait must not return while the worker is still running');

  resolveNext(settledOutcome);
  const outcome = await waiting;
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.timedOut, false);
  assert.deepEqual(outcome.pending, []);
  assert.equal(outcome.settled.length, 1);
  assert.equal(outcome.settled[0]?.workerId, spawned.workerId);
  assert.equal(outcome.settled[0]?.state, 'succeeded');
  assert.equal(outcome.settled[0]?.result?.summary, 'done');
});

test('worker.wait times out with the worker still pending and reports how long it waited', async () => {
  const { runner, resolveNext } = createControllableRunner();
  const { helm } = makeHelm({ runner, waitPollMs: 5 });
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-repo-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;

  const outcome = await helm.wait({ workerIds: [spawned.workerId], timeoutMs: 40 });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.timedOut, true);
  assert.deepEqual(outcome.settled, []);
  assert.deepEqual(outcome.pending, [spawned.workerId]);
  assert.ok(outcome.waitedMs >= 40);

  resolveNext(settledOutcome);
  await helm.settle(spawned.workerId);
});

test('worker.wait returns as soon as any one of several workers settles, naming the rest as pending', async () => {
  const { runner, resolveNext } = createControllableRunner();
  const { helm } = makeHelm({ runner, waitPollMs: 5 });
  const first = await helm.spawn(spawnBody(mkTempDir('helm-repo-')));
  const second = await helm.spawn(spawnBody(mkTempDir('helm-repo-')));
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;

  const waiting = helm.wait({ workerIds: [first.workerId, second.workerId], timeoutMs: 5000 });
  resolveNext(settledOutcome); // the oldest pending turn is the first worker's
  const outcome = await waiting;
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.settled.map((s) => s.workerId), [first.workerId]);
  assert.deepEqual(outcome.pending, [second.workerId]);

  resolveNext(settledOutcome);
  await helm.settle(second.workerId);
});

test('worker.wait refuses an unknown worker id instead of waiting on it', async () => {
  const { helm } = makeHelm({ waitPollMs: 5 });
  const outcome = await helm.wait({ workerIds: ['w-nope'], timeoutMs: 1000 });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /worker not found: w-nope/);
});

test('worker.wait sees an interrupted worker as settled: that is the state the orchestrator must act on', async () => {
  const { runner } = createControllableRunner();
  const { helm, store } = makeHelm({ runner, waitPollMs: 5 });
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-repo-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) return;
  store.updateWorker(spawned.workerId, { state: 'interrupted' });

  const outcome = await helm.wait({ workerIds: [spawned.workerId], timeoutMs: 1000 });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.settled[0]?.state, 'interrupted');
});

// ---------- pr.merge guards ----------

async function openedPr(helm: Helm, github: ReturnType<typeof createFakeGitHub>) {
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-repo-')));
  assert.equal(spawned.ok, true);
  if (!spawned.ok) throw new Error('spawn failed');
  await helm.settle(spawned.workerId);
  const gate = await helm.gate({ workerId: spawned.workerId });
  assert.equal(gate.ok, true);
  const opened = await helm.prOpen({ workerId: spawned.workerId, draft: true });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error('prOpen failed');
  return { number: opened.number, head: opened.head, github };
}

test('pr.merge refuses a draft with a message that says what to do', async () => {
  const { helm, github } = makeHelm();
  const pr = await openedPr(helm, github);
  github.setPrStatus(pr.number, { head: pr.head, draft: true, mergeable: true, checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }] });
  const outcome = await helm.prMerge({ number: pr.number, expectedHead: pr.head });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /draft; mark it ready/);
  assert.equal(github.merged.length, 0);
});

test('pr.merge tells "still running" apart from "failed", and treats neutral and skipped as passing', async () => {
  const { helm, github } = makeHelm();
  const pr = await openedPr(helm, github);

  github.setPrStatus(pr.number, { head: pr.head, mergeable: true, checks: [{ name: 'ci', status: 'in_progress', conclusion: null }] });
  const running = await helm.prMerge({ number: pr.number, expectedHead: pr.head });
  assert.equal(running.ok, false);
  if (!running.ok) assert.match(running.reason, /"ci" has not finished \(in_progress\)/);

  github.setPrStatus(pr.number, { head: pr.head, mergeable: null, checks: [] });
  const unknown = await helm.prMerge({ number: pr.number, expectedHead: pr.head });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /not finished computing mergeability/);

  github.setPrStatus(pr.number, { head: pr.head, mergeable: true, checks: [
    { name: 'ci', status: 'completed', conclusion: 'success' },
    { name: 'optional', status: 'completed', conclusion: 'neutral' },
    { name: 'docs-only', status: 'completed', conclusion: 'skipped' },
  ] });
  const merged = await helm.prMerge({ number: pr.number, expectedHead: pr.head });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(github.merged.length, 1);
});


test('automatic routing reaches the runner, persists, and survives steer across all task tiers', async () => {
  const seen: string[] = [];
  const delegate = succeeded();
  const { helm, store } = makeHelm({ runner: { run: async (input, message, hooks) => {
    seen.push(input.model);
    return delegate.run(input, message, hooks);
  } } });
  const registry = createToolRegistry(helm);
  const repo = mkTempDir('helm-routing-');
  for (const [difficulty, expected] of [
    [undefined, 'codex/gpt-5.6-terra:high'],
    ['normal', 'codex/gpt-5.6-terra:high'],
    ['easy', 'google/gemini-3.8-flash'],
    ['super-easy', 'openrouter/qwen/qwen3.8-flash'],
  ] as const) {
    const outcome = await registry.call('worker.spawn', { repo, objective: 'task', ...(difficulty ? { difficulty } : {}) });
    assert.equal(outcome.ok, true);
    const row = store.listWorkers().at(-1)!;
    await helm.settle(row.workerId);
    assert.equal(row.model, expected);
    assert.equal(seen.at(-1), expected);
    assert.equal(store.listEvents(row.workerId).find((e) => e.kind === 'spawned')?.data.model, expected);
    assert.equal((await helm.steer({ workerId: row.workerId, message: 'continue' })).ok, true);
    await helm.settle(row.workerId);
    assert.equal(seen.at(-1), expected);
    await helm.gate({ workerId: row.workerId });
    assert.equal((await helm.prOpen({ workerId: row.workerId, draft: true })).ok, true);
    const review = await helm.reviewRequest({ workerId: row.workerId, model: 'claude/sonnet:high', allowSameFamily: false });
    assert.ok(review.ok);
    await helm.settle(review.reviewWorkerId);
    assert.equal(store.getWorker(review.reviewWorkerId)?.model, 'claude/sonnet:high');
  }
});

test('explicit models override difficulty; a Gemini builder gets an independent default reviewer', async () => {
  const { helm, store } = makeHelm();
  const repo = mkTempDir('helm-routing-');
  const build = await helm.spawn(spawnBody(repo, { difficulty: 'super-easy', model: 'google/gemini-3.8-flash' }));
  assert.ok(build.ok);
  await helm.settle(build.workerId);
  assert.equal(store.getWorker(build.workerId)?.model, 'google/gemini-3.8-flash');
  await helm.gate({ workerId: build.workerId });
  await helm.prOpen({ workerId: build.workerId, draft: true });
  const review = await helm.reviewRequest({ workerId: build.workerId, model: 'codex/gpt-6-luna:high', allowSameFamily: false });
  assert.ok(review.ok);
  await helm.settle(review.reviewWorkerId);
  assert.equal(store.getWorker(review.reviewWorkerId)?.model, 'codex/gpt-6-luna:high');
  const direct = await helm.spawn(spawnBody(repo, { model: undefined, role: 'reviewer', difficulty: 'super-easy' }));
  assert.ok(direct.ok);
  await helm.settle(direct.workerId);
    assert.equal(store.getWorker(direct.workerId)?.model, 'openrouter/qwen/qwen3.8-flash');
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test('drain blocks new mutations across registries but lets an accepted worker finish its commit', async () => {
  const entered = deferred(), commit = deferred();
  const { helm, store, workspace } = makeHelm();
  const original = workspace.commitAll;
  Object.assign(workspace, { commitAll: async (...args: Parameters<Workspace['commitAll']>) => {
    entered.release(); await commit.promise; return original(...args);
  } });
  const first = createToolRegistry(helm), second = createToolRegistry(helm);
  const repo = mkTempDir('helm-drain-');
  assert.ok((await first.call('worker.spawn', { repo, objective: 'finish this', model: 'acme/m' })).ok);
  const worker = store.listWorkers()[0]!;
  await entered.promise;
  const drain = await second.call('daemon.control', { action: 'drain' });
  assert.ok(drain.ok);
  assert.equal(helm.lifecycle.status().phase, 'draining');
  assert.deepEqual(helm.lifecycle.status().blockers, [`worker:${worker.workerId}`]);
  for (const [name, input] of [
    ['worker.spawn', { repo, objective: 'new' }],
    ['worker.steer', { workerId: worker.workerId, message: 'new turn' }],
    ['review.request', { workerId: worker.workerId }],
    ['gate.run', { workerId: worker.workerId }],
    ['pr.open', { workerId: worker.workerId }],
    ['pr.merge', { number: 1, expectedHead: 'a'.repeat(40) }],
  ] as const) {
    const outcome = await first.call(name, input);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.reason, /draining/);
  }
  assert.ok((await second.call('run.status', {})).ok);
  assert.ok((await second.call('worker.inspect', { workerId: worker.workerId })).ok);
  assert.equal((await second.call('daemon.control', { action: 'shutdown' })).ok, false);
  commit.release();
  await helm.settle(worker.workerId);
  assert.equal(store.getWorker(worker.workerId)?.state, 'succeeded');
  assert.equal(helm.lifecycle.status().phase, 'ready');
  assert.ok((await first.call('daemon.control', { action: 'resume' })).ok);
  assert.ok((await second.call('worker.steer', { workerId: worker.workerId, message: 'continue' })).ok);
  await helm.settle(worker.workerId);
});

test('drain tracks a gate after the builder settled and counts accepted requests before their first await', async () => {
  const entered = deferred(), gate = deferred();
  const real = createFakeGates();
  const { helm, store } = makeHelm({ gates: { ...real, run: async (...args) => {
    entered.release(); await gate.promise; return real.run(...args);
  } } });
  const build = await helm.spawn(spawnBody(mkTempDir('helm-drain-')));
  assert.ok(build.ok);
  await helm.settle(build.workerId);
  const registry = createToolRegistry(helm);
  const pending = registry.call('gate.run', { workerId: build.workerId });
  await registry.call('daemon.control', { action: 'drain' });
  assert.deepEqual(helm.lifecycle.status().blockers, ['gate.run']);
  await entered.promise;
  assert.equal((await registry.call('daemon.control', { action: 'shutdown' })).ok, false);
  gate.release();
  assert.ok((await pending).ok);
  assert.ok(store.listGates(build.workerId).some((g) => g.passed));
  assert.equal(helm.lifecycle.status().phase, 'ready');
});

test('drain waits for the review callback even after the reviewer state is succeeded', async () => {
  const entered = deferred(), comment = deferred();
  const gh = createFakeGitHub().github;
  const { helm, store } = makeHelm({ github: { ...gh, postComment: async (...args) => {
    entered.release(); await comment.promise; return gh.postComment(...args);
  } } });
  const build = await helm.spawn(spawnBody(mkTempDir('helm-drain-')));
  assert.ok(build.ok);
  await helm.settle(build.workerId);
  await helm.gate({ workerId: build.workerId });
  await helm.prOpen({ workerId: build.workerId, draft: true });
  const review = await helm.reviewRequest({ workerId: build.workerId, model: 'google/gemini-3.8-flash', allowSameFamily: false });
  assert.ok(review.ok);
  await entered.promise;
  assert.equal(store.getWorker(review.reviewWorkerId)?.state, 'succeeded');
  await helm.lifecycle.control({ action: 'drain' });
  assert.deepEqual(helm.lifecycle.status().blockers, [`worker:${review.reviewWorkerId}`]);
  comment.release();
  await helm.settle(review.reviewWorkerId);
  assert.equal(helm.lifecycle.status().phase, 'ready');
  assert.ok(store.listEvents(review.reviewWorkerId).some((e) => e.kind === 'review.posted'));
});

test('constructing and closing Helm leaves no capacity timer or child process resource', { timeout: 0 }, async () => {
  const before = process.getActiveResourcesInfo();
  const { helm } = makeHelm();
  await helm.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const remaining = before.slice();
  const extra = process.getActiveResourcesInfo().filter((resource) => {
    const index = remaining.indexOf(resource);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
  assert.deepEqual(extra.filter((resource) => resource === 'Timeout' || resource === 'ChildProcess'), [], `new active resources: ${extra.join(', ')}`);
});

test('pr.open infers a missing issue from the new or updated PR body', async () => {
  const { helm, store } = makeHelm();
  const spawned = await helm.spawn(spawnBody(mkTempDir('helm-issue-repo-')));
  assert.equal(spawned.ok, true); if (!spawned.ok) return;
  await helm.settle(spawned.workerId);
  await helm.gate({ workerId: spawned.workerId });
  assert.equal((await helm.prOpen({ workerId: spawned.workerId, body: 'Closes #279', draft: false })).ok, true);
  assert.equal(store.getMeta(spawned.workerId)?.issue, 279);
  store.setMeta(spawned.workerId, { issue: null });
  assert.equal((await helm.prOpen({ workerId: spawned.workerId, body: 'Fixes #280', draft: false })).ok, true);
  assert.equal(store.getMeta(spawned.workerId)?.issue, 280);
  assert.equal((await helm.prOpen({ workerId: spawned.workerId, body: 'Resolves #281', draft: false })).ok, true);
  assert.equal(store.getMeta(spawned.workerId)?.issue, 280);
});
