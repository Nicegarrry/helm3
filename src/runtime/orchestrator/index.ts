import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { Codex, CodexOptions, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk' with { 'resolution-mode': 'import' };
import { randomUUID } from 'node:crypto';
import { z, type ZodRawShape } from 'zod/v3';
import type { OrchestratorDriver } from '../../contracts/index.js';

export type HelmToolResult =
  | { state: 'succeeded'; value: unknown }
  | { state: 'refused' | 'unsupported' | 'unknown'; reason: string };

export type InvocationOutcome = 'succeeded' | 'failed' | 'unknown';

/** Trusted invocation identity, supplied by a Helm driver or transport rather than model JSON. */
export type HelmToolExecutionContext = Readonly<{ runId: string; sessionId: string; mode: 'primary' | 'consultant' }>;

export type HelmTool = {
  name: string;
  description: string;
  input: ZodRawShape;
  execute(input: Record<string, unknown>, context: HelmToolExecutionContext): Promise<HelmToolResult>;
};

/** Domain tools are registered once and are never worker-harness tools. */
export class HelmToolRegistry {
  readonly #tools = new Map<string, HelmTool>();

  constructor(tools: HelmTool[]) {
    for (const entry of tools) {
      if (this.#tools.has(entry.name)) throw new Error(`Duplicate Helm tool: ${entry.name}`);
      this.#tools.set(entry.name, entry);
    }
  }

  all(): HelmTool[] { return [...this.#tools.values()]; }

  async invoke(name: string, input: unknown, context: HelmToolExecutionContext): Promise<HelmToolResult> {
    const entry = this.#tools.get(name);
    if (!entry) return { state: 'unsupported', reason: `Helm tool is not registered: ${name}` };
    const parsed = z.object(entry.input).strict().safeParse(input);
    if (!parsed.success) return { state: 'refused', reason: parsed.error.issues.map((issue) => issue.message).join('; ') };
    try { return await entry.execute(parsed.data, context); }
    catch (error) { return { state: 'unknown', reason: error instanceof Error ? error.message : 'Helm tool outcome is unknown' }; }
  }
}

export type RecoveryBundle = {
  driver: 'fable' | 'astra';
  runId: string;
  sessionId: string;
  providerSessionId?: string;
  mode: 'primary' | 'consultant';
  contextRefs: string[];
  eventRefs: string[];
  recoveryStateRef: string;
};

export interface OrchestratorArtifacts {
  readText(ref: string): Promise<string>;
  saveInvocation(input: { driver: 'fable' | 'astra'; sessionId: string; providerSessionId?: string; outcome: InvocationOutcome; text: string }): Promise<string>;
  saveRecoveryBundle(bundle: RecoveryBundle): Promise<string>;
  loadRecoveryBundle(ref: string): Promise<RecoveryBundle>;
}

export interface OrchestratorSessionGuard {
  /**
   * Runs before the first recovery capture. A durable host can bind the driver-
   * generated session identity to a fenced ownership epoch here.
   */
  authorizeStart?(input: { driver: 'fable' | 'astra'; runId: string; sessionId: string; mode: 'primary' | 'consultant' }): Promise<void>;
  assertCurrent(input: { runId: string; sessionId: string; mode: 'primary' | 'consultant' }): Promise<void>;
}

/** The host supplies the authoritative Brief/Map/Log recovery manifest; SDK transcripts are only continuation hints. */
export interface OrchestratorRecoveryState {
  capture(input: { driver: 'fable' | 'astra'; runId: string; sessionId: string; mode: 'primary' | 'consultant'; contextRefs?: string[]; eventRefs?: string[] }): Promise<{ recoveryStateRef: string }>;
  restore(recoveryStateRef: string): Promise<string>;
}

export class UnsupportedDriverOperation extends Error {
  constructor(operation: string, detail: string) { super(`${operation} is unsupported: ${detail}`); }
}

type Session = {
  runId: string;
  sessionId: string;
  providerSessionId?: string;
  mode: 'primary' | 'consultant';
  contextRefs: string[];
  eventRefs: string[];
  recoveryStateRef: string;
  state: 'idle' | 'active' | 'stopping' | 'stopped';
  invocation: number;
  cancellationRequested: boolean;
  recoveryContext?: string;
};

type FableSdk = Pick<typeof ClaudeSdk, 'query' | 'tool' | 'createSdkMcpServer'>;
type AstraSdk = { create(): Promise<Codex>; };
export type FableHostOptions = { env: Record<string, string>; cwd?: string; model?: string };
export type AstraHostOptions = { env: Record<string, string>; config?: CodexOptions['config']; codexPathOverride?: string };

async function loadFableSdk(): Promise<FableSdk> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return { query: sdk.query, tool: sdk.tool, createSdkMcpServer: sdk.createSdkMcpServer };
}
export function createAstraSdk(host: AstraHostOptions): AstraSdk {
  if (!host.env.PATH) throw new Error('Astra host environment must explicitly provide PATH');
  return { async create() {
    const { Codex } = await import('@openai/codex-sdk');
    return new Codex({ codexPathOverride: host.codexPathOverride, config: host.config, env: host.env });
  } };
}
function helmSessionId(provider: 'fable' | 'astra'): string { return `helm:${provider}:${randomUUID()}`; }
function providerSessionId(message: unknown): string | undefined {
  if (typeof message === 'object' && message !== null && 'session_id' in message && typeof message.session_id === 'string') return message.session_id;
  if (typeof message === 'object' && message !== null && 'thread_id' in message && typeof message.thread_id === 'string') return message.thread_id;
  return undefined;
}
function fableOutcome(messages: ClaudeSdk.SDKMessage[]): InvocationOutcome {
  const terminal = [...messages].reverse().find((message) => message.type === 'result');
  if (!terminal) return 'unknown';
  return terminal.subtype === 'success' && !terminal.is_error ? 'succeeded' : 'failed';
}
function astraOutcome(events: ThreadEvent[]): InvocationOutcome {
  let outcome: InvocationOutcome = 'unknown';
  for (const event of events) {
    if (event.type === 'turn.completed') outcome = 'succeeded';
    if (event.type === 'turn.failed' || event.type === 'error') outcome = 'failed';
  }
  return outcome;
}
function requireSession(sessions: Map<string, Session>, sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown Helm orchestrator session: ${sessionId}`);
  if (session.state === 'stopped') throw new Error(`Stopped Helm orchestrator session: ${sessionId}`);
  return session;
}
function findSession(sessions: Map<string, Session>, sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown Helm orchestrator session: ${sessionId}`);
  return session;
}

abstract class BaseDriver implements OrchestratorDriver {
  protected readonly sessions = new Map<string, Session>();
  protected abstract readonly provider: 'fable' | 'astra';

  constructor(protected readonly artifacts: OrchestratorArtifacts, protected readonly guard: OrchestratorSessionGuard, private readonly recovery: OrchestratorRecoveryState) {}

  async start(input: { runId: string; contextRefs: string[]; mode: 'primary' | 'consultant' }): Promise<{ sessionId: string }> {
    const sessionId = helmSessionId(this.provider);
    await this.guard.authorizeStart?.({ driver: this.provider, runId: input.runId, sessionId, mode: input.mode });
    const captured = await this.recovery.capture({ driver: this.provider, runId: input.runId, sessionId, mode: input.mode, contextRefs: [...input.contextRefs] });
    const session: Session = { runId: input.runId, sessionId, mode: input.mode, contextRefs: [...input.contextRefs], eventRefs: [], recoveryStateRef: captured.recoveryStateRef, state: 'idle', invocation: 0, cancellationRequested: false };
    await this.guard.assertCurrent(session);
    this.sessions.set(sessionId, session);
    return { sessionId };
  }

  async resume(input: { sessionId?: string; recoveryBundleRef: string }): Promise<{ sessionId: string }> {
    const bundle = await this.artifacts.loadRecoveryBundle(input.recoveryBundleRef);
    if (bundle.driver !== this.provider) throw new Error(`Recovery bundle belongs to ${bundle.driver}, not ${this.provider}`);
    if (input.sessionId && input.sessionId !== bundle.sessionId) throw new Error('Recovery bundle session does not match requested session');
    const existing = this.sessions.get(bundle.sessionId);
    if (existing && existing.runId !== bundle.runId) throw new Error('Recovery bundle run does not match existing session');
    if (existing && existing.state !== 'idle') throw new Error(`Cannot resume ${existing.state} session`);
    if (!bundle.recoveryStateRef) throw new Error('Recovery bundle has no trusted recovery state reference');
    await this.guard.assertCurrent(bundle);
    const recoveryContext = await this.recovery.restore(bundle.recoveryStateRef);
    const afterRestore = this.sessions.get(bundle.sessionId);
    if (afterRestore && afterRestore.state !== 'idle') throw new Error(`Cannot resume ${afterRestore.state} session`);
    if (afterRestore && afterRestore.runId !== bundle.runId) throw new Error('Recovery bundle run does not match existing session');
    await this.guard.assertCurrent(bundle);
    const afterGuard = this.sessions.get(bundle.sessionId);
    if (afterGuard && afterGuard.state !== 'idle') throw new Error(`Cannot resume ${afterGuard.state} session`);
    if (afterGuard && afterGuard.runId !== bundle.runId) throw new Error('Recovery bundle run does not match existing session');
    this.sessions.set(bundle.sessionId, { ...bundle, state: 'idle', invocation: afterGuard?.invocation ?? 0, cancellationRequested: false, recoveryContext });
    return { sessionId: bundle.sessionId };
  }

  async send_event(input: { sessionId: string; eventRef: string }): Promise<void> {
    const session = requireSession(this.sessions, input.sessionId);
    await this.guard.assertCurrent(session);
    session.eventRefs.push(input.eventRef);
  }

  async checkpoint(input: { sessionId: string }): Promise<{ bundleRef: string }> {
    const session = requireSession(this.sessions, input.sessionId);
    await this.guard.assertCurrent(session);
    const captured = await this.recovery.capture({ driver: this.provider, runId: session.runId, sessionId: session.sessionId, mode: session.mode, contextRefs: [...session.contextRefs], eventRefs: [...session.eventRefs] });
    await this.guard.assertCurrent(session);
    session.recoveryStateRef = captured.recoveryStateRef;
    const bundleRef = await this.artifacts.saveRecoveryBundle({ driver: this.provider, runId: session.runId, sessionId: session.sessionId, providerSessionId: session.providerSessionId, mode: session.mode, contextRefs: [...session.contextRefs], eventRefs: [...session.eventRefs], recoveryStateRef: session.recoveryStateRef });
    return { bundleRef };
  }

  async handoff(input: { sessionId: string }): Promise<{ bundleRef: string; outgoingSummaryRef?: string }> {
    return this.checkpoint(input);
  }

  abstract invoke(input: { sessionId: string; objectiveRef: string; contextRefs: string[] }): Promise<{ resultRef: string }>;
  abstract interrupt(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }>;
  abstract stop(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }>;

  protected begin(session: Session): number {
    if (session.state !== 'idle') throw new Error(`${this.provider} session is ${session.state}`);
    session.state = 'active'; session.cancellationRequested = false; session.invocation += 1; return session.invocation;
  }
  protected continuing(session: Session, invocation: number): void {
    if (session.invocation !== invocation || session.cancellationRequested || session.state !== 'active') throw new Error('Orchestrator invocation is no longer active');
  }
  protected finish(session: Session, invocation: number): void {
    if (session.invocation === invocation) session.state = session.cancellationRequested ? 'stopped' : 'idle';
  }
  protected async prompt(session: Session, objectiveRef: string, contextRefs: string[]): Promise<string> {
    const refs = [...new Set([...session.contextRefs, ...contextRefs])];
    const [objective, ...context] = await Promise.all([this.artifacts.readText(objectiveRef), ...refs.map((ref) => this.artifacts.readText(ref))]);
    const events = await Promise.all(session.eventRefs.map((ref) => this.artifacts.readText(ref)));
    return JSON.stringify({ recovery: session.recoveryContext, objective, context, events });
  }
}

/** Fable uses the pinned Claude SDK's in-process MCP tool bridge. */
export class FableDriver extends BaseDriver {
  protected readonly provider = 'fable' as const;
  readonly #queries = new Map<string, ReturnType<FableSdk['query']>>();

  constructor(artifacts: OrchestratorArtifacts, private readonly tools: HelmToolRegistry, guard: OrchestratorSessionGuard, recovery: OrchestratorRecoveryState, private readonly host: FableHostOptions, private readonly sdk?: FableSdk) { super(artifacts, guard, recovery); }

  async invoke(input: { sessionId: string; objectiveRef: string; contextRefs: string[] }): Promise<{ resultRef: string }> {
    const session = requireSession(this.sessions, input.sessionId);
    await this.guard.assertCurrent(session); const invocation = this.begin(session);
    const messages: ClaudeSdk.SDKMessage[] = [];
    try {
      const sdk = this.sdk ?? await loadFableSdk();
      const prompt = await this.prompt(session, input.objectiveRef, input.contextRefs);
      await this.guard.assertCurrent(session); this.continuing(session, invocation);
      const helm = sdk.createSdkMcpServer({ name: 'helm', tools: this.tools.all().map((entry) => sdk.tool(entry.name, entry.description, entry.input, async (args) => {
        if (session.mode !== 'primary') return { content: [{ type: 'text', text: JSON.stringify({ state: 'refused', reason: 'Consultant sessions cannot issue Helm tool effects' }) }] };
        await this.guard.assertCurrent(session); this.continuing(session, invocation);
        const result = await this.tools.invoke(entry.name, args, { runId: session.runId, sessionId: session.sessionId, mode: session.mode });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      })) });
      const stream = sdk.query({ prompt, options: { resume: session.providerSessionId, tools: [], permissionMode: 'dontAsk', mcpServers: { helm }, strictMcpConfig: true, env: this.host.env, cwd: this.host.cwd, model: this.host.model, settingSources: [] } });
      this.#queries.set(session.sessionId, stream);
      for await (const message of stream) { messages.push(message); session.providerSessionId ??= providerSessionId(message); }
      const resultRef = await this.artifacts.saveInvocation({ driver: this.provider, sessionId: session.sessionId, providerSessionId: session.providerSessionId, outcome: fableOutcome(messages), text: JSON.stringify(messages) });
      return { resultRef };
    } catch (error) {
      await this.artifacts.saveInvocation({ driver: this.provider, sessionId: session.sessionId, providerSessionId: session.providerSessionId, outcome: 'unknown', text: JSON.stringify({ messages, error: error instanceof Error ? error.message : 'Fable stream failed' }) });
      throw error;
    } finally { this.#queries.delete(session.sessionId); this.finish(session, invocation); }
  }

  async interrupt(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }> {
    const session = findSession(this.sessions, input.sessionId);
    await this.guard.assertCurrent(session);
    if (session.state === 'stopped') return { observed: 'stopped' };
    if (session.state === 'idle') return { observed: 'stopped' };
    const stream = this.#queries.get(session.sessionId);
    if (!stream) { session.cancellationRequested = true; session.state = 'stopping'; return { observed: 'unknown' }; }
    session.cancellationRequested = true; session.state = 'stopping';
    await stream.interrupt();
    return { observed: 'unknown' };
  }

  async stop(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }> {
    const session = findSession(this.sessions, input.sessionId);
    await this.guard.assertCurrent(session);
    if (session.state === 'stopped') return { observed: 'stopped' };
    if (session.state === 'idle') { session.state = 'stopped'; return { observed: 'stopped' }; }
    const stream = this.#queries.get(session.sessionId);
    session.cancellationRequested = true; session.state = 'stopping';
    if (stream) stream.close();
    return { observed: 'unknown' };
  }
}

/** Astra maps threads and turns to the pinned Codex SDK; its tool transport is not exposed by that SDK surface. */
export class AstraDriver extends BaseDriver {
  protected readonly provider = 'astra' as const;
  readonly toolBridge = { state: 'unsupported' as const, reason: 'Codex SDK 0.154.0 ThreadOptions has no in-process tool callback or MCP server configuration.' };
  readonly #threads = new Map<string, Thread>();
  readonly #controllers = new Map<string, AbortController>();

  constructor(artifacts: OrchestratorArtifacts, guard: OrchestratorSessionGuard, recovery: OrchestratorRecoveryState, private readonly sdk: AstraSdk, private readonly options: ThreadOptions = { approvalPolicy: 'never', sandboxMode: 'read-only', networkAccessEnabled: false, webSearchMode: 'disabled', skipGitRepoCheck: true }) { super(artifacts, guard, recovery); }

  override async start(input: { runId: string; contextRefs: string[]; mode: 'primary' | 'consultant' }): Promise<{ sessionId: string }> {
    const started = await super.start(input);
    try { this.#threads.set(started.sessionId, (await this.sdk.create()).startThread(this.options)); }
    catch (error) { this.sessions.delete(started.sessionId); throw error; }
    return started;
  }

  override async resume(input: { sessionId?: string; recoveryBundleRef: string }): Promise<{ sessionId: string }> {
    const bundle = await this.artifacts.loadRecoveryBundle(input.recoveryBundleRef);
    if (bundle.driver !== this.provider || !bundle.providerSessionId) throw new UnsupportedDriverOperation('resume', 'recovery bundle has no matching observed Codex thread id');
    const thread = (await this.sdk.create()).resumeThread(bundle.providerSessionId, this.options);
    const resumed = await super.resume(input);
    const session = requireSession(this.sessions, resumed.sessionId);
    if (!session.providerSessionId) throw new UnsupportedDriverOperation('resume', 'recovery bundle has no observed Codex thread id');
    this.#threads.set(session.sessionId, thread);
    return resumed;
  }

  async invoke(input: { sessionId: string; objectiveRef: string; contextRefs: string[] }): Promise<{ resultRef: string }> {
    const session = requireSession(this.sessions, input.sessionId);
    const thread = this.#threads.get(session.sessionId);
    if (!thread) throw new Error(`No Codex thread for Helm session: ${session.sessionId}`);
    await this.guard.assertCurrent(session); const invocation = this.begin(session);
    const controller = new AbortController(); this.#controllers.set(session.sessionId, controller);
    const observed: ThreadEvent[] = [];
    try {
      const prompt = await this.prompt(session, input.objectiveRef, input.contextRefs);
      await this.guard.assertCurrent(session); this.continuing(session, invocation);
      const { events } = await thread.runStreamed(prompt, { signal: controller.signal });
      for await (const event of events) { observed.push(event); session.providerSessionId ??= providerSessionId(event); }
      session.providerSessionId ??= thread.id ?? undefined;
      const resultRef = await this.artifacts.saveInvocation({ driver: this.provider, sessionId: session.sessionId, providerSessionId: session.providerSessionId, outcome: astraOutcome(observed), text: JSON.stringify(observed) });
      return { resultRef };
    } catch (error) {
      await this.artifacts.saveInvocation({ driver: this.provider, sessionId: session.sessionId, providerSessionId: session.providerSessionId, outcome: 'unknown', text: JSON.stringify({ events: observed, error: error instanceof Error ? error.message : 'Astra stream failed' }) });
      throw error;
    } finally { this.#controllers.delete(session.sessionId); this.finish(session, invocation); }
  }

  async interrupt(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }> {
    const session = findSession(this.sessions, input.sessionId);
    await this.guard.assertCurrent(session);
    if (session.state === 'stopped') return { observed: 'stopped' };
    if (session.state === 'idle') return { observed: 'stopped' };
    const controller = this.#controllers.get(session.sessionId);
    if (!controller) { session.cancellationRequested = true; session.state = 'stopping'; return { observed: 'unknown' }; }
    session.cancellationRequested = true; session.state = 'stopping';
    controller.abort();
    return { observed: 'unknown' };
  }

  async stop(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }> {
    const result = await this.interrupt(input);
    if (result.observed !== 'stopped') return result;
    findSession(this.sessions, input.sessionId).state = 'stopped';
    return result;
  }
}

export { AstraLoopbackMcpTransport, type AstraLoopbackMcpClose, type AstraLoopbackMcpConfig, type AstraLoopbackSession } from './astra-loopback-mcp.js';
