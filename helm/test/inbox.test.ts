import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Helm } from '../src/helm.js';
import { createInboxTriage, insertInbox, listInbox } from '../src/inbox.js';
import { createJev, type Jev, type JevResult } from '../src/jev.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { GateRunner, GitHub, HelmConfig, WorkerHooks, WorkerRunner, Workspace } from '../src/types.js';

function deps() {
  const store = openStore(':memory:');
  const home = mkdtempSync(join(tmpdir(), 'helm-inbox-home-'));
  const config: HelmConfig = { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 5000 };
  const workspace: Workspace = {
    async resolveSha() { return 'a'.repeat(40); },
    async defaultBranch() { return 'main'; },
    async create(_repo, path, branch, baseSha) { return { path, branch, baseSha }; },
    async remove() {}, async head() { return 'a'.repeat(40); }, async isClean() { return true; },
    async diffStat() { return ''; }, async patchId() { return 'patch'; }, async commitAll() { return 'b'.repeat(40); }, async push() {},
    async clone() {}, async fetch() {},
  };
  const gates: GateRunner = { async run() { return { passed: true, checks: [] }; }, async defaultChecks() { return []; } };
  const github: GitHub = {
    async openPr() { return { number: 1, url: 'https://example.invalid/pr/1' }; },
    async prStatus() { throw new Error('unused'); }, async comment() { return { body: '', issueNumber: 1 }; }, async postComment() {}, async merge() {},
  };
  const sessions: Array<string | null> = [];
  const messages: string[] = [];
  let turns = 0;
  const runner: WorkerRunner = {
    async run(input, message, _hooks: WorkerHooks) {
      messages.push(message);
      sessions.push(input.sessionFile);
      turns += 1;
      if (message.startsWith('Answer to your question:') || message === 'decide yourself') {
        return { result: { status: 'succeeded', summary: 'continued', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: 'pi-session' };
      }
      return { result: { status: 'question', summary: 'need a decision', question: 'Which API should I use?', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: 'pi-session' };
    },
  };
  const helm = new Helm({ config, store, workspace, gates, github, runner, prompts: { builder: () => 'objective', reviewer: () => 'review' } });
  return { helm, store, home, sessions, messages, turns };
}

test('a question waits, is persisted as an ask, steer supersedes it, and reply resumes the same session', async () => {
  const d = deps();
  try {
    const first = await d.helm.spawn({ repo: d.home, objective: 'do it', model: 'test/model', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await d.helm.settle(first.workerId);
    assert.equal(d.store.getWorker(first.workerId)?.state, 'waiting');
    const firstItem = listInbox(d.store.sql)[0];
    assert.ok(firstItem);
    assert.equal(d.store.listEvents(first.workerId).filter((e) => e.kind === 'ask').length, 1);
    const waited = await d.helm.wait({ workerIds: [first.workerId], timeoutMs: 1000 });
    assert.equal(waited.ok && waited.settled[0]?.state, 'waiting');

    await d.helm.steer({ workerId: first.workerId, message: 'decide yourself' });
    await d.helm.settle(first.workerId);
    assert.equal(listInbox(d.store.sql, { state: 'superseded' }).some((item) => item.id === firstItem.id), true);

    const second = await d.helm.spawn({ repo: d.home, objective: 'do it again', model: 'test/model', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    await d.helm.settle(second.workerId);
    const secondItem = listInbox(d.store.sql, { state: 'open' }).find((item) => item.workerId === second.workerId);
    assert.ok(secondItem);
    const reply = await d.helm.inboxReply({ id: secondItem!.id, answer: 'Use the stable API.', by: 'supervisor' });
    assert.equal(reply.ok, true);
    await d.helm.settle(second.workerId);
    assert.equal(d.store.getWorker(second.workerId)?.state, 'succeeded');
    const answered = listInbox(d.store.sql, { state: 'answered' }).find((item) => item.id === secondItem!.id);
    assert.equal(answered?.answer, 'Use the stable API.');
    assert.deepEqual(d.sessions.slice(-2), [null, 'pi-session']);
    assert.equal(d.messages.at(-1), 'Answer to your question: Use the stable API.\nContinue the objective.');
  } finally {
    d.store.close();
    rmSync(d.home, { recursive: true, force: true });
  }
});

test('reply to a non-waiting worker is refused', async () => {
  const d = deps();
  try {
    const spawned = await d.helm.spawn({ repo: d.home, objective: 'do it', model: 'test/model', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    await d.helm.settle(spawned.workerId);
    await d.helm.steer({ workerId: spawned.workerId, message: 'decide yourself' });
    await d.helm.settle(spawned.workerId);
    insertInbox(d.store.sql, { id: 'q-deadbeef', workerId: spawned.workerId, project: 'repo', question: 'old question', createdAt: new Date().toISOString() });
    const reply = await d.helm.inboxReply({ id: 'q-deadbeef', answer: 'answer', by: 'supervisor' });
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.match(reply.reason, /not waiting/);
  } finally {
    d.store.close();
    rmSync(d.home, { recursive: true, force: true });
  }
});

async function triageCase(answers: JevResult) {
  const d = deps();
  const spawned = await d.helm.spawn({ repo: d.home, objective: 'choose an API', acceptance: 'tests pass', model: 'test/model', role: 'builder', contextPaths: [], allowWorkflows: false });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) throw new Error('spawn failed');
  await d.helm.settle(spawned.workerId);
  const item = listInbox(d.store.sql, { state: 'open' }).find((row) => row.workerId === spawned.workerId);
  assert.ok(item);
  const fake: Jev = { shadow: true, async ask() { return answers; } };
  await createInboxTriage({ store: d.store, settings: loadSettings('/definitely/missing/helm-home'), jev: fake })();
  return { d, item: listInbox(d.store.sql).find((row) => row.id === item!.id)! };
}

test('A5b triage sends the envelope context and routes human probability to needs_human', async () => {
  let captured: Parameters<Jev['ask']> | undefined;
  const d = deps();
  try {
    const spawned = await d.helm.spawn({ repo: d.home, objective: 'choose an API', acceptance: 'tests pass', model: 'test/model', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    await d.helm.settle(spawned.workerId);
    const item = listInbox(d.store.sql, { state: 'open' })[0]!;
    const fake: Jev = { shadow: true, async ask(...args) { captured = args; return { ok: true, answers: { route: { choice: 'needs_supervisor', probabilities: { needs_human: 0.35 }, confidence: 0.8 }, outside: { noul: false }, inIssue: { noul: false } } }; } };
    await createInboxTriage({ store: d.store, settings: loadSettings('/definitely/missing/helm-home'), jev: fake })();
    assert.equal(listInbox(d.store.sql)[0]?.triage?.route, 'needs_human');
    assert.equal(listInbox(d.store.sql)[0]?.triage?.shadow, true);
    assert.ok(captured);
    assert.equal(captured[0], 'triage');
    assert.deepEqual(captured[1].state, { envelope: 'Work only in the assigned worktree. Outside the autonomy envelope: production data or migrations, spending money, deleting data, secrets, merging or force-pushing main, and provider settings.', objective: 'choose an API', acceptance: 'tests pass', question: item.question });
    const routeQuestion = captured[1].questions.route;
    if (!routeQuestion || routeQuestion.type !== 'choice') throw new Error('triage route question is not a choice');
    assert.equal(routeQuestion.criteria.needs_human, 'outside the envelope: production data or migrations, spending money, deleting data, secrets, merging or force-pushing main, provider settings');
  } finally { d.store.close(); rmSync(d.home, { recursive: true, force: true }); }
});

test('A5b routes outside probability to needs_human even when Jev says the issue answers it', async () => {
  const result = await triageCase({ ok: true, answers: { route: { choice: 'answer_from_issue', confidence: 0.99 }, outside: { probabilities: { true: 0.5, false: 0.5 } }, inIssue: { noul: true } } });
  try { assert.equal(result.item.triage?.route, 'needs_human'); } finally { result.d.store.close(); rmSync(result.d.home, { recursive: true, force: true }); }
});

test('A5b maps a boolean-false noul with confidence to an outside probability', async () => {
  const result = await triageCase({ ok: true, answers: { route: { choice: 'answer_from_issue', confidence: 0.99 }, outside: { noul: false, confidence: 0.6 }, inIssue: { noul: true } } });
  try { assert.equal(result.item.triage?.route, 'needs_human'); } finally { result.d.store.close(); rmSync(result.d.home, { recursive: true, force: true }); }
});

test('A5b maps a numeric noul answer to an outside probability', async () => {
  const result = await triageCase({ ok: true, answers: { route: { choice: 'answer_from_issue', confidence: 0.99 }, outside: { noul: 0.97 }, inIssue: { noul: true } } });
  try { assert.equal(result.item.triage?.route, 'needs_human'); } finally { result.d.store.close(); rmSync(result.d.home, { recursive: true, force: true }); }
});

test('A5b accepts a high-confidence in-issue answer only inside the envelope', async () => {
  const result = await triageCase({ ok: true, answers: { route: { choice: 'answer_from_issue', confidence: 0.95 }, outside: { noul: false }, inIssue: { noul: true } } });
  try { assert.equal(result.item.triage?.route, 'answer_from_issue'); } finally { result.d.store.close(); rmSync(result.d.home, { recursive: true, force: true }); }
});

test('A5b records the safe default when Jev has no key', async () => {
  const result = await triageCase({ ok: false, reason: 'no key' });
  try { assert.deepEqual(result.item.triage, { route: 'needs_supervisor', reason: 'no key', shadow: true }); } finally { result.d.store.close(); rmSync(result.d.home, { recursive: true, force: true }); }
});

test('A5b emits one inbox.triage event with the milestone payload', async () => {
  const result = await triageCase({ ok: true, answers: { route: { choice: 'needs_human', confidence: 0.8 }, outside: { noul: 0.8 }, inIssue: { noul: 0.1 } } });
  try {
    const first = result.d.store.listEvents(result.item.workerId).filter((event) => event.kind === 'inbox.triage');
    await createInboxTriage({ store: result.d.store, settings: loadSettings('/definitely/missing/helm-home'), jev: { shadow: true, async ask() { throw new Error('must not triage twice'); } } })();
    const events = result.d.store.listEvents(result.item.workerId).filter((event) => event.kind === 'inbox.triage');
    assert.equal(first.length, 1);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.data, { inboxId: result.item.id, route: 'needs_human', shadow: true, question: result.item.question.slice(0, 500) });
  } finally { result.d.store.close(); rmSync(result.d.home, { recursive: true, force: true }); }
});

test('A5b real Jev triage records route confidence in jev_calls', async () => {
  const d = deps();
  try {
    const spawned = await d.helm.spawn({ repo: d.home, objective: 'choose an API', acceptance: 'tests pass', model: 'test/model', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    await d.helm.settle(spawned.workerId);
    const jev = createJev({
      settings: loadSettings('/definitely/missing/helm-home'),
      store: d.store,
      env: { TYPESAFE_API_KEY: 'test-key' },
      fetch: async () => new Response(JSON.stringify({
        answers: {
          route: { choice: 'needs_supervisor', confidence: 0.84, probabilities: { needs_human: 0.05 } },
          outside: { noul: 0.1 },
          inIssue: { noul: 0.2 },
        },
        usage: { input_tokens: 9 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await createInboxTriage({ store: d.store, settings: loadSettings('/definitely/missing/helm-home'), jev })();
    const row = d.store.sql.prepare("SELECT purpose, confidence FROM jev_calls WHERE purpose = 'triage'").get() as { purpose: string; confidence: number };
    assert.equal(row.purpose, 'triage');
    assert.equal(row.confidence, 0.84);
  } finally { d.store.close(); rmSync(d.home, { recursive: true, force: true }); }
});
