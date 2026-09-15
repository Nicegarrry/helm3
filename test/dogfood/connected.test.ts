import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runLocalFixture } from '../../src/dogfood/index.js';

for (const orchestrator of ['fable', 'astra'] as const) test(`connected ${orchestrator} fixture drives one host-fenced Pi faux worker and retains recovery evidence`, async () => {
  const directory = await mkdtemp(join(tmpdir(), `helm3-connected-${orchestrator}-`)); let fixture: Awaited<ReturnType<typeof runLocalFixture>> | undefined;
  try {
    fixture = await runLocalFixture({ stateDirectory: directory, orchestrator });
    assert.equal(await readFile(fixture.resultPath, 'utf8'), 'provider-free Pi fixture\n');
    assert.equal(fixture.commandState, 'succeeded');  assert.equal(fixture.expiredRefusal, true);
    assert.ok(fixture.recoveryBundleRef.length > 0); assert.ok(fixture.recoveryStateRef.length > 0);
    assert.ok(fixture.rawRefs.length > 0); assert.ok(fixture.usageActions.modelRequests >= 1); assert.equal(fixture.usageActions.workspaceWrites, 1);
    const snapshot = await fixture.host.recover(fixture.runId);
    assert.equal(snapshot.commands.find((record) => record.command.commandId === 'fixture-worker-spawn')?.status, 'succeeded');
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
});
