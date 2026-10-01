import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Jev } from '../src/jev.js';
import { Helm } from '../src/helm.js';
import { createReview, verdictLine } from '../src/review.js';
import { createSupervisor } from '../src/supervise.js';
import { openStore } from '../src/store.js';
import { loadSettings } from '../src/settings.js';
import type { GateRunner, GitHub, HelmConfig, PrStatus, WorkerRow, WorkerRunner, Workspace } from '../src/types.js';

const head1 = 'a'.repeat(40);
const head2 = 'b'.repeat(40);

function setup(options: { headWaitMs?: number; jev?: Jev; body?: string; issueNumber?: number; patchIds?: Record<string, string>; home?: string; runner?: WorkerRunner } = {}) {
  const store = openStore(':memory:');
  const now = new Date().toISOString();
  const worker: WorkerRow = { workerId: 'w-review', repo: options.home ?? '/repo', repoSlug: 'owner/repo', role: 'builder', model: 'codex/gpt-6-luna:high', objective: 'work', acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'base', branch: 'helm/review', worktree: '/repo', state: 'succeeded', head: head1, sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: now, updatedAt: now };
  store.insertWorker(worker);
  store.insertPr({ number: 1, workerId: worker.workerId, url: 'https://github.com/owner/repo/pull/1', head: head1, createdAt: now });
  let currentHead = head1;
  let merges = 0;
  const posted: string[] = [];
  const workspace = { resolveSha: async (_repo: string, ref: string) => ref, create: async (_repo: string, path: string, branch: string, baseSha: string) => ({ path, branch, baseSha }), patchId: async (_repo: string, _base: string, head: string) => options.patchIds?.[head] ?? head } as Workspace;
  const github = {
    async openPr() { return { number: 1, url: worker.repoSlug }; },
    async prStatus(_repo: string, number: number): Promise<PrStatus> { return { number, state: 'open', head: currentHead, mergeable: true, draft: false, checks: [], reviews: [], url: worker.repoSlug }; },
    async comment() { return { body: options.body ?? posted.at(-1) ?? 'APPROVE: ok', issueNumber: options.issueNumber ?? 1 }; },
    async postComment(_repo: string, _number: number, body: string) { posted.push(body); return 'https://github.com/owner/repo/pull/1#issuecomment-1'; },
    async merge() { merges += 1; },
  } as unknown as GitHub;
  const jev = options.jev ?? { shadow: false, async ask() { return { ok: true as const, answers: { approve: { noul: 1 } } }; } };
  const review = createReview({ store, github, workspace, jev, settings: loadSettings('/missing-review-settings') });
  const config: HelmConfig = { home: options.home ?? '/tmp/helm-review', spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 1000 };
  const gates: GateRunner = { async run() { return { passed: true, checks: [] }; }, async defaultChecks() { return []; } };
  const runner: WorkerRunner = { async run() { return { result: null, rawText: '', sessionFile: null }; } };
  const helm = new Helm({ config, store, workspace, gates, github, runner: options.runner ?? runner, prompts: { builder: () => '', reviewer: () => '', validator: () => '' }, review, headWaitMs: options.headWaitMs ?? 50, headPollMs: 5 });
  return { store, helm, review, github, posted, setHead: (head: string) => { currentHead = head; }, merged: () => merges };
}

test('pr.merge refuses without an approving review at the expected head', async () => {
  const d = setup();
  try { assert.deepEqual(await d.helm.prMerge({ number: 1, expectedHead: head1 }), { ok: false, reason: `no approving review at ${head1}` }); }
  finally { d.store.close(); }
});

test('review.record and pr.merge stay scoped to the requested repository when numbers collide', async () => {
  const d = setup();
  try {
    const source = d.store.getWorker('w-review')!;
    const other = { ...source, workerId: 'w-other', repoSlug: 'owner/other', branch: 'helm/other', worktree: '/other' };
    d.store.insertWorker(other);
    d.store.insertPr({ repoSlug: other.repoSlug, number: 1, workerId: other.workerId, url: 'https://github.com/owner/other/pull/1', head: head1, createdAt: other.createdAt });

    const recorded = await d.review.record({ project: 'owner/other', number: 1, head: head1, commentUrl: 'https://github.com/owner/other/pull/1#issuecomment-20', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.equal(recorded.ok, true);
    if (recorded.ok) assert.equal(recorded.review.repoSlug, 'owner/other');
    assert.deepEqual(await d.helm.prMerge({ project: 'owner/other', number: 1, expectedHead: head1 }), { ok: true, merged: true });
  } finally { d.store.close(); }
});

test('number-only PR calls resolve from PR rows even when workers span four repositories', async () => {
  const d = setup();
  try {
    const source = d.store.getWorker('w-review')!;
    for (const [index, repoSlug] of ['owner/two', 'owner/three', 'owner/four'].entries()) {
      d.store.insertWorker({ ...source, workerId: `w-${index + 2}`, repoSlug, branch: `helm/${repoSlug.replace('/', '-')}`, worktree: `/${repoSlug.replace('/', '-')}` });
    }
    const status = await d.helm.prStatus({ number: 1 });
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.url, 'owner/repo');
    const recorded = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-21', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.equal(recorded.ok, true);
    assert.deepEqual(await d.helm.prMerge({ number: 1, expectedHead: head1 }), { ok: true, merged: true });
  } finally { d.store.close(); }
});

test('number-only PR calls refuse an ambiguous number and project selects the requested row', async () => {
  const d = setup();
  try {
    const source = d.store.getWorker('w-review')!;
    const other = { ...source, workerId: 'w-other', repoSlug: 'owner/other', branch: 'helm/other', worktree: '/other' };
    d.store.insertWorker(other);
    d.store.insertPr({ repoSlug: other.repoSlug, number: 1, workerId: other.workerId, url: 'https://github.com/owner/other/pull/1', head: head1, createdAt: other.createdAt });
    const ambiguous = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-22', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.deepEqual(ambiguous, { ok: false, reason: 'PR #1 is ambiguous across repos: owner/other, owner/repo; pass project' });
    assert.deepEqual(await d.helm.prMerge({ number: 1, expectedHead: head1 }), { ok: false, reason: 'PR #1 is ambiguous across repos: owner/other, owner/repo; pass project' });
    const merge = await d.helm.prMerge({ project: 'owner/other', number: 1, expectedHead: head1 });
    assert.deepEqual(merge, { ok: false, reason: `no approving review at ${head1}` });
  } finally { d.store.close(); }
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

test('pr.merge refuses an old-head approval when the patch id changes', async () => {
  const d = setup({ patchIds: { [head1]: 'patch-1', [head2]: 'patch-2' } });
  try {
    const recorded = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-17', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.equal(recorded.ok, true);
    d.setHead(head2);
    assert.deepEqual(await d.helm.prMerge({ number: 1, expectedHead: head2 }), { ok: false, reason: `no approving review at ${head2}` });
    assert.equal(d.merged(), 0);
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
  const recorded = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-14', reviewer: 'codex/gpt-6-luna:high', verdict: 'approve' });
    assert.equal(recorded.ok, true);
    assert.deepEqual(await d.helm.prMerge({ number: 1, expectedHead: head1 }), { ok: false, reason: "reviewer model family 'openai' matches the builder's" });
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

test('the last non-empty verdict line controls approval', async () => {
  const d = setup({ body: 'APPROVE: okay\n\nREQUEST_CHANGES: blockers' });
  try {
    const result = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-15', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.review.verdict, 'changes');
  } finally { d.store.close(); }
});

test('a Jev answer without noul is unknown and stores a null approval score', async () => {
  const d = setup({ body: 'APPROVE: okay', jev: { shadow: false, async ask() { return { ok: true as const, answers: { verdict: { confidence: 1 } } }; } } });
  try {
    const result = await d.review.record({ number: 1, head: head1, commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-16', reviewer: 'claude-sonnet', verdict: 'approve' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.review.verdict, 'approve');
      assert.equal(result.review.jevApprove, null);
    }
  } finally { d.store.close(); }
});

for (const verdict of ['APPROVE: looks good', 'REQUEST_CHANGES: fix this']) {
  test(`review.request automatically records the last verdict line: ${verdict}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'helm-auto-review-'));
    const body = `Findings\n\n${verdict}`;
    const d = setup({ home, body, jev: { shadow: false, async ask() { return { ok: false as const, reason: 'no key' }; } }, runner: { async run() { return { result: { status: 'succeeded', summary: 'Findings', notes: verdict, changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null }; } } });
    try {
      const result = await d.helm.reviewRequest({ number: 1, model: 'google/gemini-3.8-flash', allowSameFamily: false });
      assert.equal(result.ok, true); if (!result.ok) return;
      await d.helm.settle(result.reviewWorkerId);
      assert.deepEqual(d.posted, [body]);
      const rows = d.store.sql.prepare('SELECT head,reviewer,stated,verdict,commentUrl FROM reviews').all() as Record<string, unknown>[];
      assert.deepEqual(rows.map((row) => ({ ...row })), [{ head: head1, reviewer: 'google/gemini-3.8-flash', stated: verdict.startsWith('APPROVE:') ? 'approve' : 'request_changes', verdict: verdict.startsWith('APPROVE:') ? 'approve' : 'changes', commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-1' }]);
      assert.equal(d.store.getWorker(result.reviewWorkerId)?.baseSha, head1);
    } finally { await d.helm.close(); d.store.close(); rmSync(home, { recursive: true, force: true }); }
  });
}

test('review.request does not record an approval if the PR head changes during review', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-stale-review-'));
  let changeHead = () => {};
  const d = setup({ home, runner: { async run() { changeHead(); return { result: { status: 'succeeded', summary: 'APPROVE: okay', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null }; } } });
  changeHead = () => d.setHead(head2);
  try {
    const result = await d.helm.reviewRequest({ number: 1, model: 'google/gemini-3.8-flash', allowSameFamily: false });
    assert.equal(result.ok, true); if (!result.ok) return;
    await d.helm.settle(result.reviewWorkerId);
    assert.equal(d.store.sql.prepare('SELECT * FROM reviews').all().length, 0);
    assert.ok(d.store.listAllEvents().some((event) => event.kind === 'review.record.failed'));
  } finally { await d.helm.close(); d.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('review.request waits for GitHub to report the pushed head', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-lagging-review-'));
  const d = setup({ home, headWaitMs: 2000 });
  d.store.updatePr({ ...d.store.getPrByWorker('w-review')!, head: head2 });
  setTimeout(() => d.setHead(head2), 30);
  try {
    const result = await d.helm.reviewRequest({ number: 1, model: 'google/gemini-3.8-flash', allowSameFamily: false });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(d.store.getWorker(result.reviewWorkerId)?.baseSha, head2);
    await d.helm.settle(result.reviewWorkerId);
  } finally { await d.helm.close(); d.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('review.request refuses when GitHub never reports the pushed head', async () => {
  const d = setup();
  try {
    d.store.updatePr({ ...d.store.getPrByWorker('w-review')!, head: head2 });
    const result = await d.helm.reviewRequest({ number: 1, model: 'google/gemini-3.8-flash', allowSameFamily: false });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, new RegExp(`still reports PR head ${head1}, not the pushed head ${head2}`));
    assert.equal(d.store.listWorkers().length, 1);
  } finally { await d.helm.close(); d.store.close(); }
});

for (const example of [
  {
    summary: 'Reviewed PR #280’s diff ... are unavailable. APPROVE: No correctness issue found in the reviewed diff.',
    notes: 'The PR head ref and current checkout HEAD resolve to the same commit.',
    line: 'APPROVE: No correctness issue found in the reviewed diff.',
    verdict: 'approve',
  },
  {
    summary: 'Reviewed the diff. REQUEST_CHANGES: Fix the missing validation.',
    notes: 'The checkout matches the PR head.',
    line: 'REQUEST_CHANGES: Fix the missing validation.',
    verdict: 'changes',
  },
  {
    summary: 'APPROVE: Checks passed.',
    notes: 'Verified the PR head.',
    line: 'APPROVE: Checks passed.',
    verdict: 'approve',
  },
  {
    // Shape of the real #314 reviewer summary: a literal two-character '\\n' before 'APPROVE:'.
    summary: 'Reviewed the diff and ran the tests. The verdict parser change is correct and no regressions were found.\\nAPPROVE: No correctness issue found in the reviewed diff.',
    notes: 'The PR head ref resolves to the same commit as the checkout.',
    line: 'APPROVE: No correctness issue found in the reviewed diff.',
    verdict: 'approve',
  },
  {
    // Quoted '\nAPPROVE:' mid-summary must NOT be normalised; the real trailing REQUEST_CHANGES is the verdict.
    summary: 'The builder wrote "Fixed the parser bug.\\nAPPROVE: ship it" in the PR body, but a regression remains. REQUEST_CHANGES: normalise only the summary-tail escape.',
    notes: 'The PR head ref resolves to the same commit as the checkout.',
    line: 'REQUEST_CHANGES: normalise only the summary-tail escape.',
    verdict: 'changes',
  },
  {
    summary: 'Reviewed the diff without a verdict.',
    notes: 'Checks are unavailable.',
    line: 'REQUEST_CHANGES: reviewer gave no verdict',
    verdict: 'changes',
  },
]) {
  test(`review.request moves the verdict below notes: ${example.summary}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'helm-verdict-comment-'));
    const d = setup({ home, jev: { shadow: false, async ask() { return { ok: false as const, reason: 'no key' }; } }, runner: { async run() { return { result: { status: 'succeeded', summary: example.summary, notes: example.notes, changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null }; } } });
    try {
      const result = await d.helm.reviewRequest({ number: 1, model: 'google/gemini-3.8-flash', allowSameFamily: false });
      assert.equal(result.ok, true); if (!result.ok) return;
      await d.helm.settle(result.reviewWorkerId);
      const body = d.posted[0]!;
      assert.equal(body.split('\n').at(-1), example.line);
      assert.ok(body.indexOf(example.notes) < body.lastIndexOf(example.line));
      assert.equal(body.split(example.line).length, 2);
      if (example.summary.startsWith('Reviewed PR #280')) {
        assert.equal(body, `Reviewed PR #280’s diff ... are unavailable.\n\n${example.notes}\n\n${example.line}`);
      }
      const reviews = d.store.sql.prepare('SELECT stated,verdict FROM reviews').all() as Record<string, unknown>[];
      assert.deepEqual(reviews.map((row) => ({ ...row })), [{ stated: example.verdict === 'approve' ? 'approve' : 'request_changes', verdict: example.verdict }]);
    } finally { await d.helm.close(); d.store.close(); rmSync(home, { recursive: true, force: true }); }
  });
}

test('review.request fetches refs/pull/N/head before creating the reviewer worktree', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-fetch-review-'));
  const d = setup({ home });
  const calls: string[] = [];
  const workspace = (d.helm as unknown as { workspace: Workspace }).workspace;
  workspace.fetch = async (_repo, branch, source) => { calls.push(`fetch ${branch} ${source}`); };
  const create = workspace.create;
  workspace.create = async (...args) => { calls.push('create'); return create(...args); };
  try {
    const result = await d.helm.reviewRequest({ number: 1, model: 'google/gemini-3.8-flash', allowSameFamily: false });
    assert.equal(result.ok, true); if (!result.ok) return;
    await d.helm.settle(result.reviewWorkerId);
    assert.deepEqual(calls, ['fetch pull-1 refs/pull/1/head', 'create']);
  } finally { await d.helm.close(); d.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('a reviewer with no result records no review and emits review.warning', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-noresult-review-'));
  const d = setup({ home });
  try {
    const result = await d.helm.reviewRequest({ number: 1, model: 'google/gemini-3.8-flash', allowSameFamily: false });
    assert.equal(result.ok, true); if (!result.ok) return;
    await d.helm.settle(result.reviewWorkerId);
    assert.equal(d.store.sql.prepare('SELECT * FROM reviews').all().length, 0);
    assert.deepEqual(d.posted, []);
    assert.equal(d.store.listAllEvents().filter((event) => event.kind === 'review.warning').length, 1);
  } finally { await d.helm.close(); d.store.close(); rmSync(home, { recursive: true, force: true }); }
});

for (const example of [
  { name: 'mid-sentence quote', summary: 'The builder wrote "Ready. APPROVE: ship it" in the PR body, which I disagree with.' },
  { name: 'multiline blockquote', summary: '> The builder wrote:\n> Ready. APPROVE: ship it\n\nI disagree.' },
  { name: 'fenced block', summary: '```\nAPPROVE: ship it\n```\n\nI disagree.' },
  { name: 'unclosed fence', summary: 'I disagree.\n\n```\nAPPROVE: ship it' },
]) test(`a verdict in ${example.name} is not taken as the reviewer verdict`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-quoted-review-'));
  const summary = example.summary;
  const d = setup({ home, jev: { shadow: false, async ask() { return { ok: false as const, reason: 'no key' }; } }, runner: { async run() { return { result: { status: 'succeeded', summary, changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null }; } } });
  try {
    const result = await d.helm.reviewRequest({ number: 1, model: 'google/gemini-3.8-flash', allowSameFamily: false });
    assert.equal(result.ok, true); if (!result.ok) return;
    await d.helm.settle(result.reviewWorkerId);
    assert.equal(d.posted[0], `${summary}\n\nREQUEST_CHANGES: reviewer gave no verdict`);
    const rows = d.store.sql.prepare('SELECT stated,verdict FROM reviews').all() as Record<string, unknown>[];
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ stated: 'request_changes', verdict: 'changes' }]);
  } finally { await d.helm.close(); d.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('a real trailing APPROVE after a quoted APPROVE is the verdict', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-trailing-review-'));
  const summary = '> The builder wrote:\n> Ready. APPROVE: ship it\n\nChecks pass. APPROVE: verified.';
  const d = setup({ home, jev: { shadow: false, async ask() { return { ok: false as const, reason: 'no key' }; } }, runner: { async run() { return { result: { status: 'succeeded', summary, changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null }; } } });
  try {
    const result = await d.helm.reviewRequest({ number: 1, model: 'google/gemini-3.8-flash', allowSameFamily: false });
    assert.equal(result.ok, true); if (!result.ok) return;
    await d.helm.settle(result.reviewWorkerId);
    assert.equal(d.posted[0], '> The builder wrote:\n> Ready. APPROVE: ship it\n\nChecks pass.\n\nAPPROVE: verified.');
    const rows = d.store.sql.prepare('SELECT stated,verdict FROM reviews').all() as Record<string, unknown>[];
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ stated: 'approve', verdict: 'approve' }]);
  } finally { await d.helm.close(); d.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('verdictLine accepts only an unquoted last non-empty line', () => {
  assert.equal(verdictLine('Findings.\n\nAPPROVE: ok\n\n'), 'approve');
  assert.equal(verdictLine('Findings.\n\n> APPROVE: ok'), 'changes');
  assert.equal(verdictLine('```\nAPPROVE: ok'), 'changes');
  assert.equal(verdictLine('```\nquoted\n```\nAPPROVE: ok'), 'approve');
  assert.equal(verdictLine('```\n~~~\nAPPROVE: ok'), 'changes');
  assert.equal(verdictLine('````\n```\nAPPROVE: ok'), 'changes');
  assert.equal(verdictLine('~~~\n```\n~~~\nAPPROVE: ok'), 'approve');
  assert.equal(verdictLine('APPROVE: ok\n\nmore text'), 'changes');
});
