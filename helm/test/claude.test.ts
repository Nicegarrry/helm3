import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_SESSION_PREFIX, available, claudeArgs, claudeWorkerRunner, parseClaudeModel } from '../src/claude.js';
import { CORRECTION_MESSAGE } from '../src/worker.js';
import { RESULT_INSTRUCTION } from '../src/prompt.js';
import { laneRunner } from '../src/codex.js';
import type { EventRow, WorkerHooks, WorkerRunInput, WorkerRunner } from '../src/types.js';

const FAKE_CLAUDE = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
appendFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ args, stdin, cwd: process.cwd(), env: process.env }) + '\\n');
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const resume = args.includes('--resume');
const session = resume ? args[args.indexOf('--resume') + 1] : 'session-1';
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: session });
emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
if (mode === 'hang') { setTimeout(() => {}, 60000); }
else if (mode === 'fail') { process.stderr.write('claude: not logged in\\n'); process.exit(2); }
else {
  const ok = JSON.stringify({ status: 'succeeded', summary: 'did it', changedFiles: ['a.ts'], commandsRun: ['npm test'] });
  const text = mode === 'malformed-first' && !resume ? 'not json at all' : ok;
  emit({ type: 'result', subtype: 'success', session_id: session, result: text, usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 10 } });
}
`;

async function fixture(mode: string, extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'helm-claude-test-'));
  const bin = join(root, 'claude.mjs');
  await writeFile(bin, FAKE_CLAUDE);
  await chmod(bin, 0o755);
  const worktree = join(root, 'wt');
  await mkdir(worktree);
  const record = join(root, 'record.jsonl');
  const env = {
    ...process.env,
    FAKE_CLAUDE_RECORD: record,
    FAKE_CLAUDE_MODE: mode,
    HELM_HOME: '/secret/helm',
    HELM_SPEND_CAP_USD: '99',
    CG_API_KEY: 'cg-secret',
    DISCORD_WEBHOOK_URL: 'https://secret.invalid/webhook',
    ...extraEnv,
  };
  const runner = claudeWorkerRunner({ bin, env });
  const calls = async () => (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; stdin: string; cwd: string; env: NodeJS.ProcessEnv });
  return { root, bin, worktree, runner, calls, sessionDir: join(root, 'sessions', 'w-1') };
}

function collectHooks(shouldContinue: () => boolean = () => true): { hooks: WorkerHooks; events: EventRow[]; sessions: string[] } {
  const events: EventRow[] = [];
  const sessions: string[] = [];
  const push = (kind: string, data: Record<string, unknown>) => events.push({ seq: events.length, workerId: 'w-1', at: new Date().toISOString(), kind, data });
  return {
    hooks: { emit: (kind, data) => push(kind, data ?? {}), onUsage: (usage) => push('usage', { ...usage }), onSession: (file) => sessions.push(file), shouldContinue },
    events,
    sessions,
  };
}

function input(partial: Partial<WorkerRunInput> & Pick<WorkerRunInput, 'worktree' | 'sessionDir'>): WorkerRunInput {
  return { workerId: 'w-1', role: 'builder', model: 'claude/sonnet:high', objective: 'do it', acceptance: null, contextPaths: [], allowWorkflows: false, sessionFile: null, ...partial };
}

test('parseClaudeModel: claude/<model>[:<effort>], anything else is not this lane', () => {
  assert.deepEqual(parseClaudeModel('claude/sonnet:high'), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(parseClaudeModel('claude/fable'), { model: 'fable' });
  assert.equal(parseClaudeModel('codex/gpt-6-astra:medium'), null);
  assert.equal(parseClaudeModel('claude/'), null);
  assert.equal(parseClaudeModel('claude/:high'), null);
  assert.equal(parseClaudeModel('claude/opus:'), null);
});

test('claudeArgs: permissions, worktree directory, model effort, and resume are explicit', () => {
  const build = claudeArgs({ role: 'builder', worktree: '/wt' }, { model: 'sonnet', effort: 'high' }, null);
  assert.deepEqual(build.slice(0, 5), ['-p', '--model', 'sonnet', '--effort', 'high']);
  assert.ok(build.includes('--output-format') && build[build.indexOf('--output-format') + 1] === 'stream-json');
  assert.ok(build.includes('--verbose'));
  assert.ok(build.includes('--permission-mode') && build[build.indexOf('--permission-mode') + 1] === 'acceptEdits');
  assert.ok(build.includes('--allowedTools') && build[build.indexOf('--allowedTools') + 1] === 'Read,Edit,Write,Glob,Grep,Bash');
  assert.equal(build.filter((arg) => arg === '--add-dir').length, 1);
  assert.equal(build[build.indexOf('--add-dir') + 1], '/wt');
  assert.ok(!build.some((arg) => /bypass|skip-permissions|dangerously/i.test(arg)));

  const review = claudeArgs({ role: 'reviewer', worktree: '/wt' }, { model: 'opus' }, 'session-1');
  assert.ok(review.includes('--resume') && review[review.indexOf('--resume') + 1] === 'session-1');
  assert.equal(review[review.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(review[review.indexOf('--allowedTools') + 1], 'Read,Glob,Grep');
  assert.ok(!review[review.indexOf('--allowedTools') + 1]!.includes('Edit'));
  assert.ok(review.includes('Bash'), 'reviewer Bash is explicitly disallowed, not allowed');
});

test('run: stream-json result, session id, subscription usage and sanitized environment are recorded', async () => {
  const f = await fixture('ok');
  const { hooks, events, sessions } = collectHooks();
  const outcome = await f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks);
  assert.deepEqual(outcome.result, { status: 'succeeded', summary: 'did it', changedFiles: ['a.ts'], commandsRun: ['npm test'] });
  assert.equal(outcome.sessionFile, `${CLAUDE_SESSION_PREFIX}session-1`);
  assert.deepEqual(sessions, [`${CLAUDE_SESSION_PREFIX}session-1`]);
  assert.deepEqual(events.map((event) => event.kind), ['turn.start', 'tool.call', 'usage', 'turn.end', 'result']);
  assert.deepEqual(events[2]!.data, { model: 'claude/sonnet:high', inputTokens: 1000, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 10, costUsd: 0 });
  const [call] = await f.calls();
  assert.equal(await realpath(call!.cwd), await realpath(f.worktree));
  assert.ok(call!.stdin.startsWith('Add the flag\n\n') && call!.stdin.endsWith(RESULT_INSTRUCTION));
  assert.equal(call!.env.HELM_HOME, undefined);
  assert.equal(call!.env.HELM_SPEND_CAP_USD, undefined);
  assert.equal(call!.env.CG_API_KEY, undefined);
  assert.equal(call!.env.DISCORD_WEBHOOK_URL, undefined);
});

test('run: a recorded Claude session resumes with --resume', async () => {
  const f = await fixture('ok');
  const { hooks } = collectHooks();
  const outcome = await f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir, sessionFile: `${CLAUDE_SESSION_PREFIX}session-previous` }), 'Fix it', hooks);
  assert.equal(outcome.sessionFile, `${CLAUDE_SESSION_PREFIX}session-previous`);
  const [call] = await f.calls();
  assert.deepEqual(call!.args.slice(-2), ['--resume', 'session-previous']);
});

test('run: malformed final message gets one correction turn on the same session', async () => {
  const f = await fixture('malformed-first');
  const { hooks, events } = collectHooks();
  const outcome = await f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks);
  assert.equal(outcome.result?.status, 'succeeded');
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.args.slice(-2), ['--resume', 'session-1']);
  assert.ok(calls[1]!.stdin.startsWith(CORRECTION_MESSAGE));
  assert.equal(events.filter((event) => event.kind === 'turn.start').length, 2);
});

test('run: stop interrupts a silent Claude process without producing an error', async () => {
  const f = await fixture('hang');
  let asked = false;
  setTimeout(() => { asked = true; }, 800);
  const { hooks, events } = collectHooks(() => !asked);
  const started = Date.now();
  const outcome = await f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks);
  assert.ok(Date.now() - started < 5000);
  assert.equal(outcome.result, null);
  assert.ok(events.some((event) => event.kind === 'result.invalid'));
});

test('laneRunner routes claude/ models to Claude and preserves Codex/Pi routing', async () => {
  const seen: string[] = [];
  const lane = (name: string): WorkerRunner => ({ run: async (worker) => { seen.push(`${name}:${worker.model}`); return { result: null, rawText: '', sessionFile: null }; } });
  const runner = laneRunner({ pi: lane('pi'), codex: lane('codex'), claude: lane('claude') });
  const { hooks } = collectHooks();
  await runner.run(input({ worktree: '/wt', sessionDir: '/s', model: 'claude/fable:high' }), 'x', hooks);
  await runner.run(input({ worktree: '/wt', sessionDir: '/s', model: 'codex/gpt-5.6-luna' }), 'x', hooks);
  await runner.run(input({ worktree: '/wt', sessionDir: '/s', model: 'opencode-go/qwen3.8-flash' }), 'x', hooks);
  assert.deepEqual(seen, ['claude:claude/fable:high', 'codex:codex/gpt-5.6-luna', 'pi:opencode-go/qwen3.8-flash']);
});

test('available: explicit Claude binaries are discoverable', async () => {
  const f = await fixture('ok');
  assert.equal(available({ bin: f.bin }), true);
  assert.equal(available({ bin: join(f.root, 'missing-claude') }), false);
});
