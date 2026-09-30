import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_SESSION_PREFIX, available, claudeArgs, claudeWorkerRunner, parseClaudeModel } from '../src/claude.js';
import { CORRECTION_MESSAGE } from '../src/worker.js';
import { RESULT_INSTRUCTION } from '../src/prompt.js';
import { laneRunner } from '../src/codex.js';
import type { EventRow, WorkerHooks, WorkerRunInput, WorkerRunner } from '../src/types.js';

function fakeClaude(mode: string, record: string): string {
  return `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const record = ${JSON.stringify(record)};
const mode = ${JSON.stringify(mode)};
appendFileSync(record, JSON.stringify({ args, stdin, cwd: process.cwd(), env: process.env }) + '\\n');
const resume = args.includes('--resume');
const session = resume ? args[args.indexOf('--resume') + 1] : 'session-1';
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: session });
emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
if (mode === 'hang' || mode === 'ignore-term') {
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  setTimeout(() => {}, 60000);
}
else if (mode === 'fail') { process.stderr.write('claude: not logged in\\n'); process.exit(2); }
else if (mode === 'error-result') {
  emit({ type: 'result', subtype: 'error', session_id: session, is_error: true, result: 'provider failed' });
}
else {
  const ok = JSON.stringify({ status: 'succeeded', summary: 'did it', changedFiles: ['a.ts'], commandsRun: ['npm test'] });
  const text = mode === 'malformed-first' && !resume ? 'not json at all' : ok;
  emit({ type: 'result', subtype: 'success', session_id: session, result: text, usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 10 } });
}
`;
}

async function fixture(mode: string, extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'helm-claude-test-'));
  const bin = join(root, 'claude.mjs');
  const worktree = join(root, 'wt');
  await mkdir(worktree);
  const record = join(root, 'record.jsonl');
  await writeFile(bin, fakeClaude(mode, record));
  await chmod(bin, 0o755);
  const env = {
    ...process.env,
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
  const build = claudeArgs({ role: 'builder', worktree: '/wt' }, { model: 'sonnet', effort: 'high' }, null, '/tmp/helm-claude');
  assert.deepEqual(build.slice(0, 5), ['-p', '--model', 'sonnet', '--effort', 'high']);
  assert.ok(build.includes('--output-format') && build[build.indexOf('--output-format') + 1] === 'stream-json');
  assert.ok(build.includes('--verbose'));
  assert.ok(build.includes('--permission-mode') && build[build.indexOf('--permission-mode') + 1] === 'acceptEdits');
  assert.ok(build.includes('--tools') && build[build.indexOf('--tools') + 1] === 'Read,Edit,Write,Glob,Grep,Bash');
  assert.ok(build.includes('--restricted') && build.includes('--safe-mode'));
  assert.ok(build.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(build[build.indexOf('--mcp-config') + 1]!), { mcpServers: {} });
  assert.equal(build[build.indexOf('--setting-sources') + 1], '');
  assert.equal(build[build.indexOf('--permission-prompts') + 1], 'none');
  assert.ok(!build.includes('--bare'), 'subscription OAuth must remain available');
  const settings = JSON.parse(build[build.indexOf('--settings') + 1]!) as { sandbox: Record<string, unknown> };
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.excludedCommands, []);
  assert.deepEqual(settings.sandbox.filesystem, {
    allowRead: ['/wt'],
    allowWrite: ['/wt', '/tmp/helm-claude'],
    denyRead: [
      join(homedir(), '.config'), join(homedir(), '.ssh'), join(homedir(), '.aws'), join(homedir(), '.gnupg'), join(homedir(), '.netrc'),
      join(homedir(), '.npmrc'), join(homedir(), '.yarnrc*'), join(homedir(), '.docker'), join(homedir(), '.kube'), join(homedir(), '.stripe'),
      join(homedir(), '.convex'), join(homedir(), '.codex'), join(homedir(), '.pi'), join(homedir(), '.claude'), join(homedir(), '.claude.json'),
      join(homedir(), '.appstoreconnect'), join(homedir(), 'Library', 'Keychains'), join(homedir(), 'Library', 'Application Support'), join(homedir(), '.helm'),
    ],
  });
  assert.deepEqual(settings.sandbox.network, { allowedDomains: [], deniedDomains: ['*'] });
  assert.equal(build.filter((arg) => arg === '--add-dir').length, 1);
  assert.equal(build[build.indexOf('--add-dir') + 1], '/wt');
  assert.ok(!build.some((arg) => /bypass|skip-permissions|dangerously/i.test(arg)));

  const review = claudeArgs({ role: 'reviewer', worktree: '/wt' }, { model: 'opus' }, 'session-1', '/tmp/review-temp');
  assert.ok(review.includes('--resume') && review[review.indexOf('--resume') + 1] === 'session-1');
  assert.equal(review[review.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(review[review.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');
  assert.ok(!review[review.indexOf('--tools') + 1]!.includes('Edit'));
  const reviewSettings = JSON.parse(review[review.indexOf('--settings') + 1]!) as { sandbox: { filesystem: { allowRead: string[]; allowWrite: string[] } } };
  assert.deepEqual(reviewSettings.sandbox.filesystem.allowRead, ['/wt']);
  assert.deepEqual(reviewSettings.sandbox.filesystem.allowWrite, ['/tmp/review-temp']);
  assert.ok(!review.slice(review.indexOf('--disallowedTools')).includes('Bash'));
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
  assert.equal(call!.env.FAKE_CLAUDE_RECORD, undefined);
  assert.equal(call!.env.FAKE_CLAUDE_MODE, undefined);
  assert.equal(call!.env.TMPDIR, join(f.root, 'tmp', 'w-1'));
  assert.equal(call!.env.TMP, join(f.root, 'tmp', 'w-1'));
  assert.equal(call!.env.TEMP, join(f.root, 'tmp', 'w-1'));
  assert.equal(existsSync(join(f.root, 'tmp', 'w-1')), true);
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

test('run: an is_error result is an error and does not trigger correction', async () => {
  const f = await fixture('error-result');
  const { hooks } = collectHooks();
  await assert.rejects(f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks), /claude reported an error: provider failed/);
  assert.equal((await f.calls()).length, 1);
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

test('run: stop escalates to SIGKILL when Claude ignores SIGTERM', async () => {
  const f = await fixture('ignore-term');
  let asked = false;
  setTimeout(() => { asked = true; }, 800);
  const { hooks } = collectHooks(() => !asked);
  const started = Date.now();
  const outcome = await f.runner.run(input({ worktree: f.worktree, sessionDir: f.sessionDir }), 'Add the flag', hooks);
  assert.ok(Date.now() - started < 5000);
  assert.equal(outcome.result, null);
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
