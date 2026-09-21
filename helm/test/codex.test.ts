import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_SESSION_PREFIX, codexArgs, codexWorkerRunner, defaultCodexBin, laneRunner, parseCodexModel } from '../src/codex.js';
import { CORRECTION_MESSAGE } from '../src/worker.js';
import { RESULT_INSTRUCTION } from '../src/prompt.js';
import type { EventRow, WorkerHooks, WorkerRunInput, WorkerRunner } from '../src/types.js';

/**
 * A stand-in for the real `codex` binary: records argv, stdin and cwd to FAKE_CODEX_RECORD,
 * then plays the JSONL a real `codex exec --json` run produces (shapes copied from a live
 * probe on codex-cli 0.153.4). FAKE_CODEX_MODE picks the ending.
 */
const FAKE_CODEX = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
appendFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, stdin, cwd: process.cwd() }) + '\\n');
const mode = process.env.FAKE_CODEX_MODE ?? 'ok';
const isResume = args[1] === 'resume';
const lastFile = args[args.indexOf('-o') + 1];
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ type: 'thread.started', thread_id: isResume ? args[2] : 'thread-1' });
emit({ type: 'item.completed', item: { id: 'i0', type: 'error', message: 'loading hooks from both places' } });
emit({ type: 'turn.started' });
emit({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: '/bin/zsh -lc "npm test"', aggregated_output: 'ok', exit_code: 0, status: 'completed' } });
emit({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: '/wt/a.ts', kind: 'update' }] } });
if (mode === 'hang') { setTimeout(() => {}, 60000); }
else if (mode === 'fail') { process.stderr.write('codex: not logged in\\n'); process.exit(2); }
else {
  const ok = JSON.stringify({ status: 'succeeded', summary: 'did it', changedFiles: ['a.ts'], commandsRun: ['npm test'] });
  const text = mode === 'malformed-first' && !isResume ? 'not json at all' : ok;
  emit({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10 } });
  writeFileSync(lastFile, text);
  if (mode === 'answer-then-fail') { process.stderr.write('late failure\\n'); process.exit(3); }
}
`;

async function fixture(mode: string, extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'helm-codex-test-'));
  const bin = join(root, 'codex.mjs');
  await writeFile(bin, FAKE_CODEX);
  await chmod(bin, 0o755);
  const worktree = join(root, 'wt');
  await mkdir(worktree);
  const record = join(root, 'record.jsonl');
  const env = { ...process.env, FAKE_CODEX_RECORD: record, FAKE_CODEX_MODE: mode, ...extraEnv };
  const runner = codexWorkerRunner({ bin, env });
  const calls = async () => (await readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; stdin: string; cwd: string });
  return { root, worktree, runner, calls, sessionDir: join(root, 'sessions', 'w-1') };
}

function collectHooks(shouldContinue: () => boolean = () => true): { hooks: WorkerHooks; events: EventRow[]; sessions: string[] } {
  const events: EventRow[] = [];
  const sessions: string[] = [];
  const push = (kind: string, data: Record<string, unknown>) => events.push({ seq: events.length, workerId: 'w-1', at: new Date().toISOString(), kind, data });
  const hooks: WorkerHooks = {
    emit: (kind, data) => push(kind, data ?? {}),
    onUsage: (usage) => push('usage', { ...usage }),
    onSession: (sessionFile) => { sessions.push(sessionFile); },
    shouldContinue,
  };
  return { hooks, events, sessions };
}

function input(partial: Partial<WorkerRunInput> & Pick<WorkerRunInput, 'worktree' | 'sessionDir'>): WorkerRunInput {
  return { workerId: 'w-1', role: 'builder', model: 'codex/gpt-6-astra:medium', objective: 'do it', acceptance: null, contextPaths: [], allowWorkflows: false, sessionFile: null, ...partial };
}

test('parseCodexModel: codex/<model>[:<effort>], anything else is not this lane', () => {
  assert.deepEqual(parseCodexModel('codex/gpt-6-astra:medium'), { model: 'gpt-6-astra', effort: 'medium' });
  assert.deepEqual(parseCodexModel('codex/gpt-5.6-terra'), { model: 'gpt-5.6-terra' });
  assert.equal(parseCodexModel('opencode-go/gpt-5.6-luna'), null);
  assert.equal(parseCodexModel('codex/'), null);
  assert.equal(parseCodexModel('codex/:high'), null);
  assert.equal(parseCodexModel('codex/gpt-6-astra:'), null);
});

test('codexArgs: builders get workspace-write with -C, reviewers read-only, resume drops -C and names the thread', () => {
  const build = codexArgs({ role: 'builder', worktree: '/wt' }, { model: 'gpt-6-astra', effort: 'xhigh' }, null, '/s/last.md', false);
  assert.equal(build[0], 'exec');
  assert.ok(build.includes('sandbox_mode="workspace-write"'));
  assert.ok(build.includes('model_reasoning_effort="xhigh"'));
  assert.deepEqual(build.slice(-3), ['-C', '/wt', '-']);
  assert.ok(!build.includes('sandbox_workspace_write.network_access=true'), 'network is off unless asked for');
  const review = codexArgs({ role: 'reviewer', worktree: '/wt' }, { model: 'gpt-5.6-terra' }, null, '/s/last.md', true);
  assert.ok(review.includes('sandbox_mode="read-only"'));
  assert.ok(!review.some((a) => a.startsWith('model_reasoning_effort')), 'no effort flag when none was named');
  assert.ok(!review.includes('sandbox_workspace_write.network_access=true'), 'network never applies to a read-only reviewer');
  const net = codexArgs({ role: 'builder', worktree: '/wt' }, { model: 'gpt-6-astra' }, null, '/s/last.md', true);
  assert.ok(net.includes('sandbox_workspace_write.network_access=true'));
  const resume = codexArgs({ role: 'builder', worktree: '/wt' }, { model: 'gpt-6-astra' }, 'abc-123', '/s/last.md', false);
  assert.deepEqual(resume.slice(0, 3), ['exec', 'resume', 'abc-123']);
  assert.ok(!resume.includes('-C'), 'exec resume does not take -C');
  assert.ok(resume.includes('-m') && resume[resume.indexOf('-m') + 1] === 'gpt-6-astra', 'resume must name the model or Codex falls back to its config default');
});

test('run: a builder turn maps Codex events onto Helm events, records subscription usage at $0 and returns the parsed result', async () => {
  const f = await fixture('ok');
  const { hooks, events, sessions } = collectHooks();
  const outcome = await f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks);
  assert.equal(outcome.result?.status, 'succeeded');
  assert.equal(outcome.sessionFile, `${CODEX_SESSION_PREFIX}thread-1`);
  assert.deepEqual(sessions, [`${CODEX_SESSION_PREFIX}thread-1`]);
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['turn.start', 'notice', 'tool.call', 'tool.call', 'usage', 'turn.end', 'result']);
  assert.deepEqual(events[2]!.data, { tool: 'bash', summary: '/bin/zsh -lc "npm test"', exitCode: 0 });
  assert.deepEqual(events[3]!.data, { tool: 'edit', summary: '/wt/a.ts' });
  assert.deepEqual(events[4]!.data, { model: 'codex/gpt-6-astra:medium', inputTokens: 600, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0, costUsd: 0 });
  const [call] = await f.calls();
  assert.equal(await realpath(call!.cwd), await realpath(f.worktree));
  assert.deepEqual(call!.args.slice(0, 4), ['exec', '--json', '-m', 'gpt-6-astra']);
  assert.ok(call!.args.includes('model_reasoning_effort="medium"'));
  assert.ok(call!.stdin.startsWith('Add the flag\n\n') && call!.stdin.endsWith(RESULT_INSTRUCTION), 'prompt and result instruction go in on stdin');
});

test('run: a worker with a recorded thread resumes it instead of starting a new session', async () => {
  const f = await fixture('ok');
  const { hooks } = collectHooks();
  const outcome = await f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir, sessionFile: `${CODEX_SESSION_PREFIX}abc-123` }), 'Fix the review findings', hooks);
  assert.equal(outcome.sessionFile, `${CODEX_SESSION_PREFIX}abc-123`);
  const [call] = await f.calls();
  assert.deepEqual(call!.args.slice(0, 3), ['exec', 'resume', 'abc-123']);
});

test('run: a malformed final message gets exactly one correction turn, on the same thread', async () => {
  const f = await fixture('malformed-first');
  const { hooks, events } = collectHooks();
  const outcome = await f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks);
  assert.equal(outcome.result?.status, 'succeeded');
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.args.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.ok(calls[1]!.stdin.startsWith(CORRECTION_MESSAGE));
  assert.equal(events.filter((e) => e.kind === 'turn.start').length, 2);
});

test('run: a non-zero exit with no message is an error carrying the stderr tail', async () => {
  const f = await fixture('fail');
  const { hooks } = collectHooks();
  await assert.rejects(f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks), /codex exited 2: codex: not logged in/);
});

test('run: a binary that cannot start is an error naming it, never an unhandled child error', async () => {
  const f = await fixture('ok');
  const runner = codexWorkerRunner({ bin: join(f.root, 'no-such-codex'), env: process.env });
  const { hooks } = collectHooks();
  await assert.rejects(runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks), /codex could not start \(.*no-such-codex\): .*ENOENT/);
});

test('run: an answer followed by a non-zero exit is still an error, naming the exit and the stderr tail', async () => {
  const f = await fixture('answer-then-fail');
  const { hooks } = collectHooks();
  await assert.rejects(f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks), /codex exited 3 after answering: late failure/);
});

test('run: a stop request kills a worker that is silent in a long command, and yields a null result, not an error', async () => {
  const f = await fixture('hang'); // emits its events, then produces nothing for 60 s
  let asked = false;
  setTimeout(() => { asked = true; }, 800); // the request arrives after the last event has been read
  const { hooks, events } = collectHooks(() => !asked);
  const started = Date.now();
  const outcome = await f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks);
  assert.ok(Date.now() - started < 5000, 'the timer poll killed it without waiting for another event');
  assert.equal(outcome.result, null);
  assert.ok(events.some((e) => e.kind === 'result.invalid'));
  assert.equal(events.filter((e) => e.kind === 'turn.start').length, 1, 'no correction turn after a stop');
});

test('laneRunner routes codex/ models to the Codex lane and everything else to Pi', async () => {
  const seen: string[] = [];
  const lane = (name: string): WorkerRunner => ({ run: async (i) => { seen.push(`${name}:${i.model}`); return { result: null, rawText: '', sessionFile: null }; } });
  const runner = laneRunner({ pi: lane('pi'), codex: lane('codex') });
  const { hooks } = collectHooks();
  await runner.run(input({ worktree: '/wt', sessionDir: '/s', model: 'codex/gpt-5.6-luna' }), 'x', hooks);
  await runner.run(input({ worktree: '/wt', sessionDir: '/s', model: 'opencode-go/qwen3.8-flash' }), 'x', hooks);
  assert.deepEqual(seen, ['codex:codex/gpt-5.6-luna', 'pi:opencode-go/qwen3.8-flash']);
});

test('defaultCodexBin honours HELM_CODEX_BIN', () => {
  assert.equal(defaultCodexBin({ HELM_CODEX_BIN: '/opt/codex' }), '/opt/codex');
  assert.ok(defaultCodexBin({}).endsWith('codex'));
});
