import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { piWorkerRunner, parseWorkerResult, classifyBash, defaultModelRuntime } from '../src/worker.js';
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
    onSession: (sessionFile) => {
      events.push({ seq: events.length, workerId: 'w-test', at: new Date().toISOString(), kind: 'session', data: { sessionFile } });
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

test('F4: a symlink inside the worktree to another dir does not let a not-yet-existing write escape', async () => {
  const { root, worktree } = await makeWorktree();
  const outsideDir = await mkdtemp(join(tmpdir(), 'helm-worker-outside-'));
  try {
    await symlink(outsideDir, join(worktree, 'evil'));
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-symlink');
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxToolCall('write', { path: 'evil/x.txt', content: 'x' })]),
      ai.fauxAssistantMessage(JSON.stringify({ status: 'failed', summary: 'refused', changedFiles: [], commandsRun: [] })),
    ]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    await runner.run(input, 'do the thing', hooks);

    const refused = events.filter((e) => e.kind === 'tool.refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.data.tool, 'write');
    assert.equal(existsSync(join(outsideDir, 'x.txt')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('F11: cd to a quoted absolute path outside the worktree is refused (double and single quotes)', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-cdquoted');
    faux.setResponses([
      ai.fauxAssistantMessage([ai.fauxToolCall('bash', { command: 'cd "/etc" && ls' })]),
      ai.fauxAssistantMessage([ai.fauxToolCall('bash', { command: "cd '/etc' && ls" })]),
      ai.fauxAssistantMessage(JSON.stringify({ status: 'failed', summary: 'refused', changedFiles: [], commandsRun: [] })),
    ]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    await runner.run(input, 'do the thing', hooks);

    const refused = events.filter((e) => e.kind === 'tool.refused');
    assert.equal(refused.length, 2);
    for (const event of refused) {
      assert.equal(event.data.tool, 'bash');
      assert.match(String(event.data.reason), /cd to an absolute path outside the worktree/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F9: shouldContinue()=false skips the correction turn and returns a null result with the first raw text', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-shouldcontinue');
    faux.setResponses([ai.fauxAssistantMessage('not json, still prose')]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    let continueCalls = 0;
    const noCorrectionHooks: WorkerHooks = { ...hooks, shouldContinue: () => { continueCalls++; return false; } };
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    const outcome = await runner.run(input, 'do the thing', noCorrectionHooks);

    assert.equal(outcome.result, null);
    assert.equal(outcome.rawText, 'not json, still prose');
    assert.equal(continueCalls, 1);
    assert.equal(events.filter((e) => e.kind === 'turn.start').length, 1);
    assert.ok(events.some((e) => e.kind === 'result.invalid'));
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

test('F10: parseWorkerResult tries fences from last to first, skipping a later fence that does not validate', () => {
  const unrelated = JSON.stringify({ foo: 'bar', not: 'a worker result' });
  const text = ['```json', JSON.stringify(validResult), '```', 'then some other unrelated json:', '```json', unrelated, '```'].join('\n');
  assert.deepEqual(parseWorkerResult(text), validResult);
});

test('F5: classifyBash denies git commands bypassed with inserted flags', () => {
  const denied = [
    'git push origin main',
    'git -C .. push',
    'git --no-pager push',
    'git -C ../.. worktree remove x',
    'git -C .. checkout main',
    'echo hi && git push',
  ];
  for (const command of denied) {
    const verdict = classifyBash(command, 'builder');
    assert.equal(verdict.allowed, false, `expected "${command}" to be denied`);
  }
});

test('F5: classifyBash allows plain git reads and checkout -- <path>', () => {
  const allowed = ['git status', 'git log -3', 'git checkout -- file.txt', 'git -C . diff'];
  for (const command of allowed) {
    const verdict = classifyBash(command, 'builder');
    assert.equal(verdict.allowed, true, `expected "${command}" to be allowed, got: ${verdict.reason}`);
  }
});

test('F5: classifyBash denies reviewer git writes (commit/add/reset/rebase/merge/push) even behind -C', () => {
  for (const sub of ['commit', 'add', 'reset', 'rebase', 'merge', 'push']) {
    const verdict = classifyBash(`git -C . ${sub}`, 'reviewer');
    assert.equal(verdict.allowed, false, `expected reviewer "git ${sub}" to be denied`);
  }
  assert.equal(classifyBash('git -C . status', 'reviewer').allowed, true);
});

test('F5: classifyBash still denies gh and rm -rf /', () => {
  assert.equal(classifyBash('gh pr create', 'builder').allowed, false);
  assert.equal(classifyBash('rm -rf /', 'builder').allowed, false);
});

test('defaultModelRuntime loads the operator models.json so configured providers resolve', async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'helm-agent-dir-'));
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'helm-test-provider': {
          baseUrl: 'https://example.invalid/v1',
          api: 'openai-completions',
          apiKey: 'test-key',
          models: [{ id: 'configured-model', name: 'Configured Model', contextWindow: 1000, maxTokens: 100 }],
        },
      },
    }),
  );

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const runtime = await defaultModelRuntime();
    const model = runtime.getModel('helm-test-provider', 'configured-model');
    assert.ok(model, 'a provider configured only in models.json must resolve');
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test('the Pi session file is reported as soon as it is opened, before any model traffic', async () => {
  const { root, worktree } = await makeWorktree();
  try {
    const { modelRuntime, ai, faux, model } = await makeFaux('helm-worker-session');
    faux.setResponses([ai.fauxAssistantMessage(JSON.stringify(validResult))]);
    const runner = piWorkerRunner({ modelRuntime });
    const { hooks, events } = collectHooks();
    const input = baseInput({ worktree, model, sessionDir: join(root, 'sessions') });
    const outcome = await runner.run(input, 'do the thing', hooks);

    const sessionEvents = events.filter((e) => e.kind === 'session');
    assert.equal(sessionEvents.length, 1, 'onSession fires exactly once');
    const reported = sessionEvents[0]!.data.sessionFile as string;
    assert.ok(reported, 'a session file path is reported');
    assert.equal(outcome.sessionFile, reported, 'it is the same file the outcome reports');

    // Ordering is the point: a turn that is killed never reaches its usage or result events, so
    // the session must already have been reported by then.
    const firstUsage = events.findIndex((e) => e.kind === 'usage');
    assert.ok(firstUsage >= 0, 'the turn produced usage');
    assert.ok(sessionEvents[0]!.seq < firstUsage, 'the session is reported before any usage');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
