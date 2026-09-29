import assert from 'node:assert/strict';
import test from 'node:test';
import type { Jev } from '../src/jev.js';
import { Helm } from '../src/helm.js';
import { createReview } from '../src/review.js';
import { createSupervisor } from '../src/supervise.js';
import { openStore } from '../src/store.js';
import { loadSettings } from '../src/settings.js';
import type { GateRunner, GitHub, HelmConfig, PrStatus, WorkerRow, WorkerRunner, Workspace } from '../src/types.js';

const head1 = 'a'.repeat(40);
const head2 = 'b'.repeat(40);

function setup(options: { jev?: Jev; body?: string; issueNumber?: number; patchIds?: Record<string, string> } = {}) {
  const store = openStore(':memory:');
  const now = new Date().toISOString();
  const worker: WorkerRow = { workerId: 'w-review', repo: '/repo', repoSlug: 'owner/repo', role: 'builder', model: 'codex/gpt-5.6-luna:high', objective: 'work', acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'base', branch: 'helm/review', worktree: '/repo', state: 'succeeded', head: head1, sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: now, updatedAt: now };
  store.insertWorker(worker);
  store.insertPr({ number: 1, workerId: worker.workerId, url: 'https://github.com/owner/repo/pull/1', head: head1, createdAt: now });
  let currentHead = head1;
  let merges = 0;
  const workspace = { patchId: async (_repo: string, _base: string, head: string) => options.patchIds?.[head] ?? head } as Workspace;
  const github = {
    async openPr() { return { number: 1, url: worker.repoSlug }; },
    async prStatus(_repo: string, number: number): Promise<PrStatus> { return { number, state: 'open', head: currentHead, mergeable: true, draft: false, checks: [], reviews: [], url: worker.repoSlug }; },
    async comment() { return { body: options.body ?? 'APPROVE: ok', issueNumber: options.issueNumber ?? 1 }; },
    async postComment() {},
    async merge() { merges += 1; },
  } as unknown as GitHub;
  const jev = options.jev ?? { shadow: false, async ask() { return { ok: true as const, answers: { approve: { noul: 1 } } }; } };
  const review = createReview({ store, github, workspace, jev, settings: loadSettings('/missing-review-settings') });
  const config: HelmConfig = { home: '/tmp/helm-review', spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 1000 };
  const gates: GateRunner = { async run() { return { passed: true, checks: [] }; }, async defaultChecks() { return []; } };
  const runner: WorkerRunner = { async run() { return { result: null, rawText: '', sessionFile: null }; } };
  const helm = new Helm({ config, store, workspace, gates, github, runner, prompts: { builder: () => '', reviewer: () => '' }, review });
  return { store, helm, review, github, setHead: (head: string) => { currentHead = head; }, merged: () => merges };
}

test('pr.merge refuses without an approving review at the expected head', async () => {
  const d = setup();
  try { assert.deepEqual(await d.helm.prMerge({ number: 1, expectedHead: head1 }), { ok: false, reason: `no approving review at ${head1}` }); }
  finally { d.store.close(); }
});

test('a Jev disagreement records disputed and emits a supervisor wake', async () => {
  const d = setup({ body: 'APPROVE blockers are items 1 and 2', jev: { shadow: false, async ask() { return { ok: true as const, answers: { approve: { noul: 0.11 } } }; } } });
  const supervisor = createSupervisor({ store: d.store, settings: loadSettings('/missing-review-settings'), hosts: { herdr: {} as never, tmux: {} as never } });
  supervisor.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'review' });
  try {
    const result = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-9', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.review.verdict, 'disputed');
    await supervisor.consume();
    const wakes = supervisor.wakes({ project: 'owner/repo', ack: false });
    assert.equal(wakes.ok, true);
    if (wakes.ok) assert.equal(wakes.wakes[0]?.kind, 'review.disputed');
  } finally { d.store.close(); }
});

test('an old-head review is rejected, then carried by the same patch id', async () => {
  const d = setup({ patchIds: { [head1]: 'patch-1', [head2]: 'patch-1' } });
  try {
    assert.deepEqual(await d.review.record({ number: 1, head: head2, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-10', reviewer: 'claude-sonnet', verdict: 'approve' }), {
      ok: false, reason: `head mismatch: expected ${head2}, got ${head1}`,
    });
    const recorded = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-10', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.equal(recorded.ok, true);
    d.setHead(head2);
    assert.deepEqual(await d.helm.prMerge({ number: 1, expectedHead: head2 }), { ok: true, merged: true });
    assert.equal(d.merged(), 1);
  } finally { d.store.close(); }
});

test('review.record refuses a stale head', async () => {
  const d = setup();
  try {
    assert.deepEqual(await d.review.record({ number: 1, head: head2, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-13', reviewer: 'claude-sonnet', verdict: 'approve' }), {
      ok: false, reason: `head mismatch: expected ${head2}, got ${head1}`,
    });
  } finally { d.store.close(); }
});

test('pr.merge refuses a review from the builder model family', async () => {
  const d = setup();
  try {
    const recorded = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-14', reviewer: 'codex/gpt-5.6-luna:high', verdict: 'approve' });
    assert.equal(recorded.ok, true);
    assert.deepEqual(await d.helm.prMerge({ number: 1, expectedHead: head1 }), { ok: false, reason: "reviewer model family 'gpt' matches the builder's" });
  } finally { d.store.close(); }
});

test('a comment from another PR is refused', async () => {
  const d = setup({ issueNumber: 2 });
  try {
    const result = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-11', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.deepEqual(result, { ok: false, reason: 'comment does not belong to this PR' });
  } finally { d.store.close(); }
});

test('without a Jev key the APPROVE line decides the verdict', async () => {
  const d = setup({ jev: { shadow: false, async ask() { return { ok: false as const, reason: 'no key' }; } }, body: 'APPROVE: ok' });
  try {
    const result = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-12', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.review.verdict, 'approve');
  } finally { d.store.close(); }
});
