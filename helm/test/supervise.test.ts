import assert from 'node:assert/strict';
import test from 'node:test';
import { herdrHost, promptEmptyTextForTest, tmuxHost, type Host, type Pane } from '../src/host.js';
import { createSupervisor } from '../src/supervise.js';
import { openStore } from '../src/store.js';
import type { Settings } from '../src/settings.js';
import type { WorkerRow } from '../src/types.js';

const settings: Settings = {
  jev: { shadow: true, model: 'jev-latest', triageHumanAt: 0.3, attentionAt: 0.4, timeoutMs: 5000 },
  wake: { minIntervalSec: 120, maxPerHour: 20 },
  watch: { tickSec: 60, silenceMin: 15, sameRefusal: 5, attentionEverySec: 180, cooldownMin: 15 },
  supervisor: {}, budgets: { defaultCapUsd: 25, defaultCodexTokens: 20_000_000 }, discord: { projects: {}, digestSec: 60, maxPerHour: 20 },
};

function worker(workerId = 'w-supervise'): WorkerRow {
  const at = new Date().toISOString();
  return {
    workerId, repo: '/repo', repoSlug: 'owner/repo', role: 'builder', model: 'test/model', objective: 'test', acceptance: null,
    contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'a'.repeat(40), branch: `helm/${workerId}`,
    worktree: `/repo/${workerId}`, state: 'idle', head: null, sessionFile: null, result: null, rawResultText: null,
    idempotencyKey: null, createdAt: at, updatedAt: at,
  };
}

function fakeHost(status: 'idle' | 'busy' = 'idle') {
  const calls: Array<{ pane: Pane; line: string }> = [];
  let paneNumber = 0;
  let promptIsEmpty = true;
  const host: Host = {
    async resolve(label) { paneNumber += 1; return { id: `pane-${paneNumber}`, label, host: 'herdr' }; },
    async status() { return status; },
    async promptEmpty() { return promptIsEmpty; },
    async send(pane, line) { calls.push({ pane, line }); },
    async create() { return null; },
  };
  return { host, calls, setStatus(next: 'idle' | 'busy') { status = next; }, setPromptEmpty(next: boolean) { promptIsEmpty = next; } };
}

function service(host: Host, now: () => Date = () => new Date()) {
  const store = openStore(':memory:');
  const created = createSupervisor({ store, settings, hosts: { herdr: host, tmux: host }, now });
  return { store, created };
}

test('A8 prompt detection treats empty and faint placeholders as empty, but drafts as non-empty', () => {
  assert.equal(promptEmptyTextForTest('❯'), true);
  assert.equal(promptEmptyTextForTest('❯ \x1b[2mTry "…"\x1b[0m'), true);
  assert.equal(promptEmptyTextForTest('❯ typed draft'), false);
});

test('busy panes defer and the next idle tick sends one coalesced wake', async () => {
  const fake = fakeHost('busy');
  const { store, created } = service(fake.host);
  try {
    created.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner repo' });
    store.insertWorker(worker());
    store.appendEvent('w-supervise', 'ask', { question: 'Which path?' });
    await created.tick();
    assert.equal(fake.calls.length, 0);
    fake.setStatus('idle');
    await created.tick();
    assert.equal(fake.calls.length, 1);
    assert.match(fake.calls[0]!.line, /^helm: 1 new for owner\/repo \(1 ask\)\. Call wake\.list\.$/);
  } finally { store.close(); }
});

test('a non-empty prompt defers and the min interval coalesces later events', async () => {
  let promptIsEmpty = false;
  const fake = fakeHost();
  fake.setPromptEmpty(promptIsEmpty);
  let current = new Date('2026-09-29T00:00:00.000Z');
  const { store, created } = service(fake.host, () => current);
  try {
    created.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner repo' });
    store.insertWorker(worker());
    store.appendEvent('w-supervise', 'state', { to: 'succeeded' });
    await created.tick();
    assert.equal(fake.calls.length, 0);
    promptIsEmpty = true;
    fake.setPromptEmpty(promptIsEmpty);
    await created.tick();
    assert.equal(fake.calls.length, 1);
    store.appendEvent('w-supervise', 'watch.alert', { detail: 'silence' });
    await created.tick();
    assert.equal(fake.calls.length, 1);
    current = new Date(current.getTime() + 121_000);
    await created.tick();
    assert.equal(fake.calls.length, 2);
  } finally { store.close(); }
});

test('maxPerHour counts coalesced deliveries, not individual wakes', async () => {
  const fake = fakeHost();
  let current = new Date('2026-09-29T00:00:00.000Z');
  const { store, created } = service(fake.host, () => current);
  try {
    created.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner repo' });
    store.insertWorker(worker());
    for (let index = 0; index < 12; index += 1) store.appendEvent('w-supervise', 'ask', { question: `question ${index}` });
    await created.tick();
    assert.equal(fake.calls.length, 1);
    store.appendEvent('w-supervise', 'watch.alert', { detail: 'second delivery' });
    current = new Date(current.getTime() + 121_000);
    await created.tick();
    assert.equal(fake.calls.length, 2);
  } finally { store.close(); }
});

test('pane ids are re-resolved by label and rotate delivers two verbatim commands', async () => {
  const fake = fakeHost();
  let current = new Date('2026-09-29T00:00:00.000Z');
  const { store, created } = service(fake.host, () => current);
  try {
    created.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner repo' });
    const rotated = created.rotate({ project: 'owner/repo', focus: 'review the pending batch' });
    assert.equal(rotated.ok, true);
    await created.tick();
    current = new Date(current.getTime() + 121_000);
    await created.tick();
    assert.deepEqual(fake.calls.map((call) => call.line), [
      '/compact review the pending batch',
      'helm: context rotated; run your startup read order.',
    ]);
    assert.deepEqual(fake.calls.map((call) => call.pane.id), ['pane-1', 'pane-2']);
  } finally { store.close(); }
});

test('tmux host uses a fake exec and sends literal text followed by Enter', async () => {
  const calls: string[][] = [];
  const fakeExec = async (command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    if (args[0] === 'list-panes') return { stdout: '%1\n' };
    if (args[0] === 'capture-pane') return { stdout: '❯\u001b[2mTry "…"\u001b[0m\n' };
    return { stdout: '' };
  };
  const host = tmuxHost(fakeExec, 0);
  const pane = await host.resolve('owner/repo');
  assert.ok(pane);
  if (!pane) return;
  assert.equal(await host.status(pane), 'idle');
  assert.equal(await host.promptEmpty(pane), true);
  await host.send(pane, '/compact focus');
  assert.deepEqual(calls.at(-2), ['tmux', 'send-keys', '-t', '%1', '-l', '/compact focus']);
  assert.deepEqual(calls.at(-1), ['tmux', 'send-keys', '-t', '%1', 'Enter']);
});

test('herdr host passes --ansi when reading the visible prompt and accepts done as idle', async () => {
  const calls: string[][] = [];
  const fakeExec = async (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'workspace') return { stdout: JSON.stringify({ workspaces: [{ id: 'ws-1', label: 'owner repo' }] }) };
    if (args[0] === 'pane' && args[1] === 'list') return { stdout: JSON.stringify({ panes: [{ pane_id: 'p-1', agent_status: 'done' }] }) };
    return { stdout: '\u001b[2mTry "…"\u001b[0m\n❯\u001b[2mTry "…"\u001b[0m' };
  };
  const host = herdrHost(fakeExec);
  const pane = await host.resolve('owner repo');
  assert.ok(pane);
  if (!pane) return;
  assert.equal(await host.status(pane), 'idle');
  assert.equal(await host.promptEmpty(pane), true);
  assert.ok(calls.some((args) => args.includes('--ansi')));
});
