import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { consumer } from '../src/daemon.js';
import { openStore } from '../src/store.js';
import type { WorkerRow } from '../src/types.js';

function makeWorker(workerId: string): WorkerRow {
  const now = new Date().toISOString();
  return {
    workerId,
    repo: '/tmp/repo',
    repoSlug: 'owner/repo',
    role: 'builder',
    model: 'test/model',
    objective: 'test',
    acceptance: null,
    contextPaths: [],
    allowWorkflows: false,
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    branch: `helm/${workerId}`,
    worktree: `/tmp/repo/${workerId}`,
    state: 'queued',
    head: null,
    sessionFile: null,
    result: null,
    rawResultText: null,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
  };
}

test('consumer processes each event once across a store reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-daemon-'));
  const path = join(dir, 'helm.sqlite');
  const processed: number[] = [];
  try {
    let store = openStore(path);
    try {
      store.insertWorker(makeWorker('w-consumer'));
      store.appendEvent('w-consumer', 'first');
      store.appendEvent('w-consumer', 'second');
      await consumer(store, 'test', (events) => processed.push(...events.map((event) => event.seq)))();
    } finally {
      store.close();
    }

    store = openStore(path);
    try {
      store.appendEvent('w-consumer', 'third');
      await consumer(store, 'test', (events) => processed.push(...events.map((event) => event.seq)))();
      await consumer(store, 'test', (events) => processed.push(...events.map((event) => event.seq)))();
      assert.deepEqual(processed, [1, 2, 3]);
      assert.equal(store.getCursor('test'), 3);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
