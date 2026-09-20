/**
 * Pi session runtime: creates one in-process Pi coding-agent session per turn inside a
 * worktree, with Pi's built-in tools enabled, guarded by a `tool_call` extension hook that
 * is the entire protected-path policy. Parses the model's final message into a
 * `WorkerResult`, with one correction turn on malformed output. See DESIGN.md and
 * docs/one-shot-brief.md section 5.
 *
 * Pi packages are imported lazily, inside functions, never at module load time.
 */
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { Model, Api } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import { workerResultSchema, type WorkerResult, type WorkerRole, type WorkerRunInput, type WorkerRunOutcome, type WorkerRunner, type WorkerHooks } from './types.js';
import { RESULT_INSTRUCTION } from './prompt.js';

const CORRECTION_MESSAGE =
  'Your final message must be exactly one JSON object matching the WorkerResult schema. Reply with only that JSON.';

/**
 * Accept strict JSON or a ```json fenced block. Strict-JSON-whole-message is tried first;
 * if that fails, fenced blocks are tried from last to first, returning the first one that
 * validates against the schema (an unrelated JSON fence elsewhere in the message must not
 * shadow a valid result fence).
 */
export function parseWorkerResult(text: string): WorkerResult | null {
  const attempt = (candidate: string): WorkerResult | null => {
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      return null;
    }
    const parsed = workerResultSchema.safeParse(data);
    return parsed.success ? parsed.data : null;
  };
  const direct = attempt(text.trim());
  if (direct) return direct;
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const candidate = fences[i]?.[1] ?? '';
    const parsed = attempt(candidate.trim());
    if (parsed) return parsed;
  }
  return null;
}

// ---------- Protected-path policy (the whole tool_call hook) ----------

// gh and a bare `rm -rf /` are denied outright, for every role; everything else about git
// goes through the classifyBash tokenizer below, which is not foolable by inserted flags.
const GH_DENY = /\bgh\s/;
const RM_RF_ROOT_DENY = /\brm\s+-rf\s+\/(\s|$)/;
// Write-like bash for the reviewer role. git's own write subcommands (commit, add, reset,
// rebase, merge, push) are handled by the tokenizer in classifyBash so `git -C .. commit`
// cannot slip past a flat regex.
const REVIEWER_BASH_DENY = /(>\s*\S|\btee\b|\bsed\s+-i\b|\bmv\b|\bcp\b|\brm\b)/;
// cd to an absolute path outside the worktree, bare or quoted with " or '.
const CD_ABSOLUTE = /\bcd\s+(?:"(\/[^"]*)"|'(\/[^']*)'|(\/[^\s;&|]+))/g;
const REVIEWER_GIT_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set(['commit', 'add', 'reset', 'rebase', 'merge', 'push']);
// Separators that end a git invocation: command separators, pipes, subshells and command
// substitution. Splitting on these (as their own tokens) keeps `git`'s argument scan from
// running past the end of its own command into the next one.
const SHELL_SEPARATOR_RE = /(;|\|\||&&|\||\(|\)|`|\$\()/g;
// git options that take a separate value argument; their value token must be skipped too
// so the scan lands on the actual subcommand, not on `git -C ..` seeing `..` as the verb.
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace', '--config-env']);

function tokenizeShell(command: string): string[] {
  return command
    .replace(SHELL_SEPARATOR_RE, ' $1 ')
    .split(/\s+/)
    .filter((tok) => tok.length > 0);
}

/**
 * Tokenizer-based classifier for bash commands, exported so it can be unit tested without a
 * Pi session. Finds every `git` invocation in the command (across `;`, `&&`, `||`, `|`, `(
 * )`, backticks and `$(`), skips its option tokens (and the value argument of options that
 * take one) to find the actual subcommand, and denies push/worktree/checkout(without `--`
 * for the reviewer or `switch`)/switch regardless of how many flags precede it. This closes
 * the `git -C .. push`, `git --no-pager push`, `git -C .. worktree remove` style bypasses
 * that a flat `/git\s+push/` regex misses.
 */
export function classifyBash(command: string, role: WorkerRole): { allowed: boolean; reason?: string } {
  if (GH_DENY.test(command)) return { allowed: false, reason: 'gh CLI is not allowed' };
  if (RM_RF_ROOT_DENY.test(command)) return { allowed: false, reason: 'refusing rm -rf /' };

  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue;
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j]!;
      if (!tok.startsWith('-')) break;
      j += GIT_VALUE_OPTIONS.has(tok) ? 2 : 1;
    }
    const subcommand = tokens[j];
    if (subcommand === undefined) continue; // bare `git` (or `git` followed only by options)
    if (subcommand === 'push' || subcommand === 'worktree') {
      return { allowed: false, reason: `blocked git subcommand: git ${subcommand}` };
    }
    if (subcommand === 'checkout' || subcommand === 'switch') {
      if (tokens[j + 1] !== '--') {
        return { allowed: false, reason: `blocked git subcommand: git ${subcommand} (checkout/switch of a ref is not allowed; use "-- <path>")` };
      }
    }
    if (role === 'reviewer' && REVIEWER_GIT_WRITE_SUBCOMMANDS.has(subcommand)) {
      return { allowed: false, reason: `reviewer role cannot run git ${subcommand}` };
    }
  }
  if (role === 'reviewer' && REVIEWER_BASH_DENY.test(command)) {
    return { allowed: false, reason: 'reviewer role cannot run bash commands that modify files or git state' };
  }
  return { allowed: true };
}

const PATH_TOOLS: readonly string[] = ['read', 'edit', 'write', 'grep', 'find', 'ls'];
const WRITE_TOOLS: readonly string[] = ['edit', 'write'];

type Verdict = Readonly<{ allow: true; summary: string }> | Readonly<{ allow: false; reason: string }>;

/**
 * Resolve `rawPath` against the worktree and realpath it. When the path does not exist yet
 * (the write tool's normal case), realpath throws; falling back to the lexical path there
 * would let a symlink such as `evil -> /tmp` plus a write to `evil/x.txt` escape the
 * worktree undetected. Instead walk up to the deepest ancestor that does exist, realpath
 * that (resolving any symlink in the existing prefix), and re-append the remaining,
 * not-yet-existing components before the containment check.
 */
async function resolveGuardedPath(worktree: string, rawPath: string): Promise<string> {
  const resolved = resolve(worktree, rawPath);
  try {
    return await realpath(resolved);
  } catch {
    let ancestor = dirname(resolved);
    const remainder = [basename(resolved)];
    for (;;) {
      try {
        const real = await realpath(ancestor);
        return join(real, ...remainder);
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) return resolved; // reached the filesystem root; give up on realpath
        remainder.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
  }
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function cdOutsideWorktree(command: string, worktree: string, worktreeReal: string): string | undefined {
  for (const match of command.matchAll(CD_ABSOLUTE)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    const target = resolve(raw || '/');
    if (!isInside(target, worktree) && !isInside(target, worktreeReal)) return raw;
  }
  return undefined;
}

// F11: this deny-list approach confines the model's cooperative behavior only; it is not
// OS-level sandboxing (no chroot/namespace/seccomp), and a determined bash one-liner can
// still reach outside the worktree. That is accepted for now (see DESIGN.md).
function bashRefusalReason(command: string, role: WorkerRole, worktree: string, worktreeReal: string): string | undefined {
  const verdict = classifyBash(command, role);
  if (!verdict.allowed) return verdict.reason;
  const outside = cdOutsideWorktree(command, worktree, worktreeReal);
  if (outside) return `cd to an absolute path outside the worktree: ${outside}`;
  return undefined;
}

async function evaluateToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Readonly<{ worktree: string; worktreeReal: string; role: WorkerRole; allowWorkflows: boolean }>,
): Promise<Verdict> {
  if (toolName === 'bash' || toolName === 'powershell') {
    const command = typeof input.command === 'string' ? input.command : '';
    const reason = bashRefusalReason(command, ctx.role, ctx.worktree, ctx.worktreeReal);
    if (reason) return { allow: false, reason };
    return { allow: true, summary: command.slice(0, 120) };
  }
  if (PATH_TOOLS.includes(toolName)) {
    const isWrite = WRITE_TOOLS.includes(toolName);
    if (isWrite && ctx.role === 'reviewer') {
      return { allow: false, reason: 'reviewer role cannot edit or write files' };
    }
    const rawPath = typeof input.path === 'string' ? input.path : undefined;
    if (rawPath === undefined) return { allow: true, summary: toolName };
    const resolved = await resolveGuardedPath(ctx.worktree, rawPath);
    if (!isInside(resolved, ctx.worktreeReal) && !isInside(resolved, ctx.worktree)) {
      return { allow: false, reason: `path resolves outside the worktree: ${rawPath}` };
    }
    if (isWrite) {
      const rel = relative(ctx.worktreeReal, resolved);
      if (rel === '.git' || rel.startsWith(`.git${sep}`)) {
        return { allow: false, reason: 'refusing to write under .git/' };
      }
      if ((rel === '.github/workflows' || rel.startsWith(`.github${sep}workflows${sep}`)) && !ctx.allowWorkflows) {
        return { allow: false, reason: 'refusing to write under .github/workflows/ (not allowed for this spawn)' };
      }
    }
    return { allow: true, summary: rawPath };
  }
  return { allow: true, summary: toolName };
}

// ---------- Model runtime / resolution ----------

// modelsPath is left unset so Pi loads the operator's ~/.pi/agent/models.json. Custom
// providers, their API keys and pinned routes live only in that file; passing null makes
// every model configured there unresolvable and leaves built-in ones without credentials.
export async function defaultModelRuntime(): Promise<ModelRuntime> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  return ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
}

function defaultResolveModel(modelRuntime: ModelRuntime): (name: string) => Model<Api> | undefined {
  return (name: string) => {
    const idx = name.indexOf('/');
    if (idx <= 0) return undefined;
    return modelRuntime.getModel(name.slice(0, idx), name.slice(idx + 1));
  };
}

function computeCostUsd(model: Model<Api>, usage: Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number }>): number | null {
  const rates = model.cost;
  if (!rates || (rates.input === 0 && rates.output === 0 && rates.cacheRead === 0 && rates.cacheWrite === 0)) return null;
  const usd =
    (usage.input * rates.input + usage.output * rates.output + usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite) / 1_000_000;
  return usd;
}

// ---------- Runner ----------

export type PiWorkerRunnerOptions = Readonly<{
  modelRuntime?: ModelRuntime;
  resolveModel?: (name: string) => Model<Api> | undefined;
}>;

export function piWorkerRunner(opts: PiWorkerRunnerOptions = {}): WorkerRunner {
  return {
    async run(input: WorkerRunInput, message: string, hooks: WorkerHooks): Promise<WorkerRunOutcome> {
      const { createAgentSession, SessionManager, SettingsManager, createEventBus, createExtensionRuntime } = await import(
        '@earendil-works/pi-coding-agent'
      );
      const piPackageEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
      const { loadExtensionFromFactory } = await import(new URL('./core/extensions/loader.js', piPackageEntry).href);

      const modelRuntime = opts.modelRuntime ?? (await defaultModelRuntime());
      const resolveModel = opts.resolveModel ?? defaultResolveModel(modelRuntime);
      const model = resolveModel(input.model);
      if (!model) throw new Error(`worker: unknown model "${input.model}"`);

      await mkdir(input.sessionDir, { recursive: true });
      const agentDir = `${input.sessionDir}/agent`;
      await mkdir(agentDir, { recursive: true });
      const sessionManager = input.sessionFile
        ? SessionManager.open(input.sessionFile, input.sessionDir, input.worktree)
        : SessionManager.create(input.worktree, input.sessionDir);
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });

      let worktreeReal: string;
      try {
        worktreeReal = await realpath(input.worktree);
      } catch {
        worktreeReal = resolve(input.worktree);
      }

      let session: import('@earendil-works/pi-coding-agent').AgentSession | undefined;
      const factory = (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) => {
        pi.on('tool_call', async (event) => {
          if (!hooks.shouldContinue()) {
            void session?.abort();
            return { block: true, reason: 'stopped' };
          }
          const verdict = await evaluateToolCall(event.toolName, event.input as Record<string, unknown>, {
            worktree: input.worktree,
            worktreeReal,
            role: input.role,
            allowWorkflows: input.allowWorkflows,
          });
          if (!verdict.allow) {
            hooks.emit('tool.refused', { tool: event.toolName, reason: verdict.reason });
            return { block: true, reason: verdict.reason };
          }
          hooks.emit('tool.call', { tool: event.toolName, summary: verdict.summary });
          return {};
        });
      };
      const eventBus = createEventBus();
      const extensionRuntime = createExtensionRuntime();
      const extension = await loadExtensionFromFactory(factory, input.worktree, eventBus, extensionRuntime);
      const resourceLoader = {
        getExtensions: () => ({ extensions: [extension], errors: [], runtime: extensionRuntime }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => undefined,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => undefined,
        reload: async () => undefined,
      };

      const tools: string[] = input.role === 'reviewer' ? ['read', 'grep', 'find', 'ls', 'bash'] : ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

      const created = await createAgentSession({
        cwd: input.worktree,
        agentDir,
        modelRuntime,
        model,
        sessionManager,
        settingsManager,
        tools,
        resourceLoader,
      });
      session = created.session;

      const unsubscribe = session.subscribe((event: { type: string; message?: { role: string; usage?: unknown } }) => {
        if (event.type !== 'message_end' || event.message?.role !== 'assistant') return;
        const usage = event.message.usage as
          | Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number }>
          | undefined;
        if (!usage) return;
        hooks.onUsage({
          model: input.model,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          costUsd: computeCostUsd(model, usage),
        });
      });

      try {
        const runTurn = async (text: string): Promise<string> => {
          hooks.emit('turn.start', { message: text });
          await session!.prompt(`${text}\n\n${RESULT_INSTRUCTION}`);
          hooks.emit('turn.end');
          return session!.getLastAssistantText() ?? '';
        };

        let rawText = await runTurn(message);
        let result = parseWorkerResult(rawText);
        if (!result && hooks.shouldContinue()) {
          rawText = await runTurn(CORRECTION_MESSAGE);
          result = parseWorkerResult(rawText);
        }

        if (result) hooks.emit('result', { ...result });
        else hooks.emit('result.invalid', { rawText });

        return { result, rawText, sessionFile: session.sessionFile ?? null };
      } finally {
        unsubscribe();
        session.dispose();
      }
    },
  };
}
