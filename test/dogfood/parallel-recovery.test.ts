import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runParallelRecoveryFixture } from '../../src/dogfood/parallel-recovery.js';

test('provider-free parallel recovery overlaps three native workers and replays one durable failure without duplicate signals', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'helm3-parallel-recovery-')); let result: Awaited<ReturnType<typeof runParallelRecoveryFixture>> | undefined;
  try {
    const fixture = await runParallelRecoveryFixture(stateDirectory);
    result = fixture;
    assert.equal(fixture.entered.length, 3); assert.equal(new Set(fixture.entered.map(entry => entry.sessionId)).size, 3); assert.ok(fixture.entered.every(entry => Date.parse(entry.at) <= Date.parse(fixture.releasedAt))); assert.equal(new Set(fixture.workers.map(worker => worker.sessionId)).size, 3); assert.equal(new Set(fixture.workers.map(worker => worker.workspace)).size, 3);
    assert.equal(result.workers.filter(worker => worker.state === 'terminal').length, 2); assert.equal(result.workers.filter(worker => worker.state === 'unknown').length, 1);
    assert.equal(result.retainedReservations, 1); assert.equal(result.supervisorSignalCount, 3); assert.equal(result.failureSignalCount, 1); assert.equal(result.pendingJudgements, 1); assert.equal(result.oldEpochRefused, true); assert.equal(result.newEpochAdmitted, true);
  } finally { await result?.close(); await rm(stateDirectory, { recursive: true, force: true }); }
});
