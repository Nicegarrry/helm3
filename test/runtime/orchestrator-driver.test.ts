import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AstraDriver,
  FableDriver,
  HelmToolRegistry,
  type OrchestratorArtifacts,
  type RecoveryBundle,
} from '../../src/runtime/orchestrator/index.js';

class Fixtures implements OrchestratorArtifacts {
  readonly text = new Map<string, string>([['objective', 'make a local observation'], ['context', 'known context'], ['event', 'known event']]);
  readonly bundles = new Map<string, RecoveryBundle>();
  readonly invocations: Array<{ driver: string; sessionId: string; providerSessionId?: string; text: string }> = [];
  failBundle = false;
  restoreWait?: Promise<void>;

  async readText(ref: string): Promise<string> { return this.text.get(ref) ?? ref; }
  async saveInvocation(input: { driver: 'fable' | 'astra'; sessionId: string; providerSessionId?: string; text: string }): Promise<string> {
    this.invocations.push(input); return `invocation:${this.invocations.length}`;
  }
  async saveRecoveryBundle(bundle: RecoveryBundle): Promise<string> {
    if (this.failBundle) throw new Error('durable bundle write failed');
    const ref = `bundle:${this.bundles.size + 1}`; this.bundles.set(ref, structuredClone(bundle)); return ref;
  }
  async loadRecoveryBundle(ref: string): Promise<RecoveryBundle> {
    const bundle = this.bundles.get(ref); if (!bundle) throw new Error(`missing bundle ${ref}`); return structuredClone(bundle);
  }
  async capture(input: { driver: 'fable' | 'astra'; runId: string; sessionId: string; mode: 'primary' | 'consultant' }): Promise<{ recoveryStateRef: string }> {
    return { recoveryStateRef: `recovery:${input.driver}:${input.runId}:${input.sessionId}` };
  }
  async restore(recoveryStateRef: string): Promise<string> { await this.restoreWait; return `restored:${recoveryStateRef}`; }
}

const current = { async assertCurrent() {} };

test('Fable uses real typed Claude SDK tool and in-process MCP construction with a provider-free query fixture', async () => {
  const claude = await import('@anthropic-ai/claude-agent-sdk');
  const fixtures = new Fixtures();
  const tools = new HelmToolRegistry([{ name: 'brief.get', description: 'Read the current Brief.', input: { id: z.string().min(1) }, async execute(input) { return { state: 'succeeded', value: input }; } }]);
  let definitions: Array<{ handler(args: { id: string }, extra: unknown): Promise<unknown> }> = [];
  let toolResult: unknown;
  const sdk = {
    ...claude,
    createSdkMcpServer(options: Parameters<typeof claude.createSdkMcpServer>[0]) {
      definitions = options.tools as typeof definitions;
      return claude.createSdkMcpServer(options);
    },
    query: (() => (async function* () { toolResult = await definitions[0]!.handler({ id: 'brief-1' }, {}); yield { type: 'result', subtype: 'success', session_id: 'fable-provider-session' }; })()) as unknown as typeof claude.query,
  };
  const driver = new FableDriver(fixtures, tools, current, fixtures, { env: { PATH: process.env.PATH ?? '' } }, sdk);
  const { sessionId } = await driver.start({ runId: 'run-1', contextRefs: [], mode: 'primary' });
  await driver.send_event({ sessionId, eventRef: 'event' });
  assert.deepEqual(await driver.invoke({ sessionId, objectiveRef: 'objective', contextRefs: ['context'] }), { resultRef: 'invocation:1' });
  assert.equal(fixtures.invocations[0]?.providerSessionId, 'fable-provider-session');
  assert.equal(definitions.length, 1, 'the actual Claude SDK receives the typed Helm tool');
  assert.deepEqual(toolResult, {
    content: [{ type: 'text', text: JSON.stringify({ state: 'succeeded', value: { id: 'brief-1' } }) }],
    structuredContent: { state: 'succeeded', value: { id: 'brief-1' } },
  });
  await assert.rejects(definitions[0]!.handler({ id: 'late' }, {}), /no longer active/);
  fixtures.failBundle = true;
  await assert.rejects(driver.checkpoint({ sessionId }), /durable bundle write failed/);
  const consultant = await driver.start({ runId: 'run-2', contextRefs: ['context'], mode: 'consultant' });
  await driver.invoke({ sessionId: consultant.sessionId, objectiveRef: 'objective', contextRefs: [] });
  assert.deepEqual(await definitions[0]!.handler({ id: 'brief-2' }, {}), {
    content: [{ type: 'text', text: JSON.stringify({ state: 'refused', reason: 'Consultant sessions cannot issue Helm tool effects' }) }],
  });
  const unknown = new HelmToolRegistry([{ name: 'effect', description: 'May have started an effect.', input: {}, async execute() { throw new Error('effect outcome was not observed'); } }]);
  assert.deepEqual(await unknown.invoke('effect', {}), { state: 'unknown', reason: 'effect outcome was not observed' });
});

test('Astra maps the real pinned Codex SDK to local fixture lifecycle, durable recovery, and cancellation uncertainty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-astra-driver-'));
  const executable = join(root, 'fake-codex.mjs');
  const statePath = join(root, 'state.jsonl');
  const tracePath = join(root, 'trace.jsonl');
  const fakeCodex = `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
let input = ''; for await (const chunk of process.stdin) input += chunk;
await appendFile(process.env.TRACE_PATH, JSON.stringify({ args, input }) + '\\n');
if (input.includes('block')) {
  await appendFile(process.env.STATE_PATH, 'started\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-blocked' }));
  process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000);
} else {
  const resumed = args.includes('resume'); const id = resumed ? args[args.indexOf('resume') + 1] : 'thread-local';
  console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text: resumed ? 'resumed' : 'started' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }));
}`;
  try {
    await writeFile(executable, fakeCodex, { mode: 0o700 }); await chmod(executable, 0o700);
    const { Codex } = await import('@openai/codex-sdk');
    const sdk = { async create() { return new Codex({ codexPathOverride: executable, env: { PATH: process.env.PATH ?? '', STATE_PATH: statePath, TRACE_PATH: tracePath } }); } };
    const fixtures = new Fixtures();
    const driver = new AstraDriver(fixtures, current, fixtures, sdk);
    const { sessionId } = await driver.start({ runId: 'run-1', contextRefs: [], mode: 'primary' });
    assert.match(sessionId, /^helm:astra:/, 'Helm assigns its own identity before the SDK observes a provider thread id');
    assert.equal(driver.toolBridge.state, 'unsupported');
    await driver.send_event({ sessionId, eventRef: 'event' });
    assert.deepEqual(await driver.invoke({ sessionId, objectiveRef: 'objective', contextRefs: ['context'] }), { resultRef: 'invocation:1' });
    assert.equal(fixtures.invocations[0]?.providerSessionId, 'thread-local');
    const { bundleRef } = await driver.checkpoint({ sessionId });
    assert.deepEqual(fixtures.bundles.get(bundleRef), {
      driver: 'astra', runId: 'run-1', sessionId, providerSessionId: 'thread-local', mode: 'primary', contextRefs: [], eventRefs: ['event'], recoveryStateRef: `recovery:astra:run-1:${sessionId}`,
    }, 'checkpoint includes the host-owned recovery manifest, not only a provider transcript');
    const recovered = new AstraDriver(fixtures, current, fixtures, sdk);
    assert.deepEqual(await recovered.resume({ sessionId, recoveryBundleRef: bundleRef }), { sessionId });
    assert.deepEqual(await recovered.invoke({ sessionId, objectiveRef: 'objective', contextRefs: [] }), { resultRef: 'invocation:2' });
    const blocked = await driver.start({ runId: 'run-2', contextRefs: [], mode: 'primary' });
    fixtures.text.set('block', 'block');
    const pending = driver.invoke({ sessionId: blocked.sessionId, objectiveRef: 'block', contextRefs: [] });
    for (let attempts = 0; attempts < 50 && !(await readFile(statePath, 'utf8').catch(() => '')); attempts += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await driver.interrupt({ sessionId: blocked.sessionId }), { observed: 'unknown' });
    await assert.rejects(pending, /AbortError|abort/i);
    const trace = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(trace[1].args.includes('resume') && trace[1].args.includes('thread-local'), 'resume uses only the observed provider thread id');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation during Astra setup prevents a provider turn and a stale guard refuses lifecycle mutation', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixtures = new Fixtures();
  const reads: string[] = [];
  const delayed: OrchestratorArtifacts = {
    async readText(ref) { reads.push(ref); if (ref === 'delayed') await gate; return fixtures.readText(ref); },
    saveInvocation: (input) => fixtures.saveInvocation(input), saveRecoveryBundle: (bundle) => fixtures.saveRecoveryBundle(bundle), loadRecoveryBundle: (ref) => fixtures.loadRecoveryBundle(ref),
  };
  const calls: string[] = [];
  const thread = { async runStreamed() { calls.push('run'); return { events: (async function* () {})() }; }, get id() { return null; } };
  const sdk = { async create() { return { startThread() { return thread; }, resumeThread() { return thread; } }; } };
  const current = { async assertCurrent() {} };
  const driver = new AstraDriver(delayed, current, fixtures, sdk as never);
  const { sessionId } = await driver.start({ runId: 'run', contextRefs: [], mode: 'primary' });
  const invoking = driver.invoke({ sessionId, objectiveRef: 'delayed', contextRefs: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(await driver.interrupt({ sessionId }), { observed: 'unknown' });
  release();
  await assert.rejects(invoking, /no longer active/);
  assert.deepEqual(calls, [], 'no provider turn starts after cancellation during local context preparation');
  const stale = new AstraDriver(fixtures, { async assertCurrent() { throw new Error('stale orchestrator lease'); } }, fixtures, sdk as never);
  await assert.rejects(stale.start({ runId: 'run', contextRefs: [], mode: 'primary' }), /stale orchestrator lease/);
  assert.deepEqual(reads, ['delayed']);
});

test('stale ownership refuses a Fable tool callback and resume cannot overwrite a newly active session', async () => {
  const claude = await import('@anthropic-ai/claude-agent-sdk');
  const fixtures = new Fixtures();
  const tools = new HelmToolRegistry([{ name: 'map.update', description: 'Mutate the Map.', input: { node: z.string() }, async execute() { return { state: 'succeeded', value: 'unexpected' }; } }]);
  let definitions: Array<{ handler(args: { node: string }, extra: unknown): Promise<unknown> }> = [];
  let fresh = true;
  const guarded = { async assertCurrent() { if (!fresh) throw new Error('stale ownership'); } };
  const fableSdk = {
    ...claude,
    createSdkMcpServer(options: Parameters<typeof claude.createSdkMcpServer>[0]) { definitions = options.tools as typeof definitions; return claude.createSdkMcpServer(options); },
    query: (() => (async function* () { yield { type: 'result', subtype: 'success', session_id: 'provider-fable' }; })()) as unknown as typeof claude.query,
  };
  const fable = new FableDriver(fixtures, tools, guarded, fixtures, { env: { PATH: process.env.PATH ?? '' } }, fableSdk);
  const fableSession = await fable.start({ runId: 'fable', contextRefs: [], mode: 'primary' });
  await fable.invoke({ sessionId: fableSession.sessionId, objectiveRef: 'objective', contextRefs: [] });
  fresh = false;
  await assert.rejects(definitions[0]!.handler({ node: 'node-1' }, {}), /stale ownership/);

  let releaseRestore!: () => void; let releaseTurn!: () => void;
  const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
  const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
  let blockTurn = false;
  const thread = {
    get id() { return 'thread-race'; },
    async runStreamed() { return { events: (async function* () { yield { type: 'thread.started', thread_id: 'thread-race' }; if (blockTurn) await turnGate; })() }; },
  };
  const sdk = { async create() { return { startThread() { return thread; }, resumeThread() { return thread; } }; } };
  const astra = new AstraDriver(fixtures, current, fixtures, sdk as never);
  const started = await astra.start({ runId: 'astra', contextRefs: [], mode: 'primary' });
  await astra.invoke({ sessionId: started.sessionId, objectiveRef: 'objective', contextRefs: [] });
  const { bundleRef } = await astra.checkpoint({ sessionId: started.sessionId });
  fixtures.restoreWait = restoreGate;
  const resuming = astra.resume({ sessionId: started.sessionId, recoveryBundleRef: bundleRef });
  await new Promise((resolve) => setTimeout(resolve, 0));
  blockTurn = true;
  const active = astra.invoke({ sessionId: started.sessionId, objectiveRef: 'objective', contextRefs: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseRestore();
  await assert.rejects(resuming, /Cannot resume active session/);
  releaseTurn();
  await active;
});
