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
  supervisor: {}, budgets: { defaultCapUsd: 25, defaultCodexTokens: 20_000_000 }, spend: {}, discord: { projects: {}, digestSec: 60, maxPerHour: 20 },
  factory: { claims: 'block', claimsAt: 0.7, verdictAt: 0.5, retryMax: 2, envelopeTapAt: 0.5, tapTtlMin: 60 },
  queue: { tickSec: 30, checksTimeoutMin: 30 }, memory: {}, select: { skillDirs: ['~/code/skills'], skillAllow: [], autoAt: 0.7, lessons: 'shadow' },
  routing: { table: {}, allowed: [], minClean: 0.5, minN: 8 },
  hygiene: { keepNodeModules: false, gcSec: 600, worktreeTtlHours: 24, minFreeGb: 15 },
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

test('a refused wake is logged, marked delivered, and does not block later supervisors', async () => {
  const logs: string[] = [];
  const calls: string[] = [];
  const host: Host = {
    async resolve(label) { return { id: label, label, host: 'herdr' }; },
    async status() { return 'idle'; },
    async promptEmpty() { return true; },
    async send(pane, line) {
      calls.push(`${pane.id}:${line}`);
      if (pane.id === 'a') throw new Error('line refused');
    },
    async create() { return null; },
  };
  const store = openStore(':memory:');
  const created = createSupervisor({ store, settings, hosts: { herdr: host, tmux: host }, log: (line) => logs.push(line) });
  try {
    created.register({ project: 'owner/a', repo: '/repo/a', host: 'herdr', label: 'a' });
    created.register({ project: 'owner/b', repo: '/repo/b', host: 'herdr', label: 'b' });
    const refused = created.manualWake('owner/a', 'first wake');
    const delivered = created.manualWake('owner/b', 'second wake');
    assert.equal(refused.ok, true);
    assert.equal(delivered.ok, true);
    if (!refused.ok || !delivered.ok) return;
    await created.tick();
    assert.deepEqual(calls, ['a:first wake', 'b:second wake']);
    assert.deepEqual(logs, [`wake ${refused.wake.id} refused: line refused`]);
    const pending = created.wakes({ project: 'owner/a', ack: false });
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    assert.equal(pending.wakes[0]!.deliveredAt !== null, true);
    await created.tick();
    assert.deepEqual(calls, ['a:first wake', 'b:second wake']);
  } finally { store.close(); }
});

test('manualWake refuses dash-prefixed text before queueing', () => {
  const { store, created } = service(fakeHost().host);
  try {
    created.register({ project: 'owner/repo', repo: '/repo', host: 'herdr', label: 'owner repo' });
    assert.throws(() => created.manualWake('owner/repo', '-flag'), /manual wake text must not start with/);
    const wakes = created.wakes({ project: 'owner/repo', ack: false });
    assert.equal(wakes.ok, true);
    if (!wakes.ok) return;
    assert.deepEqual(wakes.wakes, []);
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
  assert.deepEqual(calls.at(-2), ['tmux', 'send-keys', '-t', '%1', '-l', '--', '/compact focus']);
  assert.deepEqual(calls.at(-1), ['tmux', 'send-keys', '-t', '%1', '--', 'Enter']);
  await host.send(pane, '-literal');
  assert.deepEqual(calls.at(-2), ['tmux', 'send-keys', '-t', '%1', '-l', '--', '-literal']);
  assert.deepEqual(calls.at(-1), ['tmux', 'send-keys', '-t', '%1', '--', 'Enter']);
  await host.create('-label', '-cwd', '-command');
  assert.deepEqual(calls.at(-1), ['tmux', 'new-session', '-d', '-s', 'helm-label', '-c', '-cwd', '--', '-command']);
});

test('herdr host passes --ansi when reading the visible prompt and accepts done as idle', async () => {
  const calls: string[][] = [];
  const fakeExec = async (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    assert.ok(!args.includes('--json'), 'herdr 0.7.1 rejects --json');
    if (args[0] === 'workspace' && args[1] === 'create') return { stdout: JSON.stringify({ id: 'cli:workspace:create', result: { type: 'workspace_created', workspace: { workspace_id: 'ws-2', label: 'new label' }, root_pane: { pane_id: 'ws-2:p1', agent_status: 'idle' } } }) };
    if (args[0] === 'workspace') return { stdout: JSON.stringify({ id: 'cli:workspace:list', result: { type: 'workspace_list', workspaces: [{ workspace_id: 'ws-1', label: 'owner repo', agent_status: 'done', focused: false, pane_count: 1, tab_count: 1 }] } }) };
    if (args[0] === 'pane' && args[1] === 'list') return { stdout: JSON.stringify({ id: 'cli:pane:list', result: { panes: [{ pane_id: 'p-1', agent_status: 'done', workspace_id: 'ws-1' }], type: 'pane_list' } }) };
    return { stdout: '\u001b[2mTry "…"\u001b[0m\n❯\u001b[2mTry "…"\u001b[0m' };
  };
  const host = herdrHost(fakeExec);
  const pane = await host.resolve('owner repo');
  assert.ok(pane);
  if (!pane) return;
  assert.equal(await host.status(pane), 'idle');
  assert.equal(await host.promptEmpty(pane), true);
  assert.ok(calls.some((args) => args.includes('--ansi')));
  assert.deepEqual(await host.create('new label', '/tmp', 'claude'), { id: 'ws-2:p1', workspaceId: 'ws-2', label: 'new label', host: 'herdr' });
});

test('herdr host refuses dash-prefixed positional values before executing', async () => {
  const calls: string[][] = [];
  const fakeExec = async (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    assert.ok(!args.includes('--json'), 'herdr 0.7.1 rejects --json');
    if (args[0] === 'workspace') return { stdout: JSON.stringify({ id: 'cli:workspace:create', result: { type: 'workspace_created', workspace: { workspace_id: 'ws-1', label: 'label' }, root_pane: { pane_id: 'p-1', agent_status: 'idle' } } }) };
    return { stdout: '' };
  };
  const host = herdrHost(fakeExec);
  const pane: Pane = { id: 'p-1', host: 'herdr' };
  await assert.rejects(host.send(pane, '-line'), /herdr line must not start with/);
  await assert.rejects(host.resolve('-label'), /herdr label must not start with/);
  await assert.rejects(host.create('label', '-cwd', 'command'), /herdr cwd must not start with/);
  await assert.rejects(host.create('-label', 'cwd', 'command'), /herdr label must not start with/);
  assert.deepEqual(calls, []);
});
