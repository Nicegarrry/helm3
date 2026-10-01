import assert from 'node:assert/strict';
import { type ChildProcess, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { launchRestartHelper } from '../src/cli.js';
import { Lifecycle } from '../src/lifecycle.js';

for (const failure of ['error event', 'synchronous throw', 'log open'] as const) {
  test(`restart helper ${failure} reaches the caller without stopping or blocking the daemon`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'helm-helper-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const lifecycle = new Lifecycle(home, () => []);
    let stopped = false;
    lifecycle.shutdown = () => { stopped = true; };
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => {};
    const spawnHelper = (() => {
      if (failure === 'synchronous throw') throw new Error('synthetic spawn failure');
      queueMicrotask(() => child.emit('error', new Error('synthetic spawn failure')));
      return child;
    }) as typeof spawn;
    if (failure === 'log open') mkdirSync(join(home, 'daemon.log'));
    lifecycle.restart = () => launchRestartHelper(home, 4747, spawnHelper);
    const logged: string[] = [];
    t.mock.method(console, 'error', (line: string) => { logged.push(line); });
    const result = await lifecycle.control({ action: 'restart' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, failure === 'log open' ? /EISDIR/ : /synthetic spawn failure/);
    assert.match(logged[0]!, /restart helper failed:/);
    assert.equal(lifecycle.status().phase, 'accepting');
    lifecycle.admit('worker.spawn')();
    assert.equal(existsSync(join(home, 'drain.json')), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
  });
}

test('restart waits for helper spawn and schedules shutdown exactly once after launch', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-helper-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lifecycle = new Lifecycle(home, () => []);
  const child = new EventEmitter() as ChildProcess;
  let unref = false;
  child.unref = () => { unref = true; };
  let stopped = 0;
  lifecycle.shutdown = () => { stopped++; };
  lifecycle.restart = () => launchRestartHelper(home, 4747, (() => child) as typeof spawn);
  let acknowledged = false;
  const result = lifecycle.control({ action: 'restart' }).then((value) => { acknowledged = true; return value; });
  assert.equal(lifecycle.status().phase, 'stopping');
  assert.equal(acknowledged, false);
  assert.equal(stopped, 0);
  assert.throws(() => lifecycle.admit('worker.spawn'), /draining/);
  assert.equal((await lifecycle.control({ action: 'restart' })).ok, false);
  child.emit('spawn');
  assert.equal((await result).ok, true);
  assert.equal(unref, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, 1);
});
