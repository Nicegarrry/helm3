import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runLocalFixture } from '../../src/dogfood/index.js';
import { startLocalFixtureOperatorServer } from '../../src/dogfood/observe.js';

for (const orchestrator of ['fable', 'astra'] as const) test(`connected ${orchestrator} fixture drives one host-fenced Pi faux worker and retains recovery evidence`, async () => {
  const directory = await mkdtemp(join(tmpdir(), `helm3-connected-${orchestrator}-`)); let fixture: Awaited<ReturnType<typeof runLocalFixture>> | undefined;
  try {
    fixture = await runLocalFixture({ stateDirectory: directory, orchestrator });
    assert.equal(await readFile(fixture.resultPath, 'utf8'), 'provider-free Pi fixture\n');
    assert.equal(fixture.commandState, 'succeeded');  assert.equal(fixture.expiredRefusal, true);
    assert.ok(fixture.recoveryBundleRef.length > 0); assert.ok(fixture.recoveryStateRef.length > 0);
    assert.ok(fixture.rawRefs.length > 0); assert.ok(fixture.usageActions.modelRequests >= 1); assert.equal(fixture.usageActions.workspaceWrites, 1);
    const snapshot = await fixture.host.recover(fixture.runId);
    assert.equal(snapshot.commands.find((record) => record.command.commandId === 'fixture-worker-spawn')?.status, 'succeeded'); assert.equal(snapshot.attemptLifecycles.find((entry) => entry.attemptId === fixture!.attemptId)?.state, 'finished');
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('after-write fixture interruption recovers unknown effects and refuses replay without changing the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-connected-interrupt-')); const marker = join(root, 'after-write-marker'); const stateDirectory = join(root, 'state');
  const child = (await import('node:child_process')).spawn(process.execPath, ['--import', 'tsx', 'test/dogfood/interrupted-child.ts', stateDirectory, 'fable'], { cwd: process.cwd(), env: { ...process.env, HELM_DOGFOOD_AFTER_WRITE_MARKER: marker }, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 15_000;
    while (true) { try { await readFile(marker); break; } catch { if (Date.now() > deadline) throw new Error('fixture did not reach after-write marker'); await new Promise((resolve) => setTimeout(resolve, 20)); } }
    child.kill('SIGKILL'); await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const before = await readFile(join(stateDirectory, 'worker', 'result.txt'), 'utf8');
    const { openHost } = await import('../../src/host/index.js'); const { z } = await import('zod/v3');
    const host = await openHost({ stateDirectory: join(stateDirectory, 'host'), runtime: { async createEffect() { return { effectId: 'replay-fixture', async execute() {}, async observe() { return { commandId: 'fixture-worker-spawn', effectId: 'replay-fixture', state: 'succeeded' as const, source: 'fixture', observedAt: '2026-09-15T00:00:00.000Z', evidenceRefs: [] }; } }; } }, kinds: { 'worker.spawn': { payloadSchema: z.object({ path: z.literal('result.txt'), contents: z.literal('provider-free Pi fixture\n') }).strict() }, 'pi.model': { payloadSchema: z.object({ effectId: z.string(), kind: z.enum(['model.request', 'workspace.write']) }).strict(), resourceRequest: () => ({ poolId: 'fixture-requests', unit: 'requests', upperBound: 1, consumer: 'worker' as const }) }, 'pi.write': { payloadSchema: z.object({ effectId: z.string(), kind: z.enum(['model.request', 'workspace.write']) }).strict() } } });
    try { const recovered = await host.recover('fixture-run'); assert.equal(recovered.commands.find((record) => record.command.commandId === 'fixture-worker-spawn')?.status, 'unknown'); assert.equal(recovered.commands.find((record) => record.command.kind === 'pi.write')?.status, 'unknown'); let replayExecuted = 0; await assert.rejects(host.perform('fixture-worker-spawn', { executorId: 'fixture-replay' }, '2099-01-01T00:00:00.000Z', async () => { replayExecuted++; return { value: true, state: 'known' as const, source: 'fixture', observedAt: '2026-09-15T00:00:00.000Z' }; }), /not claimable/); assert.equal(replayExecuted, 0); assert.equal(await readFile(join(stateDirectory, 'worker', 'result.txt'), 'utf8'), before); }
    finally { host.close(); }
  } finally { child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});


test('fixture operator server exposes the same read-only lifecycle projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helm3-connected-operator-')); let fixture: Awaited<ReturnType<typeof runLocalFixture>> | undefined; let operator: Awaited<ReturnType<typeof startLocalFixtureOperatorServer>> | undefined;
  try {
    fixture = await runLocalFixture({ stateDirectory: directory, orchestrator: 'fable' });
    operator = await startLocalFixtureOperatorServer(fixture);
    const snapshot = await fetch(operator.apiUrl).then(async (response) => {
      assert.equal(response.status, 200);
      return response.json() as Promise<{ source: { evidenceMode: string }; attempts: Array<{ attemptId: string; state: string; outcome: unknown }> }>;
    });
    assert.equal(snapshot.source.evidenceMode, 'fixture');
    const attempt = snapshot.attempts.find((entry) => entry.attemptId === fixture!.attemptId);
    assert.equal(attempt?.state, 'stopped');
    assert.equal(attempt?.outcome, null);
  } finally { await operator?.close(); await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
});
