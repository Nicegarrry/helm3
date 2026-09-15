import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runLocalFixture } from '../../src/dogfood/index.js';
import { startLocalFixtureOperatorServer } from '../../src/dogfood/observe.js';

for (const orchestrator of ['fable', 'astra'] as const) test(`connected ${orchestrator} fixture steers one native Pi session from red gate to green`, async () => {
  const directory = await mkdtemp(join(tmpdir(), `helm3-connected-${orchestrator}-`)); let fixture: Awaited<ReturnType<typeof runLocalFixture>> | undefined;
  try {
    fixture = await runLocalFixture({ stateDirectory: directory, orchestrator });
    assert.equal(await readFile(fixture.resultPath, 'utf8'), 'provider-free Pi fixture\n');
    assert.equal(fixture.commandState, 'succeeded');  assert.equal(fixture.expiredRefusal, true);
    assert.ok(fixture.recoveryBundleRef.length > 0); assert.ok(fixture.recoveryStateRef.length > 0);
    assert.ok(fixture.rawRefs.length > 0); assert.equal(fixture.usageActions.modelRequests, 4); assert.equal(fixture.usageActions.workspaceWrites, 2);
    assert.ok(fixture.toolNames.includes('gate.run')); assert.ok(fixture.toolNames.includes('worker.fork')); assert.ok(fixture.toolNames.includes('worker.steer')); assert.ok(fixture.toolNames.includes('map.update')); assert.ok(fixture.toolNames.includes('map.close'));
    assert.equal(fixture.mapUpdateState, 'succeeded'); assert.equal(fixture.mapCloseState, 'succeeded'); assert.equal(fixture.mapCommandIds.length, 2); assert.equal(fixture.mapReceiptRefs.length, 2);
    assert.match(fixture.gateHead, /^[0-9a-f]{40}$/); assert.equal(fixture.gateCommandState, 'succeeded'); assert.ok(fixture.gateEvidenceRefs.length >= 2);
    assert.match(fixture.redGateHead, /^[0-9a-f]{40}$/); assert.notEqual(fixture.redGateHead, fixture.gateHead); assert.ok(fixture.redGateEvidenceRefs.length >= 2);
    assert.equal(fixture.steerSessionId, fixture.workerSessionId); assert.equal(fixture.secondModelSawPriorContext, true);
    const snapshot = await fixture.host.recover(fixture.runId);
    const gates = snapshot.commands.filter((record) => record.command.kind === 'gate.run'); const redGate = gates.find((record) => (record.command.payload as { expectedHead?: string }).expectedHead === fixture!.redGateHead); const greenGate = gates.find((record) => (record.command.payload as { expectedHead?: string }).expectedHead === fixture!.gateHead);
    assert.equal(gates.length, 2); assert.equal((redGate?.command.payload as { expectedHead?: string } | undefined)?.expectedHead, fixture.redGateHead); assert.equal((greenGate?.command.payload as { expectedHead?: string } | undefined)?.expectedHead, fixture.gateHead);
    assert.ok(redGate?.observations.some((observation) => observation.evidenceRefs.every((ref) => fixture!.redGateEvidenceRefs.includes(ref)))); assert.ok(greenGate?.observations.some((observation) => observation.evidenceRefs.length >= 2));
    assert.equal(snapshot.commands.find((record) => record.command.commandId === 'fixture-worker-spawn')?.status, 'succeeded'); assert.equal(snapshot.attemptLifecycles.find((entry) => entry.attemptId === fixture!.attemptId)?.state, 'finished');
    const steer = snapshot.commands.find((record) => record.command.commandId === fixture!.steerCommandId);
    assert.equal(steer?.status, 'succeeded'); assert.notEqual(fixture.steerAttemptId, fixture.workerAttemptId);
    const steerPayload = steer?.command.payload as { workerId?: string; attemptId?: string; predecessorWorkerId?: string; expectedHead?: string; gateCommandId?: string; evidenceRefs?: string[] } | undefined;
    assert.equal(steerPayload?.workerId, fixture.steerWorkerId); assert.equal(steerPayload?.attemptId, fixture.steerAttemptId); assert.equal(steerPayload?.expectedHead, fixture.redGateHead); assert.equal(steerPayload?.predecessorWorkerId, (snapshot.commands.find((record) => record.command.kind === 'worker.spawn')?.command.payload as { workerId?: string } | undefined)?.workerId); assert.equal(steerPayload?.gateCommandId, redGate?.command.commandId); assert.deepEqual(steerPayload?.evidenceRefs, fixture.redGateEvidenceRefs);
    assert.equal(snapshot.attemptLifecycles.find((entry) => entry.attemptId === fixture!.steerAttemptId)?.state, 'finished');
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native-fork fixture uses the production registry without a model call until explicit child steer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helm3-connected-native-fork-')); let fixture: Awaited<ReturnType<typeof runLocalFixture>> | undefined;
  try {
    fixture = await runLocalFixture({ stateDirectory: directory, orchestrator: 'fable', scenario: 'native-fork' });
    const snapshot = await fixture.host.recover(fixture.runId);
    const fork = snapshot.commands.find((record) => record.command.kind === 'worker.fork');
    const forkPayload = fork?.command.payload as { workerId?: string; predecessorWorkerId?: string; sourceSessionId?: string; sourceHistoryHash?: string; sourceBranchDigest?: string } | undefined;
    const steer = snapshot.commands.find((record) => record.command.commandId === fixture!.steerCommandId);
    assert.equal(fork?.status, 'succeeded'); assert.equal(forkPayload?.sourceSessionId, fixture.workerSessionId); assert.match(forkPayload?.sourceHistoryHash ?? '', /^sha256:[0-9a-f]{64}$/); assert.match(forkPayload?.sourceBranchDigest ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(fixture.steerSessionId, fixture.workerSessionId); assert.equal((steer?.command.payload as { predecessorWorkerId?: string }).predecessorWorkerId, forkPayload?.workerId); assert.equal(fixture.usageActions.modelRequests, 4);
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('after-write fixture interruption recovers unknown effects and refuses replay without changing the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-connected-interrupt-')); const marker = join(root, 'after-write-marker'); const stateDirectory = join(root, 'state');
  const child = (await import('node:child_process')).spawn(process.execPath, ['--import', 'tsx', 'test/dogfood/interrupted-child.ts', stateDirectory, 'fable'], { cwd: process.cwd(), env: { ...process.env, HELM_DOGFOOD_AFTER_WRITE_MARKER: marker }, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 15_000;
    while (true) { try { await readFile(marker); break; } catch { if (Date.now() > deadline) throw new Error('fixture did not reach after-write marker'); await new Promise((resolve) => setTimeout(resolve, 20)); } }
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve());
      });
    }
    const before = await readFile(join(stateDirectory, 'worker', 'result.txt'), 'utf8');
    const { openHost } = await import('../../src/host/index.js'); const { z } = await import('zod/v3');
    const host = await openHost({ stateDirectory: join(stateDirectory, 'host'), runtime: { async createEffect() { return { effectId: 'replay-fixture', async execute() {}, async observe() { return { commandId: 'fixture-worker-spawn', effectId: 'replay-fixture', state: 'succeeded' as const, source: 'fixture', observedAt: '2026-09-15T00:00:00.000Z', evidenceRefs: [] }; } }; } }, kinds: { 'worker.spawn': { payloadSchema: z.object({ path: z.literal('result.txt'), contents: z.literal('provider-free Pi fixture\n') }).strict() }, 'pi.model': { payloadSchema: z.object({ effectId: z.string(), kind: z.enum(['model.request', 'workspace.write']) }).strict(), resourceRequest: () => ({ poolId: 'fixture-requests', unit: 'requests', upperBound: 1, consumer: 'worker' as const }) }, 'pi.write': { payloadSchema: z.object({ effectId: z.string(), kind: z.enum(['model.request', 'workspace.write']) }).strict() } } });
    try { const recovered = await host.recover('fixture-run'); assert.equal(recovered.commands.find((record) => record.command.commandId === 'fixture-worker-spawn')?.status, 'succeeded'); assert.equal(recovered.commands.find((record) => record.command.kind === 'pi.write')?.status, 'unknown'); let replayExecuted = 0; await assert.rejects(host.perform('fixture-worker-spawn', { executorId: 'fixture-replay' }, '2099-01-01T00:00:00.000Z', async () => { replayExecuted++; return { value: true, state: 'known' as const, source: 'fixture', observedAt: '2026-09-15T00:00:00.000Z' }; }), /not claimable/); assert.equal(replayExecuted, 0); assert.equal(await readFile(join(stateDirectory, 'worker', 'result.txt'), 'utf8'), before); }
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
    const brief = await fetch(`${operator.url}/api/operator/read/brief.get`).then(async (response) => {
      assert.equal(response.status, 200);
      return response.json() as Promise<{ state: string; value?: { text: string } }>;
    });
    assert.deepEqual(brief, { state: 'succeeded', value: { text: 'Provider-free local fixture Brief.', source: 'fixture://brief', observedAt: fixture.observedAt } });
    const log = await fetch(`${operator.url}/api/operator/read/log.query?limit=1`).then((response) => response.json() as Promise<{ state: string; value?: { runId: string; events: unknown[] } }>);
    assert.equal(log.state, 'succeeded');
    assert.equal(log.value?.runId, fixture.runId);
    assert.ok((log.value?.events.length ?? 0) <= 1);
  } finally { await operator?.close(); await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
});
