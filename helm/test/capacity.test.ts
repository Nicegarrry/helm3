import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCapacityAdmission } from '../src/capacity/admit.js';
import { askLoadClass, classifyLoad } from '../src/capacity/classify.js';
import { createCapacitySampler, type CapacitySnapshot } from '../src/capacity/sampler.js';
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

test('pressure and booted simulators shrink the live budget and queued work starts automatically', async () => {
  const current = snapshot({ freeRamGb: 20, memoryPressure: 'critical', bootedSimulators: 1 });
  const { store, capacity } = admission(current, 8);
  try {
    const first = await capacity.admit({ id: 'builder', workerId: 'builder', kind: 'builder', loadClass: 'heavy' }, () => {});
    const gate = await capacity.admit({ id: 'gate', workerId: 'gate', kind: 'gate', loadClass: 'medium' }, () => {});
    assert.deepEqual(first, { started: true });
    assert.deepEqual(gate, { queued: true });
    const waiting = await capacity.status();
    assert.equal(waiting.budget, 5);
    assert.equal(waiting.queue[0]?.kind, 'gate');
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
        if (file === 'vm_stat') return { stdout: 'page size of 4096 bytes\nPages free: 1048576\n' };
        if (file === 'memory_pressure') return { stdout: 'System-wide memory free percentage: 20%\n' };
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
    assert.equal(first.bootedSimulators, 1);
    assert.equal(first.freeDiskGb, 1024);
    assert.equal(first.processCount, 3);
    assert.equal(first.maxProcesses, 100);
    assert.equal(first.processHeadroomPct, 0.97);
    assert.deepEqual(first.topProcesses, [{ name: 'xcodebuild', count: 2 }, { name: 'node', count: 1 }]);
    assert.deepEqual(calls.sort(), ['memory_pressure:500', 'ps:500', 'ps:500', 'sysctl:500', 'vm_stat:500', 'xcrun:300']);
    sampler.stop();
  } finally { store.close(); }
});
