import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
