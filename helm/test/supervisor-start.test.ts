import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startSupervisor } from '../src/cli.js';
import type { Host, HostStatus, Pane } from '../src/host.js';
import type { Settings } from '../src/settings.js';
import type { SupervisorHost } from '../src/types.js';

const settings: Settings = {
  jev: { shadow: true, model: 'jev-latest', triageHumanAt: 0.3, attentionAt: 0.4, timeoutMs: 5000 },
  wake: { minIntervalSec: 120, maxPerHour: 20 },
  watch: { tickSec: 60, silenceMin: 15, sameRefusal: 5, attentionEverySec: 180, cooldownMin: 15 },
  supervisor: {},
  budgets: { defaultCapUsd: 25, defaultCodexTokens: 20_000_000 },
  discord: { projects: {}, digestSec: 60, maxPerHour: 20 },
  factory: { claims: 'block', claimsAt: 0.7, verdictAt: 0.5, retryMax: 2, envelopeTapAt: 0.5, tapTtlMin: 60 },
  queue: { tickSec: 30, checksTimeoutMin: 30 }, memory: {}, select: { skillDirs: ['~/code/skills'], skillAllow: [], autoAt: 0.7, lessons: 'shadow' },
  routing: { table: {}, allowed: [], minClean: 0.5, minN: 8 },
};

function fakeHost(statuses: HostStatus[] = ['idle'], existing = false) {
  let pane: Pane | null = existing ? { id: 'pane-1', label: 'owner name', host: 'herdr' } : null;
  let resolveCalls = 0;
  let creates = 0;
  const sent: string[] = [];
  const host: Host = {
    async resolve(label) { resolveCalls += 1; return pane ? { ...pane, label } : null; },
    async status() { return statuses.length > 1 ? statuses.shift()! : statuses[0]!; },
    async promptEmpty() { return true; },
    async send(_pane, line) { sent.push(line); },
    async create(label) {
      creates += 1;
      pane = { id: 'pane-1', label, host: 'herdr' };
      return pane;
    },
  };
  return { host, get pane() { return pane; }, get creates() { return creates; }, get resolveCalls() { return resolveCalls; }, sent };
}

function clockAndSleep() {
  let now = 0;
  return { clock: () => now, sleep: async (ms: number) => { now += ms; } };
}

async function run(input: Parameters<typeof startSupervisor>[0], deps: NonNullable<Parameters<typeof startSupervisor>[1]>) {
  await startSupervisor(input, {
    settings,
    home: tmpdir(),
    daemon: async () => ({ port: 1, pid: 1 }),
    register: async () => undefined,
    warn: () => undefined,
    ...deps,
  });
}

test('supervisor start twice creates once and attaches once', async () => {
  const fake = fakeHost();
  const timing = clockAndSleep();
  const common = { host: fake.host, ...timing };
  await run({ project: 'owner/name', repo: '/repo', label: 'owner name', host: 'herdr' }, common);
  await run({ project: 'owner/name', repo: '/repo', label: 'owner name', host: 'herdr' }, common);
  assert.equal(fake.creates, 1);
  assert.equal(fake.resolveCalls, 2);
  assert.deepEqual(fake.sent, []);
});

test('dead agent re-runs the launch command', async () => {
  const fake = fakeHost(['unknown', 'idle'], true);
  const timing = clockAndSleep();
  await run({ project: 'owner/name', repo: '/repo', label: 'owner name', host: 'herdr' }, { host: fake.host, ...timing });
  assert.equal(fake.creates, 0);
  assert.equal(fake.sent.length, 1);
  assert.match(fake.sent[0]!, /--remote-control 'owner name'/);
});

test('register receives the resolved label', async () => {
  const fake = fakeHost();
  const registered: Array<{ project: string; repo: string; host: SupervisorHost; label: string }> = [];
  await run({ project: 'owner/name', repo: '/repo', label: 'Phone owner', host: 'herdr' }, {
    host: fake.host,
    ...clockAndSleep(),
    register: async (input) => { registered.push(input); },
  });
  assert.equal(registered[0]?.label, 'Phone owner');
});

test('falls back to tmux when herdr is unavailable', async () => {
  const fake = fakeHost();
  const calls: string[] = [];
  const exec = async (command: string) => { calls.push(command); throw new Error('herdr unavailable'); };
  await run({ project: 'owner/name', repo: '/repo', label: 'owner name' }, {
    exec,
    hosts: { herdr: fake.host, tmux: fake.host },
    ...clockAndSleep(),
  });
  assert.deepEqual(calls, ['herdr']);
  assert.equal(fake.creates, 1);
});

test('preflight warnings report missing helm server and skill', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'helm-supervisor-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'helm-supervisor-home-'));
  try {
    const warnings: string[] = [];
    await startSupervisor({ project: 'owner/name', repo, label: 'owner name', host: 'herdr' }, {
      settings, home, host: fakeHost().host, daemon: async () => ({ port: 1, pid: 1 }), register: async () => undefined,
      warn: (line) => warnings.push(line), ...clockAndSleep(),
    });
    assert.ok(warnings.some((line) => line.includes('.mcp.json has no helm server')));
    assert.ok(warnings.some((line) => line.includes('helm-supervisor skill is missing')));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('blocked status is polled and warned after launch', async () => {
  const fake = fakeHost(['idle', 'blocked']);
  const warnings: string[] = [];
  const timing = clockAndSleep();
  await run({ project: 'owner/name', repo: '/repo', label: 'owner name', host: 'herdr' }, {
    host: fake.host, warn: (line) => warnings.push(line), ...timing,
  });
  assert.ok(warnings.some((line) => line.includes('is blocked')));
  assert.ok(timing.clock() >= 500);
});
