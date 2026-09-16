import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  type ProcessIdentity,
  type ReadSnapshot,
  LocalProcessProbe,
  classifyObservation,
  parseBoottime,
  parseProcStat,
  parsePsOutput,
  validProcessIdentity,
} from '../../src/host/process-liveness.js';

const statLine = (pid: number, start: string) => `${pid} (node (worker)) S ${Array(18).fill('0').join(' ')} ${start} 0 0`;

function makeMockSnapshot(opts: {
  platform?: string;
  ownPid?: number;
  bootIds?: string[];
  readFileMap?: Record<string, string>;
  execFileMap?: Record<string, string>;
  killResult?: 'ok' | 'esrch' | 'eperm' | 'unknown';
} = {}): ReadSnapshot {
  let bootIdx = 0;
  const boots = opts.bootIds ?? ['11111111-1111-1111-1111-111111111111'];
  return {
    async readFile(p: string): Promise<string> {
      if (p === '/proc/sys/kernel/random/boot_id') {
        return (boots[bootIdx++] ?? boots[boots.length - 1]) + '\n';
      }
      const val = opts.readFileMap?.[p];
      if (val === undefined) throw new Error(`ENOENT: ${p}`);
      return val;
    },
    async execFile(f: string, args: string[]): Promise<string> {
      if (f.includes('sysctl')) {
        const id = boots[bootIdx++] ?? boots[boots.length - 1];
        const [sec, usec] = id.split('.');
        return `{ sec = ${sec}, usec = ${usec ?? 0} } Thu Jun  1 00:00:00 2025\n`;
      }
      const k = `${f} ${args.join(' ')}`;
      const val = opts.execFileMap?.[k];
      if (val === undefined) throw new Error(`unhandled exec: ${k}`);
      return val;
    },
    killSignal: () => opts.killResult ?? 'ok',
    platform: () => opts.platform ?? 'linux',
    ownPid: () => opts.ownPid ?? 100,
  };
}

test('validProcessIdentity validation boundaries', () => {
  assert.equal(validProcessIdentity({ hostId: 'h', bootId: 'b', pid: 1, startedAt: 's' }), true);
  assert.equal(validProcessIdentity({ hostId: '', bootId: 'b', pid: 1, startedAt: 's' }), false);
  assert.equal(validProcessIdentity({ hostId: 'h', bootId: 'b', pid: 0, startedAt: 's' }), false);
  assert.equal(validProcessIdentity(null), false);
});

test('pure parser validation', () => {
  assert.deepEqual(parseProcStat(statLine(10, '4567')), {
    processState: 'S',
    starttime: '4567',
  });
  assert.equal(parseProcStat('junk token'), undefined);
  assert.equal(parseProcStat('10 (x) ? 1 1 1 0 0 0 0 0 0 0 0 0 0 20 0 1 0 notnum 0 0 0'), undefined);

  assert.equal(parseBoottime('{ sec = 1717234567, usec = 123456 }'), '1717234567.123456');
  assert.equal(parseBoottime('sec = 123 only'), undefined);

  const psVal = parsePsOutput('Thu Jun  5 12:00:00 2025 Ss');
  assert.ok(psVal);
  assert.equal(psVal.processState, 'Ss');
  assert.equal(psVal.startedAt, '2025-06-05T12:00:00.000Z');
  assert.equal(parsePsOutput('Thu Feb 31 12:00:00 2025 Ss'), undefined);
  assert.equal(parsePsOutput('garbage'), undefined);
});

test('classifyObservation matches observe semantics', () => {
  assert.equal(classifyObservation({
    hostMatch: false, bootBefore: 'b1', bootAfter: 'b1', expectedBootId: 'b1',
    signalResult: 'ok', processSample: { startedAt: 's', processState: 'S' }, expectedStartToken: 's',
  }), 'unknown');

  assert.equal(classifyObservation({
    hostMatch: true, bootBefore: 'b1', bootAfter: 'b2', expectedBootId: 'b1',
    signalResult: 'ok', processSample: { startedAt: 's', processState: 'S' }, expectedStartToken: 's',
  }), 'unknown');

  assert.equal(classifyObservation({
    hostMatch: true, bootBefore: 'b1', bootAfter: 'b1', expectedBootId: 'b1',
    signalResult: 'esrch', processSample: { startedAt: 's', processState: 'S' }, expectedStartToken: 's',
  }), 'unknown');

  assert.equal(classifyObservation({
    hostMatch: true, bootBefore: 'b1', bootAfter: 'b1', expectedBootId: 'b1',
    signalResult: 'esrch', expectedStartToken: 's',
  }), 'not-running');

  assert.equal(classifyObservation({
    hostMatch: true, bootBefore: 'b1', bootAfter: 'b1', expectedBootId: 'b1',
    signalResult: 'eperm', expectedStartToken: 's',
  }), 'unknown');
});

test('capture checks boot before and after snapshot', async () => {
  const unstableBootSnap = makeMockSnapshot({ bootIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'], readFileMap: { '/proc/100/stat': statLine(100, '500') } });
  const probeUnstable = new LocalProcessProbe('h1', unstableBootSnap);
  assert.equal(await probeUnstable.capture(), undefined);

  const stableSnap = makeMockSnapshot({
    bootIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
    readFileMap: { '/proc/100/stat': statLine(100, '500') },
  });
  const probeStable = new LocalProcessProbe('h1', stableSnap);
  const identity = await probeStable.capture();
  assert.ok(identity);
  assert.equal(identity.bootId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(identity.startedAt, '500');
  assert.equal(Object.isFrozen(identity), true);
});

test('observe foreign host returns unknown without inspecting OS', async () => {
  const probe = new LocalProcessProbe('host-A', makeMockSnapshot());
  const obs = await probe.observe({ hostId: 'host-B', bootId: '11111111-1111-1111-1111-111111111111', pid: 100, startedAt: 's' });
  assert.equal(obs.state, 'unknown');
  assert.equal(Object.isFrozen(obs), true);
});

test('observe PID reuse reports not-running', async () => {
  const snap = makeMockSnapshot({
    bootIds: ['11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111'],
    readFileMap: { '/proc/100/stat': statLine(100, '999') },
    killResult: 'ok',
  });
  const probe = new LocalProcessProbe('h1', snap);
  const obs = await probe.observe({ hostId: 'h1', bootId: '11111111-1111-1111-1111-111111111111', pid: 100, startedAt: '500' });
  assert.equal(obs.state, 'not-running');
  assert.match(obs.reason, /reused/i);
});

test('real OS child process lifecycle and death', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  const probe = new LocalProcessProbe('local-host');
  const selfId = await probe.capture();
  assert.ok(selfId, 'supported OS must capture its own process identity');
  assert.equal((await probe.observe(selfId)).state, 'same-process');
  const moduleUrl = pathToFileURL(resolve(__dirname, '../../src/host/process-liveness.ts')).href;
  const loaderUrl = pathToFileURL(resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs')).href;
  const script = `const module = await import(${JSON.stringify(moduleUrl)}); const { LocalProcessProbe } = module.default ?? module; const id = await new LocalProcessProbe('local-host').capture(); process.send(id ?? { error: 'capture failed' }); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', loaderUrl, '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [childId] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(10000) }), exited.then(() => { throw new Error('child exited before reporting its identity'); })]);
    assert.ok(validProcessIdentity(childId));
    assert.equal(childId.pid, child.pid);
    assert.equal((await probe.observe(childId)).state, 'same-process');
    child.kill('SIGKILL'); await exited;
    assert.equal((await probe.observe(childId)).state, 'not-running');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

test('probe errors, malformed data and unreadable boot remain unknown', async () => {
  const identity = { hostId: 'h', bootId: '11111111-1111-1111-1111-111111111111', pid: 100, startedAt: '500' };
  for (const opts of [
    { bootIds: ['invalid'], killResult: 'esrch' as const },
    { killResult: 'eperm' as const },
    { killResult: 'unknown' as const },
    { readFileMap: { '/proc/100/stat': 'malformed' } },
    { bootIds: [identity.bootId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'], readFileMap: { '/proc/100/stat': statLine(100, '500') } },
  ]) assert.equal((await new LocalProcessProbe('h', makeMockSnapshot(opts)).observe(identity)).state, 'unknown');
  assert.equal(parseProcStat(statLine(100, 'NaN')), undefined);
  assert.equal(parsePsOutput('Thu Jun 5 12:00:00 2025 junk'), undefined);
  assert.equal(parseBoottime('{ usec = 42 }'), undefined);
});
