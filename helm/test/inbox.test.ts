import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Helm } from '../src/helm.js';
import { insertInbox, listInbox } from '../src/inbox.js';
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
    async diffStat() { return ''; }, async commitAll() { return 'b'.repeat(40); }, async push() {},
    async clone() {}, async fetch() {},
  };
  const gates: GateRunner = { async run() { return { passed: true, checks: [] }; }, async defaultChecks() { return []; } };
  const github: GitHub = {
    async openPr() { return { number: 1, url: 'https://example.invalid/pr/1' }; },
    async prStatus() { throw new Error('unused'); }, async comment() {}, async merge() {},
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
