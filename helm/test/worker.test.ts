import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { piWorkerRunner, parseWorkerResult } from '../src/worker.js';
import type { EventRow, WorkerHooks, WorkerRunInput, WorkerResult } from '../src/types.js';

const exec = promisify(execFile);

async function makeWorktree(): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), 'helm-worker-test-'));
  const worktree = join(root, 'worktree');
  await mkdir(worktree, { recursive: true });
  await exec('git', ['init', worktree]);
  await exec('git', ['-C', worktree, 'config', 'user.email', 'test@example.invalid']);
  await exec('git', ['-C', worktree, 'config', 'user.name', 'Test']);
  await mkdir(join(worktree, '.github', 'workflows'), { recursive: true });
  await exec('git', ['-C', worktree, 'add', '-A']);
  await exec('git', ['-C', worktree, 'commit', '-m', 'base', '--allow-empty']);
  return { root, worktree };
}

async function makeFaux(providerId: string) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
    credentials: new ai.InMemoryCredentialStore(),
  });
  const faux = ai.fauxProvider({ provider: providerId, models: [{ id: 'offline', cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 } }] });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(providerId, 'fixture');
  return { modelRuntime, faux, ai, model: `${providerId}/offline` };
}

function collectHooks(): { hooks: WorkerHooks; events: EventRow[] } {
  const events: EventRow[] = [];
  const hooks: WorkerHooks = {
    emit: (kind, data) => {
      events.push({ seq: events.length, workerId: 'w-test', at: new Date().toISOString(), kind, data: data ?? {} });
    },
    onUsage: (usage) => {
      events.push({ seq: events.length, workerId: 'w-test', at: new Date().toISOString(), kind: 'usage', data: { ...usage } });
    },
    shouldContinue: () => true,
  };
  return { hooks, events };
}

function baseInput(partial: Partial<WorkerRunInput> & Pick<WorkerRunInput, 'worktree' | 'model' | 'sessionDir'>): WorkerRunInput {
  return {
    workerId: 'w-test',
    role: 'builder',
    objective: 'do the thing',
    acceptance: null,
    contextPaths: [],
    allowWorkflows: false,
    sessionFile: null,
    ...partial,
  };
}

const validResult: WorkerResult = {
  status: 'succeeded',
  summary: 'did the thing',
  changedFiles: ['hello.txt'],
  commandsRun: [],
};

test('valid JSON result parses and usage is emitted with numeric tokens', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-a');
    faux.setResponses([ai.fauxAssistantMessage(JSON.stringify(validResult))]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    const outcome = await runner.run(input, 'do the thing', hooks);

    assert.deepEqual(outcome.result, validResult);
    const usageEvents = events.filter((e) => e.kind === 'usage');
    assert.equal(usageEvents.length, 1);
    const usage = usageEvents[0]!.data;
    assert.equal(typeof usage.inputTokens, 'number');
    assert.equal(typeof usage.outputTokens, 'number');
    assert.ok((usage.inputTokens as number) > 0);
    assert.equal(typeof usage.costUsd, 'number');
    assert.ok((usage.costUsd as number) > 0);
    assert.ok(events.some((e) => e.kind === 'result'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed first reply then valid JSON after correction turn', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-b');
    faux.setResponses([ai.fauxAssistantMessage('sure, working on it now'), ai.fauxAssistantMessage(JSON.stringify(validResult))]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    const outcome = await runner.run(input, 'do the thing', hooks);

    assert.deepEqual(outcome.result, validResult);
    const turnStarts = events.filter((e) => e.kind === 'turn.start');
    assert.equal(turnStarts.length, 2);
    const turnEnds = events.filter((e) => e.kind === 'turn.end');
    assert.equal(turnEnds.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a write outside the worktree is refused and the file is never created', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-c');
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxToolCall('write', { path: '../outside.txt', content: 'x' })]),
      ai.fauxAssistantMessage(JSON.stringify({ status: 'failed', summary: 'refused', changedFiles: [], commandsRun: [] })),
    ]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    await runner.run(input, 'do the thing', hooks);

    const refused = events.filter((e) => e.kind === 'tool.refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.data.tool, 'write');
    assert.equal(existsSync(join(root, 'outside.txt')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a git push bash command is refused', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-d');
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxToolCall('bash', { command: 'git push origin main' })]),
      ai.fauxAssistantMessage(JSON.stringify({ status: 'failed', summary: 'refused', changedFiles: [], commandsRun: [] })),
    ]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    await runner.run(input, 'do the thing', hooks);

    const refused = events.filter((e) => e.kind === 'tool.refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.data.tool, 'bash');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a write inside the worktree succeeds and emits tool.call', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-e');
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxToolCall('write', { path: 'hello.txt', content: 'hi' })]),
      ai.fauxAssistantMessage(JSON.stringify(validResult)),
    ]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    await runner.run(input, 'do the thing', hooks);

    const calls = events.filter((e) => e.kind === 'tool.call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.data.tool, 'write');
    assert.equal(existsSync(join(worktree, 'hello.txt')), true);
    assert.equal(await readFile(join(worktree, 'hello.txt'), 'utf8'), 'hi');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reviewer role refuses edit/write and write-like bash', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-f');
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxToolCall('bash', { command: 'rm -rf build' })]),
      ai.fauxAssistantMessage(JSON.stringify({ status: 'succeeded', summary: 'APPROVE: looks fine', changedFiles: [], commandsRun: [] })),
    ]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions'), role: 'reviewer' });
    await runner.run(input, 'review it', hooks);

    const refused = events.filter((e) => e.kind === 'tool.refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.data.tool, 'bash');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('still-invalid text after correction turn returns a null result with raw text saved', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-g');
    faux.setResponses([ai.fauxAssistantMessage('nope, still prose'), ai.fauxAssistantMessage('still not json')]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    const outcome = await runner.run(input, 'do the thing', hooks);

    assert.equal(outcome.result, null);
    assert.equal(outcome.rawText, 'still not json');
    assert.ok(events.some((e) => e.kind === 'result.invalid'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseWorkerResult: strict JSON, fenced JSON (last wins), and invalid input', () => {
  assert.deepEqual(parseWorkerResult(JSON.stringify(validResult)), validResult);

  const fenced = ['prose before', '```json', JSON.stringify(validResult), '```'].join('\n');
  assert.deepEqual(parseWorkerResult(fenced), validResult);

  const other: WorkerResult = { ...validResult, summary: 'second' };
  const twoFences = ['```json', JSON.stringify({ ...validResult, summary: 'first' }), '```', 'then', '```json', JSON.stringify(other), '```'].join('\n');
  assert.deepEqual(parseWorkerResult(twoFences), other);

  assert.equal(parseWorkerResult('not json at all'), null);
  assert.equal(parseWorkerResult('{"status":"succeeded"}'), null);
  assert.equal(parseWorkerResult(JSON.stringify({ ...validResult, extra: 'field' })), null);
});
