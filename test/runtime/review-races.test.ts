import assert from 'node:assert/strict';
import test from 'node:test';
import { FableDriver, AstraDriver, HelmToolRegistry, type RecoveryBundle, type OrchestratorArtifacts } from '../../src/runtime/orchestrator/index.js';
function deferred() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
function fixture() {
  const bundles = new Map<string, RecoveryBundle>(); const records: unknown[] = [];
  return { records, bundles,
    async readText(ref: string) { return ref; }, async saveInvocation(input: unknown) { records.push(input); return 'invocation'; },
    async saveRecoveryBundle(bundle: RecoveryBundle) { bundles.set('bundle', structuredClone(bundle)); return 'bundle'; },
    async loadRecoveryBundle(_ref: string) { return structuredClone(bundles.get('bundle')!); },
    async capture() { return { recoveryStateRef: 'state' }; }, async restore() { return 'restored'; },
  };
}
const guard = { async assertCurrent() {} };
test('stop during Fable setup cannot revive the session', async () => {
  const claude = await import('@anthropic-ai/claude-agent-sdk'); const f = fixture(); const entered = deferred(); const gate = deferred(); let calls = 0;
  const artifacts: OrchestratorArtifacts = { ...f, async readText(ref) { if (ref === 'slow') { entered.release(); await gate.promise; } return ref; } };
  const sdk = { ...claude, query: (() => { calls++; return (async function* () { yield { type: 'result', subtype: 'success', session_id: 'provider' }; })(); }) as unknown as typeof claude.query };
  const driver = new FableDriver(artifacts, new HelmToolRegistry([]), guard, f, { env: { PATH: process.env.PATH ?? '' } }, sdk);
  const { sessionId } = await driver.start({ runId: 'run', contextRefs: [], mode: 'primary' });
  const pending = driver.invoke({ sessionId, objectiveRef: 'slow', contextRefs: [] }); await entered.promise;
  assert.deepEqual(await driver.stop({ sessionId }), { observed: 'unknown' }); gate.release(); await assert.rejects(pending);
  await assert.rejects(driver.invoke({ sessionId, objectiveRef: 'again', contextRefs: [] }), /Stopped|stopping|cancel/i); assert.equal(calls, 0);
});
test('final resume guard cannot overwrite a concurrent active invocation', async () => {
  const f = fixture(); const guardEntered = deferred(); const guardGate = deferred(); const turnGate = deferred(); const turnEntered = deferred();
  let holdFinalGuard = false; let armOnRestore = false; let blockTurn = false;
  const current = { async assertCurrent() { if (holdFinalGuard) { holdFinalGuard = false; guardEntered.release(); await guardGate.promise; } } };
  const recovery = { capture: f.capture, async restore() { if (armOnRestore) holdFinalGuard = true; return 'restored'; } };
  const thread = { get id() { return 'thread'; }, async runStreamed() { return { events: (async function* () { yield { type: 'thread.started', thread_id: 'thread' }; if (blockTurn) { turnEntered.release(); await turnGate.promise; } })() }; } };
  const sdk = { async create() { return { startThread: () => thread, resumeThread: () => thread }; } };
  const driver = new AstraDriver(f, current, recovery, sdk as never);
  const { sessionId } = await driver.start({ runId: 'run', mode: 'primary', contextRefs: [] });
  await driver.invoke({ sessionId, objectiveRef: 'first', contextRefs: [] }); const { bundleRef } = await driver.checkpoint({ sessionId });
  armOnRestore = true; const resuming = driver.resume({ sessionId, recoveryBundleRef: bundleRef }); await guardEntered.promise;
  blockTurn = true; const active = driver.invoke({ sessionId, objectiveRef: 'active', contextRefs: [] }); await turnEntered.promise; guardGate.release();
  try { await assert.rejects(resuming, /active|changed|resum/i); } finally { turnGate.release(); await active; }
});
test('provider failure retains already-observed Fable events', async () => {
  const claude = await import('@anthropic-ai/claude-agent-sdk'); const f = fixture();
  const sdk = { ...claude, query: (() => (async function* () { yield { type: 'system', subtype: 'init', session_id: 'observed-provider' }; throw new Error('lost stream'); })()) as unknown as typeof claude.query };
  const driver = new FableDriver(f, new HelmToolRegistry([]), guard, f, { env: { PATH: process.env.PATH ?? '' } }, sdk);
  const { sessionId } = await driver.start({ runId: 'run', mode: 'primary', contextRefs: [] });
  await assert.rejects(driver.invoke({ sessionId, objectiveRef: 'run', contextRefs: [] }), /lost stream/); assert.ok(f.records.length > 0);
});
