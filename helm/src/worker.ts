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
import { relative, resolve, sep } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { Model, Api } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import { workerResultSchema, type WorkerResult, type WorkerRole, type WorkerRunInput, type WorkerRunOutcome, type WorkerRunner, type WorkerHooks } from './types.js';
import { RESULT_INSTRUCTION } from './prompt.js';

const CORRECTION_MESSAGE =
  'Your final message must be exactly one JSON object matching the WorkerResult schema. Reply with only that JSON.';

/** Accept strict JSON or one ```json fenced block (last one wins if more than one appears). */
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
  if (fences.length === 0) return null;
  const last = fences[fences.length - 1]?.[1] ?? '';
  return attempt(last.trim());
}

// ---------- Protected-path policy (the whole tool_call hook) ----------

const BASH_DENY: readonly RegExp[] = [
  /\bgit\s+push\b/,
  /\bgh\s/,
  /\bgit\s+worktree\b/,
  /\bgit\s+checkout\s+(?!--\s)\S/,
  /\brm\s+-rf\s+\/(\s|$)/,
];
const REVIEWER_BASH_DENY = /(>\s*\S|\btee\b|\bsed\s+-i\b|\bmv\b|\bcp\b|\brm\b|\bgit\s+(commit|add|reset|rebase|merge)\b)/;
const CD_ABSOLUTE = /\bcd\s+(\/[^\s;&|]+)/g;

const PATH_TOOLS: readonly string[] = ['read', 'edit', 'write', 'grep', 'find', 'ls'];
const WRITE_TOOLS: readonly string[] = ['edit', 'write'];

type Verdict = Readonly<{ allow: true; summary: string }> | Readonly<{ allow: false; reason: string }>;

/** Resolve `rawPath` against the worktree, realpath'd if it already exists. */
async function resolveGuardedPath(worktree: string, rawPath: string): Promise<string> {
  const resolved = resolve(worktree, rawPath);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function cdOutsideWorktree(command: string, worktree: string, worktreeReal: string): string | undefined {
  for (const match of command.matchAll(CD_ABSOLUTE)) {
    const target = resolve(match[1] ?? '/');
    if (!isInside(target, worktree) && !isInside(target, worktreeReal)) return match[1];
  }
  return undefined;
}

function bashRefusalReason(command: string, role: WorkerRole, worktree: string, worktreeReal: string): string | undefined {
  for (const pattern of BASH_DENY) {
    if (pattern.test(command)) return `blocked bash command (matches ${pattern.source})`;
  }
  if (role === 'reviewer' && REVIEWER_BASH_DENY.test(command)) {
    return 'reviewer role cannot run bash commands that modify files or git state';
  }
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

async function defaultModelRuntime(): Promise<ModelRuntime> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  return ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
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
        if (!result) {
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
