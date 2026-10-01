import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Lifecycle, ownDaemon } from '../src/lifecycle.js';

test('drain persists across restart; shutdown seals admission and is scheduled only once', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = new Lifecycle(home, () => []);
  first.drain();
  const next = new Lifecycle(home, () => []);
  assert.equal(next.status().phase, 'ready');
  assert.notEqual(next.bootId, first.bootId);
  assert.throws(() => next.admit('worker.spawn'), /draining/);
  let stopped = 0;
  next.shutdown = () => { stopped++; };
  assert.ok((await next.control({ action: 'shutdown' })).ok);
  assert.ok((await next.control({ action: 'shutdown' })).ok);
  assert.throws(() => next.admit('worker.stop'), /draining/);
  assert.equal((await next.control({ action: 'resume' })).ok, false);
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, 1);
});

test('exclusive daemon ownership is not stolen, even by another object in the same process', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-owner-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const release = ownDaemon(home);
  assert.throws(() => ownDaemon(home), /EEXIST/);
  release();
  const next = ownDaemon(home);
  next();
});

test('a stale updater cannot drain or shut down a replacement daemon', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = new Lifecycle(home, () => []);
  const replacement = new Lifecycle(home, () => []);
  for (const action of ['drain', 'shutdown', 'resume']) {
    const outcome = await replacement.control({ action, expectedBootId: old.bootId });
    assert.equal(outcome.ok, false);
    assert.equal(replacement.status().phase, 'accepting');
  }
});

test('plain shutdown and signal-style drain leave the next daemon accepting', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const signalStyle of [false, true]) {
    const first = new Lifecycle(home, () => []);
    first.shutdown = () => {};
    if (signalStyle) first.drain(false);
    assert.ok((await first.control({ action: 'shutdown' })).ok);
    const next = new Lifecycle(home, () => []);
    assert.equal(next.status().phase, 'accepting');
  }
});


test('transient drain refuses invalid metadata before closing admissions or scheduling shutdown', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lifecycle = new Lifecycle(home, () => []);
  let stopped = false;
  lifecycle.shutdown = () => { stopped = true; };
  const marker = join(home, 'drain.json');
  mkdirSync(marker);
  assert.throws(() => lifecycle.drain(false), /EISDIR/);
  const result = await lifecycle.control({ action: 'shutdown' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /EISDIR/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(lifecycle.status().phase, 'accepting');
  lifecycle.admit('worker.spawn')();
  rmSync(marker, { recursive: true });
  lifecycle.drain(false);
  assert.equal(existsSync(marker), false);
  assert.equal((await lifecycle.control({ action: 'shutdown' })).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);
});

test('transient drain preserves an existing explicit drain marker', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lifecycle = new Lifecycle(home, () => []);
  lifecycle.drain();
  const marker = join(home, 'drain.json');
  const original = readFileSync(marker, 'utf8');
  lifecycle.drain(false);
  assert.equal(readFileSync(marker, 'utf8'), original);
});

test('restart helper failure returns an error and restores admissions', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lifecycle = new Lifecycle(home, () => []);
  const failure = Promise.reject(new Error('synthetic helper spawn failure'));
  void failure.catch(() => {});
  lifecycle.restart = () => failure;
  let stopped = false;
  lifecycle.shutdown = () => { stopped = true; };
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const result = await lifecycle.control({ action: 'restart' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /restart helper failed: synthetic helper spawn failure/);
  assert.equal(lifecycle.status().phase, 'accepting');
  lifecycle.admit('worker.spawn')();
  assert.equal(existsSync(join(home, 'drain.json')), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.match(String(logged.flat()), /synthetic helper spawn failure/);
});

test('busy restart and shutdown refuse before changing admissions', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lifecycle = new Lifecycle(home, () => ['w-1', 'w-2']);
  let stopped = false;
  lifecycle.restart = lifecycle.shutdown = () => { stopped = true; };
  for (const action of ['restart', 'shutdown']) {
    const result = await lifecycle.control({ action });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /2 workers running; stop them or wait for them to finish/);
    assert.equal(lifecycle.status().phase, 'accepting');
    lifecycle.admit('worker.spawn')();
    assert.equal(existsSync(join(home, 'drain.json')), false);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
});

test('restart refuses an upgrade lock before closing admissions or launching a helper', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lifecycle = new Lifecycle(home, () => []);
  let spawned = false;
  lifecycle.restart = lifecycle.shutdown = () => { spawned = true; };
  mkdirSync(join(home, 'upgrade.lock'));
  const result = await lifecycle.control({ action: 'restart' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /upgrade in progress; restart refused/);
  assert.equal(lifecycle.status().phase, 'accepting');
  lifecycle.admit('worker.spawn')();
  assert.equal(existsSync(join(home, 'drain.json')), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned, false);
});


test('busy operations refuse shutdown and restart without closing admissions', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lifecycle = new Lifecycle(home, () => []);
  const release = lifecycle.admit('gate.run');
  for (const action of ['shutdown', 'restart']) {
    const result = await lifecycle.control({ action });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /1 operation in progress/);
    assert.equal(lifecycle.status().phase, 'accepting');
  }
  release();
  lifecycle.admit('worker.spawn')();
});

test('restart refuses active upgrade phases even when the upgrade lock is missing', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-life-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lifecycle = new Lifecycle(home, () => []);
  let spawned = false;
  lifecycle.restart = () => { spawned = true; };
  lifecycle.shutdown = () => {};
  for (const phase of ['draining', 'stopping', 'starting', 'healthy']) {
    writeFileSync(join(home, 'upgrade.json'), JSON.stringify({ phase }));
    const result = await lifecycle.control({ action: 'restart' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /upgrade in progress; restart refused/);
    assert.equal(lifecycle.status().phase, 'accepting');
    assert.equal(spawned, false);
  }
  writeFileSync(join(home, 'upgrade.json'), JSON.stringify({ phase: 'completed' }));
  assert.equal((await lifecycle.control({ action: 'restart' })).ok, true);
  assert.equal(spawned, true);
});
