import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCapacityAdmission } from '../src/capacity/admit.js';
import { askLoadClass, classifyLoad } from '../src/capacity/classify.js';
import { admissionRank } from '../src/capacity/priority.js';
import { createCapacitySampler, createSimulatorProbe, defaultExec, type CapacitySnapshot } from '../src/capacity/sampler.js';
import { openStore } from '../src/store.js';
import { loadSettings } from '../src/settings.js';

function snapshot(overrides: Partial<CapacitySnapshot> = {}): CapacitySnapshot {
  return {
    sampledAt: '2026-09-30T00:00:00.000Z', freeRamGb: 16, memoryPressure: 'normal', load1: 1, cpuCount: 8,
    freeDiskGb: 100, bootedSimulators: 0, running: { gates: 0, builds: 0, reviews: 0 }, ...overrides,
  };
}

function fakeSampler(current: CapacitySnapshot) {
  return {
    sample: async () => current,
    invalidate() {}, start() {}, stop() {},
  };
}

function admission(current: CapacitySnapshot, maxWorkers = 8) {
  const store = openStore(':memory:');
  const capacity = createCapacityAdmission({ home: '/tmp/helm-capacity-test', maxWorkers, store, settings: { capacity: loadSettings('/missing').capacity }, sampler: fakeSampler(current) });
  return { store, capacity };
}

test('capacity admits light work, limits heavy work, and respects the ceiling', async () => {
  const { store, capacity } = admission(snapshot({ freeRamGb: 64 }), 3);
  try {
    const started: string[] = [];
    for (const id of ['light-1', 'light-2', 'light-3', 'light-4']) {
      const result = await capacity.admit({ id, workerId: id, kind: 'builder', loadClass: 'light' }, () => { started.push(id); });
      assert.equal('started' in result, id !== 'light-4');
    }
    assert.deepEqual(started, ['light-1', 'light-2', 'light-3']);
    capacity.finish('light-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(started, ['light-1', 'light-2', 'light-3', 'light-4']);
  } finally { store.close(); }
});

test('idle capacity admits one heavy job even when the live unit budget is below four', async () => {
  const { store, capacity } = admission(snapshot({ freeRamGb: 4 }), 8);
  try {
    assert.deepEqual(await capacity.admit({ id: 'heavy', workerId: 'heavy', kind: 'builder', loadClass: 'heavy' }, () => {}), { started: true });
    assert.equal((await capacity.status()).usedUnits, 4);
    assert.deepEqual(await capacity.admit({ id: 'second', workerId: 'second', kind: 'builder', loadClass: 'light' }, () => {}), { queued: true });
  } finally { store.close(); }
});

test('priority drains a blocked aged head instead of backfilling smaller builders', async () => {
  let clock = new Date('2026-09-30T00:00:00.000Z');
  const store = openStore(':memory:');
  const capacity = createCapacityAdmission({ home: '/tmp/helm-capacity-priority', maxWorkers: 0, store, settings: { capacity: loadSettings('/missing').capacity }, sampler: fakeSampler(snapshot({ freeRamGb: 6 })), now: () => clock });
  try {
    const started: string[] = [];
    await capacity.admit({ id: 'light-1', workerId: 'light-1', kind: 'builder', loadClass: 'light' }, () => { started.push('light-1'); });
    await capacity.admit({ id: 'light-2', workerId: 'light-2', kind: 'builder', loadClass: 'light' }, () => { started.push('light-2'); });
    assert.deepEqual(started, ['light-1', 'light-2']);
    await capacity.admit({ id: 'gate', workerId: 'gate', kind: 'gate', loadClass: 'heavy' }, () => { started.push('gate'); });
    await capacity.admit({ id: 'light-3', workerId: 'light-3', kind: 'builder', loadClass: 'light' }, () => { started.push('light-3'); });
    await capacity.admit({ id: 'light-4', workerId: 'light-4', kind: 'builder', loadClass: 'light' }, () => { started.push('light-4'); });
    clock = new Date(clock.getTime() + 61_000);
    await capacity.tick();
    assert.deepEqual(started, ['light-1', 'light-2']);
    capacity.finish('light-1');
    await capacity.tick();
    assert.deepEqual(started, ['light-1', 'light-2']);
    capacity.finish('light-2');
    await capacity.tick();
    assert.deepEqual(started, ['light-1', 'light-2', 'gate']);
  } finally { store.close(); }
});

test('normal pressure uses pressure free memory and admits at least six units on a 16 GB Mac', async () => {
  const { store, capacity } = admission(snapshot({ freeRamGb: 5.4, totalRamGb: 16, pressureFreePct: 58, memoryPressure: 'normal' }));
  try {
    assert.ok((await capacity.status()).budget >= 6);
  } finally { store.close(); }
});

test('queued jobs survive an admission restart and rehydrate with their callback', async () => {
  const store = openStore(':memory:');
  try {
    const first = createCapacityAdmission({ home: '/tmp/helm-capacity-restart', maxWorkers: 1, store, settings: { capacity: loadSettings('/missing').capacity }, sampler: fakeSampler(snapshot({ freeRamGb: 8 })) });
    const callbacks: string[] = [];
    await first.admit({ id: 'running', workerId: 'running', kind: 'builder', loadClass: 'light', pid: process.pid }, () => { callbacks.push('running'); });
    await first.admit({ id: 'queued', workerId: 'queued', kind: 'builder', loadClass: 'light', payload: { type: 'worker', workerId: 'queued' } }, () => { callbacks.push('queued'); });
    const restarted = createCapacityAdmission({ home: '/tmp/helm-capacity-restart', maxWorkers: 1, store, settings: { capacity: loadSettings('/missing').capacity }, sampler: fakeSampler(snapshot({ freeRamGb: 8 })) });
    restarted.rehydrate((job) => job.payload ? () => { callbacks.push(String(job.workerId)); } : undefined);
    restarted.finish('running');
    await restarted.tick();
    assert.deepEqual(callbacks, ['running', 'queued']);
  } finally { store.close(); }
});

test('finish-triggered ticks are single-flight and do not start a queued job twice', async () => {
  const { store, capacity } = admission(snapshot({ freeRamGb: 16 }), 2);
  try {
    let starts = 0;
    await capacity.admit({ id: 'one', workerId: 'one', kind: 'builder', loadClass: 'light' }, () => {});
    await capacity.admit({ id: 'two', workerId: 'two', kind: 'builder', loadClass: 'light' }, () => {});
    await capacity.admit({ id: 'three', workerId: 'three', kind: 'builder', loadClass: 'light' }, () => { starts += 1; });
    capacity.finish('one');
    capacity.finish('two');
    await capacity.tick();
    assert.equal(starts, 1);
    assert.equal((await capacity.status()).runningJobs, 1);
  } finally { store.close(); }
});

test('pressure and booted simulators shrink the live budget and queued work starts automatically', async () => {
  const current = snapshot({ freeRamGb: 20, memoryPressure: 'critical', bootedSimulators: 1 });
  const { store, capacity } = admission(current, 8);
  try {
    const first = await capacity.admit({ id: 'builder', workerId: 'builder', kind: 'builder', loadClass: 'heavy' }, () => {});
    const gate = await capacity.admit({ id: 'gate', workerId: 'gate', kind: 'gate', loadClass: 'medium' }, () => {});
    assert.deepEqual(first, { started: true });
    assert.deepEqual(gate, { queued: true });
    const waiting = await capacity.status();
    assert.equal(waiting.budget, 0);
    assert.equal(waiting.queue[0]?.kind, 'gate');
  } finally { store.close(); }
});

test('capacity close waits for an in-flight tick', async () => {
  const store = openStore(':memory:');
  let resolveSample!: (value: CapacitySnapshot) => void;
  const sampler = {
    sample: () => new Promise<CapacitySnapshot>((resolve) => { resolveSample = resolve; }),
    invalidate() {}, start() {}, stop() {},
  };
  const capacity = createCapacityAdmission({ home: '/tmp/helm-capacity-close', maxWorkers: 0, store, settings: { capacity: loadSettings('/missing').capacity }, sampler });
  try {
    const tick = capacity.tick();
    let closed = false;
    const closing = capacity.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    resolveSample(snapshot());
    await Promise.all([tick, closing]);
    assert.equal(closed, true);
  } finally { store.close(); }
});

test('low process-table headroom queues builders and emits one hourly procs.low alert', async () => {
  const { store, capacity } = admission(snapshot({ processCount: 86, maxProcesses: 100, processHeadroomPct: 0.14, topProcesses: [{ name: 'xcodebuild', count: 80 }, { name: 'node', count: 4 }, { name: 'git', count: 2 }] }));
  try {
    store.sql.exec('CREATE TABLE supervisors (project TEXT PRIMARY KEY, repo TEXT, host TEXT, label TEXT, createdAt TEXT, lastWakeAt TEXT)');
    store.sql.prepare('INSERT INTO supervisors VALUES (?, ?, ?, ?, ?, NULL)').run('acme/widgets', '/repo', 'tmux', 'helm', '2026-09-30T00:00:00.000Z');
    const result = await capacity.admit({ id: 'builder', workerId: 'builder', kind: 'builder', loadClass: 'light' }, () => {});
    assert.deepEqual(result, { queued: true });
    const status = await capacity.status();
    assert.equal(status.processLimited, true);
    assert.equal(status.budget, 0);
    const alerts = store.listEvents('project:acme/widgets').filter((event) => event.kind === 'watch.alert' && event.data.rule === 'procs.low');
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0]?.data.detail, { processCount: 86, maxProcesses: 100, headroomPct: 0.14, topProcesses: [{ name: 'xcodebuild', count: 80 }, { name: 'node', count: 4 }, { name: 'git', count: 2 }] });
  } finally { store.close(); }
});

test('capacity classifies iOS repositories upward, honors explicit load, and defaults without Jev', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'helm-capacity-ios-'));
  mkdirSync(join(repo, 'Example.xcodeproj'));
  try {
    assert.equal(classifyLoad({ repo, jevAnswer: { choice: 'light' } }), 'heavy');
    assert.equal(classifyLoad({ repo, explicit: 'light', jevAnswer: { choice: 'heavy' } }), 'light');
    const result = await askLoadClass({ jev: { shadow: true, ask: async () => ({ ok: false, reason: 'no key' }) }, repo: '/missing/repo' });
    assert.equal(result, 'medium');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('Package.swift is an iOS repo hint for builders and gates/reviews are at least medium', () => {
  const repo = mkdtempSync(join(tmpdir(), 'helm-capacity-package-'));
  try {
    writeFileSync(join(repo, 'Package.swift'), '// swift package');
    assert.equal(classifyLoad({ repo, role: 'builder', jevAnswer: { choice: 'medium' } }), 'heavy');
    assert.equal(classifyLoad({ repo: '/missing/repo', role: 'gate' }), 'medium');
    assert.equal(classifyLoad({ repo: '/missing/repo', role: 'reviewer' }), 'medium');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('the sampler uses bounded probes, disk/simulator telemetry, and its cache', async () => {
  const store = openStore(':memory:');
  const calls: string[] = [];
  try {
    const sampler = createCapacitySampler({
      home: '/helm-home', store, now: () => new Date('2026-09-30T00:00:00.000Z'),
      statfs: async () => ({ bavail: 1024, bsize: 1024 ** 3 }),
      exec: async (file, args, options) => {
        calls.push(`${file}:${options.timeoutMs}`);
        if (file === 'vm_stat') return { stdout: 'page size of 4096 bytes\nPages free: 1048576\nPages inactive: 524288\nPages speculative: 262144\nPages purgeable: 262144\n' };
        if (file === 'memory_pressure') return { stdout: 'System-wide memory free percentage: 20%\n' };
        if (file === 'xcodebuild') return { stdout: '', code: 0 };
        if (file === 'xcrun') return { stdout: JSON.stringify({ devices: { iOS: [{ state: 'Booted' }, { state: 'Shutdown' }] } }), code: 0 };
        if (file === 'ps' && args.includes('comm=')) return { stdout: 'xcodebuild\nxcodebuild\nnode\n', code: 0 };
        if (file === 'ps') return { stdout: '1\n2\n3\n', code: 0 };
        if (file === 'sysctl') return { stdout: '100\n', code: 0 };
        return { stdout: '', code: 1 };
      },
    });
    const first = await sampler.sample();
    const second = await sampler.sample();
    assert.equal(first, second);
    assert.equal(first.memoryPressure, 'normal');
    assert.equal(first.freeRamGb, 8);
    assert.equal(first.bootedSimulators, 1);
    assert.equal(first.freeDiskGb, 1024);
    assert.equal(first.processCount, 3);
    assert.equal(first.maxProcesses, 100);
    assert.equal(first.processHeadroomPct, 0.97);
    assert.deepEqual(first.topProcesses, [{ name: 'xcodebuild', count: 2 }, { name: 'node', count: 1 }]);
    assert.deepEqual(calls.sort(), ['memory_pressure:500', 'ps:500', 'ps:500', 'sysctl:500', 'vm_stat:500', 'xcodebuild:1000', 'xcrun:300']);
    sampler.stop();
  } finally { store.close(); }
});

test('a timed capacity probe kills its grandchild process group', { timeout: 5_000 }, async () => {
  const result = await defaultExec(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `], { timeoutMs: 100 });
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, result.stderr);
  assert.equal(result.transient, true);
  await assert.rejects(async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { process.kill(pid, 0); } catch (error) { throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
});

test('the sampler caches a failed first-launch check and skips simctl', async () => {
  const store = openStore(':memory:');
  const calls: string[] = [];
  try {
    const sampler = createCapacitySampler({
      home: '/helm-home', store, sampleSec: 0, statfs: async () => { throw new Error('unavailable'); },
      exec: async (file) => {
        calls.push(file);
        return { stdout: '', code: file === 'xcodebuild' ? 69 : 1 };
      },
    });
    assert.equal((await sampler.sample()).bootedSimulators, null);
    sampler.invalidate();
    assert.equal((await sampler.sample()).bootedSimulators, null);
    assert.equal(calls.filter((file) => file === 'xcodebuild').length, 1);
    assert.equal(calls.includes('xcrun'), false);
  } finally { store.close(); }
});

test('the simulator probe retries spawn failures and timeouts after ten minutes', async () => {
  let clock = 0;
  let checks = 0;
  let simctlCalls = 0;
  const probe = createSimulatorProbe(async (file) => {
    if (file === 'xcodebuild') {
      checks += 1;
      if (checks === 1) throw new Error('spawn failed');
      if (checks === 2) return { stdout: '', code: 0, transient: true };
      return { stdout: '', code: 0 };
    }
    simctlCalls += 1;
    return { stdout: '{"devices":{}}', code: 0 };
  }, () => clock);
  assert.equal((await probe()).code, 1);
  assert.equal((await probe()).code, 1);
  assert.equal(checks, 1);
  clock += 10 * 60_000;
  assert.equal((await probe()).code, 1);
  assert.equal(checks, 2);
  clock += 10 * 60_000;
  assert.equal((await probe()).code, 0);
  assert.equal(checks, 3);
  assert.equal(simctlCalls, 1);
});

test('simctl probes are single-flight', async () => {
  let simctlCalls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const probe = createSimulatorProbe(async (file) => {
      if (file === 'xcodebuild') return { stdout: '', code: 0 };
      if (file === 'xcrun') { simctlCalls += 1; await blocked; return { stdout: '{"devices":{}}', code: 0 }; }
      return { stdout: '', code: 1 };
    });
    const first = probe();
    const second = probe();
    assert.equal(first, second);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(simctlCalls, 1);
    release();
    await Promise.all([first, second]);
  } finally { release(); }
});

/** One worker slot, so every job after `first` queues; each admit advances the clock one second. */
async function queueAfterFirst(jobs: Array<{ id: string; rank: ReturnType<typeof admissionRank> }>, clockStep = 1_000) {
  let clock = new Date('2026-10-01T00:00:00.000Z');
  const store = openStore(':memory:');
  const capacity = createCapacityAdmission({ home: '/tmp/helm-capacity-score', maxWorkers: 1, store, settings: { capacity: loadSettings('/missing').capacity }, sampler: fakeSampler(snapshot({ freeRamGb: 64 })), now: () => clock });
  const started: string[] = [];
  const admit = (id: string, rank?: ReturnType<typeof admissionRank>) => capacity.admit({ id, workerId: id, kind: 'builder', loadClass: 'light', ...(rank ? { rank } : {}) }, () => { started.push(id); });
  await admit('first', admissionRank('normal', 'auto'));
  for (const job of jobs) { clock = new Date(clock.getTime() + clockStep); await admit(job.id, job.rank); }
  return { store, capacity, started, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}

test('an urgent job overtakes older normal jobs of the same kind', async () => {
  const { store, capacity, started } = await queueAfterFirst([
    { id: 'normal-1', rank: admissionRank('normal', 'auto') }, { id: 'normal-2', rank: admissionRank('normal', 'auto') }, { id: 'urgent', rank: admissionRank('urgent', 'auto') },
  ]);
  try {
    assert.deepEqual((await capacity.status()).queue.map((entry) => entry.id), ['urgent', 'normal-1', 'normal-2']);
    capacity.finish('first');
    await capacity.tick();
    assert.deepEqual(started, ['first', 'urgent']);
    capacity.finish('urgent');
    await capacity.tick();
    assert.deepEqual(started, ['first', 'urgent', 'normal-1']);
  } finally { store.close(); }
});

test('owner and quick-win boosts raise the score and ties stay FIFO', async () => {
  const { store, capacity } = await queueAfterFirst([
    { id: 'plain', rank: admissionRank('normal', 'auto', 'm') }, { id: 'quick', rank: admissionRank('normal', 'auto', 'xs') }, { id: 'owner', rank: admissionRank('normal', 'owner', 'l') },
    { id: 'plain-2', rank: admissionRank('normal', 'auto', 'l') }, { id: 'both', rank: admissionRank('normal', 'owner', 's') },
  ]);
  try {
    const queue = (await capacity.status()).queue;
    assert.deepEqual(queue.map((entry) => [entry.id, entry.score]), [['both', 35], ['owner', 25], ['quick', 20], ['plain', 10], ['plain-2', 10]]);
    assert.deepEqual(queue[0]!.reasons, ['priority normal +10', 'requested by owner +15', 'quick win (s) +10']);
  } finally { store.close(); }
});

test('aging, one point per five minutes queued, eventually admits a low job ahead of newer normal jobs', async () => {
  const { store, capacity, started, advance } = await queueAfterFirst([{ id: 'low', rank: admissionRank('low', 'auto') }]);
  try {
    assert.equal((await capacity.status()).queue[0]!.score, 0);
    advance(55 * 60_000);
    const admitted = await capacity.admit({ id: 'normal', workerId: 'normal', kind: 'builder', loadClass: 'light', rank: admissionRank('normal', 'auto') }, () => { started.push('normal'); });
    assert.deepEqual(admitted, { queued: true });
    const queue = (await capacity.status()).queue;
    assert.deepEqual(queue.map((entry) => [entry.id, entry.score]), [['low', 11], ['normal', 10]]);
    assert.ok(queue[0]!.reasons.includes('aging +11'));
    capacity.finish('first');
    await capacity.tick();
    assert.deepEqual(started, ['first', 'low']);
  } finally { store.close(); }
});

test('capacity.queued and capacity.started events carry the score and reasons', async () => {
  const { store, capacity, advance } = await queueAfterFirst([{ id: 'owner', rank: admissionRank('high', 'owner', 'xs') }]);
  try {
    const queued = store.listEvents('owner').find((event) => event.kind === 'capacity.queued');
    assert.equal(queued?.data.score, 45);
    assert.deepEqual(queued?.data.reasons, ['priority high +20', 'requested by owner +15', 'quick win (xs) +10']);
    advance(10 * 60_000);
    capacity.finish('first');
    await capacity.tick();
    const started = store.listEvents('owner').find((event) => event.kind === 'capacity.started');
    assert.equal(started?.data.score, 47);
    assert.deepEqual(started?.data.reasons, ['priority high +20', 'requested by owner +15', 'quick win (xs) +10', 'aging +2']);
    assert.equal(store.listEvents('first').find((event) => event.kind === 'capacity.started')?.data.score, 10);
  } finally { store.close(); }
});

test('setPid updates only the job id when gate and ticket share a worker', async () => {
  const { store, capacity } = admission(snapshot());
  try {
    await capacity.admit({ id: 'ticket', workerId: 'worker', kind: 'builder', loadClass: 'light' }, () => {});
    await capacity.admit({ id: 'gate', workerId: 'worker', kind: 'gate', loadClass: 'light' }, () => {});
    capacity.setPid('worker', process.pid);
    assert.deepEqual((store.sql.prepare('SELECT pid FROM capacity_jobs').all() as Array<{ pid: number | null }>).map((row) => row.pid), [null, null]);
    capacity.setPid('ticket', process.pid);
    assert.equal((store.sql.prepare('SELECT pid FROM capacity_jobs WHERE id = ?').get('ticket') as { pid: number }).pid, process.pid);
    assert.equal((store.sql.prepare('SELECT pid FROM capacity_jobs WHERE id = ?').get('gate') as { pid: null }).pid, null);
    capacity.setPid('gate', process.pid);
    assert.equal((store.sql.prepare('SELECT pid FROM capacity_jobs WHERE id = ?').get('gate') as { pid: number }).pid, process.pid);
  } finally { await capacity.close(); store.close(); }
});
