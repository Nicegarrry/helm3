import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { callDaemon } from '../src/server.js';

// Real daemon processes, isolated state, disabled provider discovery and no workers.
test('SIGTERM then start accepts work; helm restart rotates identity and waits for ready', { timeout: 45_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-restart-'));
  const env = { ...process.env, HELM_HOME: home, HELM_ROUTING_STARTUP_CHECK: '0' };
  let child: ChildProcess | undefined;
  let childClosed: Promise<unknown> = Promise.resolve();
  let output = '';
  const metadata = () => JSON.parse(readFileSync(join(home, 'serve.json'), 'utf8')) as { port: number; pid: number; token: string };
  const status = (port: number) => callDaemon(port, 'daemon.control', { action: 'status' }, false, undefined, home) as Promise<{ ok: boolean; phase: string; bootId: string }>;
  // The test timeout is a hang guard; readiness is determined by identity and status.
  const waitReady = async (started: ChildProcess) => {
    for (;;) {
      t.signal.throwIfAborted();
      if (started.exitCode !== null || started.signalCode !== null) throw new Error(`daemon exited before ready: ${output}`);
      if (existsSync(join(home, 'serve.json'))) {
        const data = metadata();
        const ready = await status(data.port);
        if (data.pid === started.pid && ready.ok && ready.phase === 'accepting') return data;
      }
      await delay(50, undefined, { signal: t.signal });
    }
  };
  const waitStopped = async () => {
    const signal = AbortSignal.timeout(15_000);
    // The owner releases the lock only after closing the HTTP server and store.
    while (existsSync(join(home, 'daemon.lock'))) await delay(50, undefined, { signal });
    await childClosed;
  };
  const start = () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--http'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    childClosed = once(child, 'close');
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.stdout?.resume();
  };
  t.after(async () => {
    if (existsSync(join(home, 'serve.json'))) {
      const data = metadata();
      await callDaemon(data.port, 'daemon.control', { action: 'shutdown' }, false, undefined, home);
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await waitStopped();
    rmSync(home, { recursive: true, force: true });
  });
  start();
  const first = await waitReady(child!);
  const exited = once(child!, 'exit');
  child!.kill('SIGTERM');
  await exited;
  await childClosed;
  assert.equal(existsSync(join(home, 'drain.json')), false);
  start();
  const second = await waitReady(child!);
  assert.notEqual(first.token, second.token);
  assert.equal((await status(second.port)).phase, 'accepting');
  const before = await status(second.port);
  const restarted = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'restart'], { env, timeout: 20_000 });
  assert.match(restarted.stdout, /restarted and ready/);
  const third = metadata();
  assert.equal(third.port, second.port);
  assert.notEqual(third.token, second.token);
  assert.notEqual((await status(third.port)).bootId, before.bootId);
  assert.equal((await status(third.port)).phase, 'accepting');
  const stopped = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'daemon', 'stop'], { env, timeout: 10_000 });
  assert.match(stopped.stdout, /stopping/);
  await waitStopped();
});
