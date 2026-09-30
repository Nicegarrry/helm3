/** Claude CLI per turn, native permissions and subscription usage; see README.md. */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { WorkerHooks, WorkerRunInput, WorkerRunOutcome, WorkerRunner } from './types.js';
import { RESULT_INSTRUCTION } from './prompt.js';
import { CORRECTION_MESSAGE, parseWorkerResult } from './worker.js';

export const CLAUDE_PREFIX = 'claude/';
/** What `--resume` holds for a Claude worker: the CLI session id. */
export const CLAUDE_SESSION_PREFIX = 'claude-session:';

/** `claude/<model>[:<effort>]` -> what Claude runs, or null when the name is not on this lane. */
export function parseClaudeModel(model: string): { model: string; effort?: string } | null {
  if (!model.startsWith(CLAUDE_PREFIX)) return null;
  const rest = model.slice(CLAUDE_PREFIX.length);
  const idx = rest.lastIndexOf(':');
  if (idx < 0) return rest ? { model: rest } : null;
  return idx === 0 || idx === rest.length - 1 ? null : { model: rest.slice(0, idx), effort: rest.slice(idx + 1) };
}

/** HELM_CLAUDE_BIN, else `~/.local/bin/claude`, else `claude` on PATH. */
export function defaultClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HELM_CLAUDE_BIN) return env.HELM_CLAUDE_BIN;
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

/** Whether the configured Claude CLI can be found without starting a worker. */
export function available(opts: Readonly<{ bin?: string; env?: NodeJS.ProcessEnv }> = {}): boolean {
  const env = opts.env ?? process.env;
  const bin = opts.bin ?? defaultClaudeBin(env);
  if (isAbsolute(bin) || bin.includes('/')) return existsSync(bin);
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

const INHERITED_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'CI', 'NO_COLOR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CLAUDE_CONFIG_DIR',
];

/** Keep Helm configuration, provider keys and webhook values out of the Claude process. */
export function minimalClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) if (env[key] !== undefined) result[key] = env[key];
  return result;
}

const CLAUDE_DENY_READ = [
  join(homedir(), '.config'),
  join(homedir(), '.ssh'),
  join(homedir(), '.aws'),
  join(homedir(), '.gnupg'),
  join(homedir(), '.netrc'),
  join(homedir(), '.npmrc'),
  join(homedir(), '.yarnrc*'),
  join(homedir(), '.docker'),
  join(homedir(), '.kube'),
  join(homedir(), '.stripe'),
  join(homedir(), '.convex'),
  join(homedir(), '.codex'),
  join(homedir(), '.pi'),
  join(homedir(), '.claude'),
  join(homedir(), '.claude.json'),
  join(homedir(), '.appstoreconnect'),
  join(homedir(), 'Library', 'Keychains'),
  join(homedir(), 'Library', 'Application Support'),
  join(homedir(), '.helm'),
];

const STOP_GRACE_MS = 1_000;
const execFileAsync = promisify(execFile);

export type ClaudeGitDirs = Readonly<{ gitDir: string; commonDir: string }>;

/** Resolve both git paths so a ~/.helm deny rule does not hide linked-worktree metadata. */
export async function resolveClaudeGitDirs(worktree: string): Promise<ClaudeGitDirs> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', worktree, 'rev-parse', '--absolute-git-dir', '--git-common-dir'],
    { cwd: worktree },
  );
  const paths = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (paths.length !== 2) throw new Error(`git rev-parse returned no git paths for ${worktree}`);
  return { gitDir: resolve(worktree, paths[0]!), commonDir: resolve(worktree, paths[1]!) };
}

function stopChild(child: ChildProcess): void {
  child.kill('SIGTERM');
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, STOP_GRACE_MS);
  force.unref();
}

function workerTempDir(input: Pick<WorkerRunInput, 'workerId' | 'sessionDir'>): string {
  return join(dirname(dirname(input.sessionDir)), 'tmp', input.workerId);
}

/** Claude Code's OS sandbox policy; fail closed if the sandbox backend is unavailable. */
export function claudeSandboxSettings(
  worktree: string,
  temporaryDirectory: string,
  gitDirs: ClaudeGitDirs,
  reviewer = false,
): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      filesystem: {
        allowRead: [...new Set([worktree, gitDirs.gitDir, gitDirs.commonDir, temporaryDirectory])],
        allowWrite: reviewer ? [temporaryDirectory] : [worktree, temporaryDirectory],
        denyRead: CLAUDE_DENY_READ,
      },
      network: {
        allowedDomains: [],
        deniedDomains: ['*'],
      },
    },
  });
}

export function claudeArgs(
  input: Pick<WorkerRunInput, 'role' | 'worktree'>,
  spec: { model: string; effort?: string },
  sessionId: string | null,
  temporaryDirectory: string,
  gitDirs: ClaudeGitDirs,
): string[] {
  const reviewer = input.role === 'reviewer';
  const allowedTools = reviewer ? 'Read,Glob,Grep,Bash' : 'Read,Edit,Write,Glob,Grep,Bash';
  const disallowedTools = [
    'WebFetch', 'WebSearch', 'Bash(git push *)', 'Bash(gh *)', 'Bash(git worktree *)', 'Bash(git -C *)',
    'Bash(cd /*)', 'Bash(rm -rf /*)',
  ];
  const args = [
    '-p',
    '--model', spec.model,
    ...(spec.effort ? ['--effort', spec.effort] : []),
    '--output-format', 'stream-json', '--verbose',
    '--restricted', '--safe-mode',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--permission-prompts', 'none',
    '--settings', claudeSandboxSettings(input.worktree, temporaryDirectory, gitDirs, reviewer),
    '--permission-mode', reviewer ? 'plan' : 'acceptEdits',
    '--tools', allowedTools,
    ...disallowedTools.flatMap((tool) => ['--disallowedTools', tool]),
    '--add-dir', input.worktree,
  ];
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

type ClaudeContent = Readonly<{ type?: string; name?: string; text?: string; input?: Record<string, unknown> }>;
type ClaudeEvent = Readonly<{
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: Readonly<{ content?: ClaudeContent[] | string }>;
  usage?: Readonly<Record<string, number>>;
  is_error?: boolean;
}>;

export type ClaudeWorkerRunnerOptions = Readonly<{
  bin?: string;
  env?: NodeJS.ProcessEnv;
  resolveGitDirs?: (worktree: string) => Promise<ClaudeGitDirs>;
}>;

function usageEvent(input: WorkerRunInput, usage: Readonly<Record<string, number>>): Parameters<WorkerHooks['onUsage']>[0] {
  return {
    model: input.model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0,
    costUsd: 0,
  };
}

function contentText(content: ClaudeContent[] | string | undefined): string {
  if (typeof content === 'string') return content;
  return content?.filter((block) => block.type === 'text' && block.text).map((block) => block.text).join('') ?? '';
}

export function claudeWorkerRunner(opts: ClaudeWorkerRunnerOptions = {}): WorkerRunner {
  const sourceEnv = opts.env ?? process.env;
  const env = minimalClaudeEnv(sourceEnv);
  const bin = opts.bin ?? defaultClaudeBin(sourceEnv);
  const resolveGitDirs = opts.resolveGitDirs ?? resolveClaudeGitDirs;
  return {
    async run(input: WorkerRunInput, message: string, hooks: WorkerHooks): Promise<WorkerRunOutcome> {
      const spec = parseClaudeModel(input.model);
      if (!spec) throw new Error(`claude worker: model "${input.model}" is not ${CLAUDE_PREFIX}<model>[:<effort>]`);
      await mkdir(input.sessionDir, { recursive: true });
      const temporaryDirectory = input.tempDir ?? workerTempDir(input);
      await mkdir(temporaryDirectory, { recursive: true });
      const gitDirs = await resolveGitDirs(input.worktree);
      const childEnv = { ...env, TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory };
      let sessionId = input.sessionFile?.startsWith(CLAUDE_SESSION_PREFIX) ? input.sessionFile.slice(CLAUDE_SESSION_PREFIX.length) : null;

      const turn = async (prompt: string): Promise<string> => {
        hooks.emit('turn.start', { message: prompt });
        const child = spawn(bin, claudeArgs(input, spec, sessionId, temporaryDirectory, gitDirs), { cwd: input.worktree, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        let spawnError: Error | null = null;
        child.on('error', (err) => { spawnError = err; });
        child.stdin.on('error', () => undefined);
        child.stdin.end(`${prompt}\n\n${RESULT_INSTRUCTION}`);
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
        let lastText = '';
        let usageRecorded = false;
        let stopSent = false;
        let resultError: string | null = null;
        const stopIfAsked = (): boolean => {
          if (hooks.shouldContinue() || stopSent) return false;
          stopSent = true;
          stopChild(child);
          return true;
        };
        const poll = setInterval(stopIfAsked, 500);
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          if (stopIfAsked()) return;
          let event: ClaudeEvent;
          try { event = JSON.parse(line) as ClaudeEvent; } catch { return; }
          if (event.session_id && event.session_id !== sessionId) {
            sessionId = event.session_id;
            hooks.onSession(CLAUDE_SESSION_PREFIX + sessionId);
          }
          if (event.type === 'assistant') {
            const content = event.message?.content;
            lastText = contentText(content) || lastText;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type !== 'tool_use') continue;
                const inputText = block.input?.command ?? block.input?.path ?? '';
                hooks.emit('tool.call', { tool: (block.name ?? 'unknown').toLowerCase(), summary: String(inputText).slice(0, 120) });
              }
            }
          } else if (event.type === 'result') {
            if (typeof event.result === 'string') lastText = event.result;
            if (event.is_error) resultError = typeof event.result === 'string' && event.result.trim() ? event.result : 'Claude reported an error';
            if (event.usage && !usageRecorded) {
              usageRecorded = true;
              hooks.onUsage(usageEvent(input, event.usage));
            }
          }
        });
        const [code] = await Promise.all([
          new Promise<number | null>((resolve) => child.on('close', resolve)),
          new Promise<void>((resolve) => lines.on('close', resolve)),
        ]).finally(() => clearInterval(poll));
        hooks.emit('turn.end', { exitCode: code });
        if (spawnError) throw new Error(`claude could not start (${bin}): ${(spawnError as Error).message}`);
        if (!hooks.shouldContinue()) return '';
        if (resultError) throw new Error(`claude reported an error: ${resultError}`);
        if (code !== 0) {
          const tail = stderr.trim().split('\n').at(-1) ?? '';
          throw new Error(`claude exited ${code ?? 'by signal'}${lastText.trim() ? ' after answering' : ''}: ${tail}`.trim());
        }
        return lastText;
      };

      let rawText = await turn(message);
      let result = parseWorkerResult(rawText);
      if (!result && hooks.shouldContinue()) {
        rawText = await turn(CORRECTION_MESSAGE);
        result = parseWorkerResult(rawText);
      }
      if (result) hooks.emit('result', { ...result });
      else hooks.emit('result.invalid', { rawText });
      return { result, rawText, sessionFile: sessionId ? CLAUDE_SESSION_PREFIX + sessionId : null };
    },
  };
}
