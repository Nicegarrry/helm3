import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry } from '../src/tools.js';
import { ALL_TOOL_NAMES, CORE_TOOL_NAMES, META_TOOL_NAMES, SUPERVISOR_TOOL_NAMES } from '../src/tools.js';
import type { ToolOutcome } from '../src/types.js';
import type { Helm } from '../src/helm.js';

/** A minimal stand-in for Helm: every tool method is a spy recording its input. */
function createFakeHelm() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const ok = (extra: Record<string, unknown> = {}): ToolOutcome<unknown> => ({ ok: true, ...extra });
  const record = (method: string, extra: Record<string, unknown> = {}) => (input: unknown) => {
    calls.push({ method, input });
    return Promise.resolve(ok(extra));
  };
  const helm = {
    spawn: record('spawn', { workerId: 'w-1', branch: 'helm/w-1', worktree: '/tmp/w-1' }),
    inspect: record('inspect'),
    list: record('list', { workers: [] }),
    steer: record('steer', { turn: 2 }),
    stop: record('stop', { state: 'stopped' }),
    gate: record('gate', { head: 'sha', passed: true, checks: [] }),
    prOpen: record('prOpen', { number: 1, url: 'https://x', head: 'sha' }),
    prStatus: record('prStatus', { number: 1, state: 'open', head: 'sha', mergeable: true, checks: [], reviews: [], url: 'https://x' }),
    reviewRequest: record('reviewRequest', { reviewWorkerId: 'w-2' }),
    runStatus: (() => {
      calls.push({ method: 'runStatus', input: undefined });
      return Promise.resolve(ok({ spendUsd: 0, spendCapUsd: 0, activeWorkers: 0, maxWorkers: 3, unknownCostEvents: 0 }));
    }) as unknown as Helm['runStatus'],
    prMerge: record('prMerge', { merged: true }),
  } as unknown as Helm;
  return { helm, calls };
}

test('list() returns every tool with a description and a zod input schema', () => {
  const { helm } = createFakeHelm();
  const registry = createToolRegistry(helm);
  const tools = registry.list();
  assert.equal(tools.length, ALL_TOOL_NAMES.length);
  for (const name of ALL_TOOL_NAMES) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `missing tool: ${name}`);
    assert.equal(typeof tool?.description, 'string');
    assert.ok((tool?.description.length ?? 0) > 0);
    assert.ok((tool?.description.length ?? 0) <= 100, `${name} description is too long`);
    assert.equal(typeof tool?.inputSchema.safeParse, 'function');
  }
});

test('MCP profiles expose the requested supervisor tools plus meta tools', () => {
  const { helm } = createFakeHelm();
  const names = (profile: 'core' | 'supervisor') => createToolRegistry(helm, profile).list().map((tool) => tool.name);
  assert.deepEqual(names('core').sort(), [...CORE_TOOL_NAMES, ...META_TOOL_NAMES].sort());
  assert.deepEqual(names('supervisor').sort(), [...SUPERVISOR_TOOL_NAMES, ...META_TOOL_NAMES].sort());
});

test('helm.help returns an index or a full schema without exposing empty optional fields', async () => {
  const { helm } = createFakeHelm();
  const registry = createToolRegistry(helm, 'core');
  const index = await registry.call('helm.help', {});
  assert.equal(index.ok, true);
  if (index.ok) {
    assert.match(String(index.index), /^worker\.spawn:/m);
    assert.doesNotMatch(String(index.index), /undefined/);
  }
  const help = await registry.call('helm.help', { tool: 'worker.spawn' });
  assert.equal(help.ok, true);
  if (help.ok) {
    assert.equal(help.tool, 'worker.spawn');
    assert.equal(typeof help.description, 'string');
    assert.equal(typeof help.inputSchema, 'object');
  }
});

test('call() rejects an unknown tool name', async () => {
  const { helm } = createFakeHelm();
  const registry = createToolRegistry(helm);
  const outcome = await registry.call('worker.nope', {});
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /unknown tool/);
});

test('call() rejects input that fails schema validation', async () => {
  const { helm } = createFakeHelm();
  const registry = createToolRegistry(helm);
  const outcome = await registry.call('worker.spawn', { repo: '/x' }); // missing objective
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.reason, /invalid input/);
});

test('call() validates and dispatches a valid call to the matching Helm method', async () => {
  const { helm, calls } = createFakeHelm();
  const registry = createToolRegistry(helm);

  const spawnOutcome = await registry.call('worker.spawn', { repo: '/abs/repo', objective: 'do it', model: 'acme/m' });
  assert.equal(spawnOutcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'spawn');
  assert.deepEqual(calls[0]?.input, { repo: '/abs/repo', objective: 'do it', model: 'acme/m', role: 'builder', contextPaths: [], allowWorkflows: false });

  const statusOutcome = await registry.call('run.status', {});
  assert.equal(statusOutcome.ok, true);
  assert.equal(calls.at(-1)?.method, 'runStatus');

  const mergeOutcome = await registry.call('pr.merge', { number: 1, expectedHead: 'a'.repeat(40) });
  assert.equal(mergeOutcome.ok, true);
  assert.equal(calls.at(-1)?.method, 'prMerge');
});

test('helm.call reuses direct validation and dispatch', async () => {
  const { helm, calls } = createFakeHelm();
  const registry = createToolRegistry(helm, 'core');
  const outcome = await registry.call('helm.call', { tool: 'run.status', input: {} });
  assert.equal(outcome.ok, true);
  assert.equal(calls.at(-1)?.method, 'runStatus');
  const refused = await registry.call('helm.call', { tool: 'worker.spawn', input: { repo: '/repo' } });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /invalid input/);
});

test('helm.call preserves lifecycle admission refusals', async () => {
  const { helm } = createFakeHelm();
  const admitted: string[] = [];
  const guardedHelm = { ...helm, lifecycle: { admit(name: string) { admitted.push(name); throw new Error('admission refused'); } } } as unknown as Helm;
  const registry = createToolRegistry(guardedHelm, 'core');
  const input = { repo: '/repo', objective: 'task' };
  const direct = await registry.call('worker.spawn', input);
  const throughCall = await registry.call('helm.call', { tool: 'worker.spawn', input });
  assert.deepEqual(throughCall, direct);
  assert.deepEqual(admitted, ['worker.spawn', 'worker.spawn']);
});

test('worker.list stays compact with a large worker store', async () => {
  const { helm } = createFakeHelm();
  const workers = Array.from({ length: 200 }, (_, index) => ({ workerId: `w-${index}`, state: 'running', model: 'provider/model', head: 'a'.repeat(40) }));
  helm.list = (async () => ({ ok: true, workers })) as unknown as Helm['list'];
  const result = await createToolRegistry(helm, 'core', true).call('helm.call', { tool: 'worker.list', input: {} });
  assert.equal(result.ok, true);
  assert.ok(JSON.stringify(result).length <= 3_000);
  if (result.ok) {
    const workers = result.workers as string[];
    assert.equal(workers.length, 31);
    assert.equal(workers.at(-1), '+170 more');
  }
});

test('worker.inspect defaults to five bounded events and a one-line diff stat', async () => {
  const { helm } = createFakeHelm();
  helm.inspect = (async () => ({
    ok: true, state: 'running', model: 'provider/model', branch: 'helm/test', head: 'a'.repeat(40), spendUsd: 1, tokens: 2,
    diffStat: `10 files changed\n${'large detail '.repeat(100)}`,
    result: { status: 'partial', summary: 'summary' },
    events: Array.from({ length: 20 }, (_, seq) => ({ seq, at: 'now', kind: 'event', data: { payload: 'x'.repeat(500) } })),
  })) as unknown as Helm['inspect'];
  const result = await createToolRegistry(helm, 'core', true).call('worker.inspect', { workerId: 'w-1' });
  assert.equal(result.ok, true);
  assert.ok(JSON.stringify(result).length <= 3_000);
  if (result.ok) {
    const events = result.events as Array<{ data: string }>;
    assert.equal(events.length, 5);
    assert.ok(events.every((event) => event.data.length <= 200));
    assert.doesNotMatch(String(result.diffStat), /\n/);
  }
});

test('wake.list renders object summaries as bounded readable strings', async () => {
  const { helm } = createFakeHelm();
  helm.wakeList = (async () => ({ ok: true, wakes: [{ kind: 'watch.alert', workerId: 'w-1', summary: { message: 'attention', details: 'x'.repeat(300) } }] })) as unknown as Helm['wakeList'];
  const result = await createToolRegistry(helm, 'core', true).call('wake.list', { project: 'acme/widgets' });
  assert.equal(result.ok, true);
  if (result.ok) {
    const wakes = result.wakes as string[];
    assert.equal(wakes.length, 1);
    const wake = wakes[0];
    assert.ok(wake);
    assert.ok(wake.length <= 160);
    assert.doesNotMatch(wake, /\[object Object\]/);
  }
});


test('routing inputs accept omitted worker models and reject invalid difficulty before dispatch', async () => {
  const { helm, calls } = createFakeHelm();
  const registry = createToolRegistry(helm);
  assert.equal((await registry.call('worker.spawn', { repo: '/repo', objective: 'task', difficulty: 'super-easy' })).ok, true);
  assert.equal((await registry.call('review.request', { workerId: 'w-1' })).ok, true);
  assert.equal((await registry.call('worker.spawn', { repo: '/repo', objective: 'task', difficulty: 'unknown' })).ok, false);
  assert.equal((await registry.call('worker.spawn', { repo: '/repo', objective: 'task', model: '' })).ok, false);
  assert.equal(calls.length, 2);
});
