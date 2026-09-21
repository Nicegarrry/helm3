/**
 * Codex CLI runtime: one `codex exec` (or `codex exec resume <thread>`) process per turn,
 * inside the worktree, on the operator's ChatGPT subscription. Models are named
 * `codex/<model>[:<effort>]`, e.g. `codex/gpt-6-astra:medium`.
 *
 * Codex's own sandbox is the whole policy on this lane: `workspace-write` for builders
 * (writes inside the worktree only; `.git/` is refused by Codex, so Helm commits for the
 * worker as it always has; no network unless HELM_CODEX_NETWORK=1), `read-only` for
 * reviewers. Events arrive as JSONL on stdout and are mapped onto Helm's event kinds; the
 * final message is read from `--output-last-message`. Spend is $0 by definition
 * (subscription); tokens are still recorded. See DESIGN.md.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { WorkerRunInput, WorkerRunOutcome, WorkerRunner, WorkerHooks } from './types.js';
import { RESULT_INSTRUCTION } from './prompt.js';
import { CORRECTION_MESSAGE, parseWorkerResult } from './worker.js';

export const CODEX_PREFIX = 'codex/';
/** What `sessionFile` holds for a Codex worker: the thread id `codex exec resume` takes. */
export const CODEX_SESSION_PREFIX = 'codex-thread:';

/** `codex/<model>[:<effort>]` -> what Codex runs, or null when the name is not on this lane. */
export function parseCodexModel(model: string): { model: string; effort?: string } | null {
  if (!model.startsWith(CODEX_PREFIX)) return null;
  const rest = model.slice(CODEX_PREFIX.length);
  const idx = rest.lastIndexOf(':');
  if (idx < 0) return rest ? { model: rest } : null;
  return idx === 0 || idx === rest.length - 1 ? null : { model: rest.slice(0, idx), effort: rest.slice(idx + 1) };
}

/** HELM_CODEX_BIN, else `~/.local/bin/codex` (where the installer puts it), else `codex` on PATH. */
export function defaultCodexBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HELM_CODEX_BIN) return env.HELM_CODEX_BIN;
  const local = join(homedir(), '.local', 'bin', 'codex');
  return existsSync(local) ? local : 'codex';
}

export function codexArgs(input: Pick<WorkerRunInput, 'role' | 'worktree'>, spec: { model: string; effort?: string }, threadId: string | null, lastFile: string, network: boolean): string[] {
  const sandbox = input.role === 'reviewer' ? 'read-only' : 'workspace-write';
  const common = ['--json', '-m', spec.model, '-c', 'approval_policy="never"', '-c', `sandbox_mode="${sandbox}"`, '-o', lastFile, '--skip-git-repo-check'];
  if (spec.effort) common.push('-c', `model_reasoning_effort="${spec.effort}"`);
  if (network && sandbox === 'workspace-write') common.push('-c', 'sandbox_workspace_write.network_access=true');
  // `exec resume` takes neither -C nor -s: the session remembers its cwd and the sandbox rides -c.
  return threadId ? ['exec', 'resume', threadId, ...common, '-'] : ['exec', ...common, '-C', input.worktree, '-'];
}

type CodexItem = Readonly<{ type: string; command?: string; exit_code?: number | null; changes?: ReadonlyArray<{ path: string }>; text?: string; message?: string }>;
type CodexEvent = Readonly<{ type: string; thread_id?: string; item?: CodexItem; usage?: Readonly<Record<string, number>> }>;

export type CodexWorkerRunnerOptions = Readonly<{ bin?: string; env?: NodeJS.ProcessEnv }>;

export function codexWorkerRunner(opts: CodexWorkerRunnerOptions = {}): WorkerRunner {
  const env = opts.env ?? process.env;
  const bin = opts.bin ?? defaultCodexBin(env);
  const network = env.HELM_CODEX_NETWORK === '1';
  return {
    async run(input: WorkerRunInput, message: string, hooks: WorkerHooks): Promise<WorkerRunOutcome> {
      const spec = parseCodexModel(input.model);
      if (!spec) throw new Error(`codex worker: model "${input.model}" is not ${CODEX_PREFIX}<model>[:<effort>]`);
      await mkdir(input.sessionDir, { recursive: true });
      let threadId = input.sessionFile?.startsWith(CODEX_SESSION_PREFIX) ? input.sessionFile.slice(CODEX_SESSION_PREFIX.length) : null;

      const turn = async (prompt: string): Promise<string> => {
        const lastFile = join(input.sessionDir, `last-${Date.now()}.md`);
        hooks.emit('turn.start', { message: prompt });
        const child = spawn(bin, codexArgs(input, spec, threadId, lastFile, network), { cwd: input.worktree, env, stdio: ['pipe', 'pipe', 'pipe'] });
        // A missing or non-executable binary surfaces as an 'error' event on the child, not as an
        // exception from spawn(); left unhandled it would take the daemon down.
        let spawnError: Error | null = null;
        child.on('error', (err) => { spawnError = err; });
        child.stdin.on('error', () => undefined);
        child.stdin.end(`${prompt}\n\n${RESULT_INSTRUCTION}`);
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
        let lastText = '';
        // Cancellation is checked on every event AND on a timer: a worker deep in one long silent
        // command emits nothing, and a stop request must still land inside `stop()`'s wait.
        const stopIfAsked = (): boolean => { if (hooks.shouldContinue()) return false; child.kill('SIGTERM'); return true; };
        const poll = setInterval(stopIfAsked, 500);
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          if (stopIfAsked()) return;
          let ev: CodexEvent;
          try { ev = JSON.parse(line) as CodexEvent; } catch { return; }
          const it = ev.item;
          if (ev.type === 'thread.started' && ev.thread_id) {
            threadId = ev.thread_id;
            hooks.onSession(CODEX_SESSION_PREFIX + ev.thread_id);
          } else if (ev.type === 'item.completed' && it?.type === 'command_execution') {
            hooks.emit('tool.call', { tool: 'bash', summary: (it.command ?? '').slice(0, 120), exitCode: it.exit_code ?? null });
          } else if (ev.type === 'item.completed' && it?.type === 'file_change') {
            hooks.emit('tool.call', { tool: 'edit', summary: (it.changes ?? []).map((c) => c.path).join(' ').slice(0, 120) });
          } else if (ev.type === 'item.completed' && it?.type === 'agent_message') {
            lastText = it.text ?? lastText;
          } else if (ev.type === 'item.completed' && it?.type === 'error') {
            hooks.emit('notice', { message: it.message ?? '' });
          } else if (ev.type === 'turn.completed' && ev.usage) {
            const u = ev.usage;
            const cached = u.cached_input_tokens ?? 0;
            hooks.onUsage({ model: input.model, inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached), outputTokens: u.output_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: u.cache_write_input_tokens ?? 0, costUsd: 0 });
          }
        });
        const [code] = await Promise.all([
          new Promise<number | null>((resolve) => child.on('close', resolve)),
          new Promise<void>((resolve) => lines.on('close', resolve)),
        ]).finally(() => clearInterval(poll));
        hooks.emit('turn.end', { exitCode: code });
        if (spawnError) throw new Error(`codex could not start (${bin}): ${(spawnError as Error).message}`);
        if (!hooks.shouldContinue()) return ''; // killed on request: a null result, never an error
        const text = await readFile(lastFile, 'utf8').catch(() => lastText);
        if (code !== 0) {
          // A non-zero exit is not a healthy turn even when an answer was written; the worktree
          // keeps whatever was done, the worker lands in `unknown`, and a steer can resume it.
          const tail = stderr.trim().split('\n').at(-1) ?? '';
          throw new Error(`codex exited ${code ?? 'by signal'}${text.trim() ? ' after answering' : ''}: ${tail}`.trim());
        }
        return text;
      };

      let rawText = await turn(message);
      let result = parseWorkerResult(rawText);
      if (!result && hooks.shouldContinue()) {
        rawText = await turn(CORRECTION_MESSAGE);
        result = parseWorkerResult(rawText);
      }
      if (result) hooks.emit('result', { ...result });
      else hooks.emit('result.invalid', { rawText });
      return { result, rawText, sessionFile: threadId ? CODEX_SESSION_PREFIX + threadId : null };
    },
  };
}

/** One runner for both lanes: `codex/…` models go to Codex, everything else to Pi. */
export function laneRunner(lanes: Readonly<{ pi: WorkerRunner; codex: WorkerRunner }>): WorkerRunner {
  return { run: (input, message, hooks) => (parseCodexModel(input.model) ? lanes.codex : lanes.pi).run(input, message, hooks) };
}
