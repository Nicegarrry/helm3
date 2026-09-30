import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrTicker } from '../src/pr-watch.js';
import { openStore } from '../src/store.js';
import type { GitHub, WorkerRow } from '../src/types.js';

test('external PR merges emit once and refresh the stored row', async () => {
  const store = openStore(':memory:');
  try {
    const worker: WorkerRow = {
      workerId: 'w-external', repo: '/tmp/repo', repoSlug: 'o/r', role: 'builder', model: 'codex/model', objective: 'task', acceptance: null,
      contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'base', branch: 'helm/w-external', worktree: '/tmp/worktree', state: 'succeeded', head: 'old', sessionFile: null,
      result: null, rawResultText: null, idempotencyKey: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    store.insertWorker(worker);
    store.insertPr({ repoSlug: 'o/r', number: 12, workerId: worker.workerId, url: 'https://github.test/12', head: 'old', createdAt: worker.createdAt });
    let calls = 0;
    const github = { prStatus: async () => { calls += 1; return { number: 12, state: 'merged' as const, head: 'new', mergeable: true, draft: false, checks: [], reviews: [], url: 'https://github.test/12', title: 'Title', base: 'main' }; } } as GitHub;
    const tick = createPrTicker({ store, github });
    await tick(); await tick();
    assert.equal(calls, 2);
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'pr.merged').length, 1);
    assert.equal(store.getPrByNumber('o/r', 12)?.head, 'new');
    assert.equal(store.listAllEvents().find((event) => event.kind === 'pr.merged')?.data.external, true);
  } finally { store.close(); }
});
