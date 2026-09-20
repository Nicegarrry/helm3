import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolRegistry } from '../src/tools.js';
import { TOOL_NAMES } from '../src/types.js';
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

test('list() returns all eleven tools with a description and a zod input schema', () => {
  const { helm } = createFakeHelm();
  const registry = createToolRegistry(helm);
  const tools = registry.list();
  assert.equal(tools.length, TOOL_NAMES.length);
  for (const name of TOOL_NAMES) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `missing tool: ${name}`);
    assert.equal(typeof tool?.description, 'string');
    assert.ok((tool?.description.length ?? 0) > 0);
    assert.equal(typeof tool?.inputSchema.safeParse, 'function');
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
  const outcome = await registry.call('worker.spawn', { repo: '/x' }); // missing objective and model
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
