import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import type { AgentSession, AgentSessionEvent, ExtensionRuntime, ModelRuntime, ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import { BoundedPiAccess } from '../../access/index.js';
import { observePiContext } from '../../context/index.js';
import { PiEventSpool } from './event-spool.js';
import { workerResultSchema, type RawArtifactRef, type WorkerResult } from '../../contracts/index.js';
import type { ArtifactJournal } from '../../journal/index.js';
import type { WorktreeOwner, WorktreeReservation, WorkspaceManager } from '../../workspace/index.js';

export type PiEffect = Readonly<{ effectId: string; kind: 'model.request' | 'workspace.write'; commandId: string }>;
/** Trusted host must admit, claim, reserve and observe each effect. No authority is passed to the model. */
export interface PiAuthority {
  perform(effect: PiEffect, action: () => Promise<void>): Promise<void>;
  requestCancellation(commandId: string): Promise<void>;
  reportWorkerStop(commandId: string, observed: 'stopped' | 'pending' | 'unknown'): Promise<void>;
}
export type PiWorkerInput = Readonly<{
  commandId: string; attemptId: string; workspace: WorktreeReservation; owner: WorktreeOwner;
  workspaceManager: WorkspaceManager; authority: PiAuthority; journal: ArtifactJournal;
  stateRoot: string; modelRuntime: ModelRuntime; model: Model<Api>;
  /** Optional live-provider boundary. Omission preserves provider-free fixture behaviour. */
  access?: BoundedPiAccess;
}>;
function noResources(runtime: ExtensionRuntime): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => undefined, reload: async () => undefined,
  };
}
function parseEnvelope(text: string): WorkerResult | undefined {
  try { return workerResultSchema.parse(JSON.parse(text)); } catch { return undefined; }
}
/** Provider error bodies can echo request data. Never put them in Pi events or the journal. */
function errorMessage(model: Model<Api>): AssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'error', errorMessage: 'Helm model request failed', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export class PiNativeWorker {
  private session!: AgentSession;
  private unsubscribe: () => void = () => undefined;
  private eventSpool?: PiEventSpool;
  private eventError: unknown;
  private readonly artifacts: RawArtifactRef[] = [];
  private readonly activeRequests = new Set<Promise<void>>();
  private cancelled = false;
  private disposed = false;
  private running = false;
  private constructor(private readonly input: PiWorkerInput) {}
  get sessionId(): string { return this.session.getSessionStats().sessionId; }
  get isActive(): boolean { return this.running || this.activeRequests.size > 0; }
  /** Read-only observation; missing Pi SDK usage remains explicitly unknown. */
  get contextOccupancy() { return observePiContext(this.session); }

  static async start(input: PiWorkerInput): Promise<PiNativeWorker> {
    input.workspaceManager.assertOwner(input.workspace, input.owner);
    await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(input.stateRoot);
    const path = relative(input.workspace.root, stateRoot);
    if (!isAbsolute(path) && path !== '..' && !path.startsWith('../')) throw new Error('Pi state must be outside the writable worktree');
    const worker = new PiNativeWorker({ ...input, stateRoot }); await worker.initialize(); return worker;
  }
  private assertActive(): void {
    if (this.eventError) throw new Error('Pi evidence persistence failed');
    if (this.cancelled || this.disposed) throw new Error('Pi worker is cancelled or disposed');
    this.input.workspaceManager.assertOwner(this.input.workspace, this.input.owner);
  }
  private async guardedRuntime(): Promise<ModelRuntime> {
    const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
    const input = this.input;
    return new Proxy(input.modelRuntime, { get: (target, property) => {
      if (property !== 'streamSimple') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const guarded: ModelRuntime['streamSimple'] = (model, context, options) => {
        const output = createAssistantMessageEventStream();
        const effectId = `model:${randomUUID()}`;
        // Completion stays inside authority.perform; merely constructing a lazy
        // SDK stream must never make the command/resource reservation successful.
        const work = Promise.resolve().then(async () => {
          let terminal: AssistantMessage | undefined;
          try {
            this.assertActive();
            await this.flushEvents();
            this.assertActive();
            const prepared = input.access?.prepare(effectId, model, context, options);
            await input.authority.perform({ effectId, kind: 'model.request', commandId: input.commandId }, async () => {
              this.assertActive();
              // Redact inside the effect: Core records thrown effect failures before
              // the outer Pi loop converts them into a native error message.
              try {
                const source = target.streamSimple(model, context, prepared?.options ?? { ...options, maxRetries: 0 });
                for await (const event of source) {
                  if (event.type === 'done') terminal = event.message;
                  else if (event.type === 'error') terminal = event.error;
                  else output.push(event);
                }
                terminal ??= await source.result();
                if (terminal.stopReason === 'error' || terminal.stopReason === 'aborted') throw new Error('provider request did not complete');
                input.access?.settle(effectId, terminal);
              } catch {
                throw new Error('Pi provider request failed');
              }
            });
            if (!terminal) throw new Error('model stream completed without a terminal observation');
            output.push({ type: 'done', reason: terminal.stopReason as 'stop' | 'length' | 'toolUse', message: terminal });
          } catch (error) {
            if (input.access?.hasReservation(effectId)) input.access.unknown(effectId, error instanceof Error ? error.message : 'provider request did not complete');
            output.push({ type: 'error', reason: 'error', error: errorMessage(model) });
          }
          finally { output.end(); }
        });
        this.activeRequests.add(work);
        void work.finally(() => this.activeRequests.delete(work));
        return output;
      };
      return guarded;
    } });
  }
  private async initialize(sessionFile?: string): Promise<void> {
    const { createAgentSession, SessionManager, SettingsManager, createExtensionRuntime } = await import('@earendil-works/pi-coding-agent');
    const { Type } = await import('typebox');
    const sessionDir = join(this.input.stateRoot, 'sessions');
    const agentDir = join(this.input.stateRoot, 'agent');
    await Promise.all([mkdir(sessionDir, { recursive: true, mode: 0o700 }), mkdir(agentDir, { recursive: true, mode: 0o700 })]);
    const parameters = Type.Object({ path: Type.String({ minLength: 1 }), contents: Type.String() });
    const writeTool: ToolDefinition<typeof parameters> = {
      name: 'helm_write', label: 'Helm write', description: 'Write UTF-8 content to an allowed file in the assigned worktree.', parameters, executionMode: 'sequential',
      execute: async (toolCallId, params) => {
        this.assertActive();
        this.input.access?.noteToolCall();
        await this.flushEvents();
        this.assertActive();
        await this.input.authority.perform({ effectId: `tool:${toolCallId}`, kind: 'workspace.write', commandId: this.input.commandId }, async () => {
          this.assertActive(); await this.input.workspaceManager.write(this.input.workspace, this.input.owner, params.path, params.contents);
        });
        return { content: [{ type: 'text', text: `wrote ${params.path}` }], details: {} };
      },
    };
    const created = await createAgentSession({
      cwd: this.input.workspace.root, agentDir, modelRuntime: await this.guardedRuntime(), model: this.input.model,
      sessionManager: sessionFile ? SessionManager.open(sessionFile, sessionDir, this.input.workspace.root) : SessionManager.create(this.input.workspace.root, sessionDir),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      noTools: 'builtin', tools: ['helm_write'], customTools: [writeTool], resourceLoader: noResources(createExtensionRuntime()),
    });
    this.session = created.session;
    this.eventSpool = new PiEventSpool(this.input.journal, { commandId: this.input.commandId, attemptId: this.input.attemptId, sessionId: this.sessionId });
    this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
      try {
        this.eventSpool!.record(event);
        if (this.eventSpool!.state.overflow) throw new Error('Pi event evidence has an unknown tail');
      }
      catch (error) { this.eventError ??= error; void this.session.abort(); }
    });
  }
  private async flushEvents(): Promise<void> {
    if (!this.eventSpool) throw new Error('Pi event spool is unavailable');
    try { this.artifacts.push(...await this.eventSpool.drain()); }
    catch (error) { this.eventError ??= error; }
  }
  private async saveTerminal(invocation: string, phase: string): Promise<WorkerResult | undefined> {
    const text = this.lastAssistantText();
    const result = parseEnvelope(text);
    const ref = await this.input.journal.append({ source: 'pi.envelope', sourceIdentity: `pi-envelope:${this.input.attemptId}:${invocation}:${phase}`,
      mediaType: 'text/plain; charset=utf-8', bytes: Buffer.from(text) });
    this.artifacts.push(ref);
    if (!result) this.artifacts.push(await this.input.journal.append({ source: 'pi.envelope_disposition', sourceIdentity: `pi-envelope-disposition:${invocation}:${phase}`,
      mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ status: text ? 'envelope_invalid' : 'envelope_missing', rawRef: ref, attemptId: this.input.attemptId })) }));
    return result;
  }
  async run(prompt: string, correction: string): Promise<{ result: WorkerResult; artifacts: RawArtifactRef[]; repaired: boolean }> {
    this.assertActive();
    if (this.running) throw new Error('Pi worker already has an active invocation');
    this.running = true;
    const invocation = randomUUID(); let saved = false;
    try {
      await this.session.prompt(prompt);
      let result = await this.saveTerminal(invocation, 'initial'); saved = true;
      const repaired = !result;
      if (!result && (this.input.access?.correctionAllowed ?? true)) {
        this.assertActive();
        await this.session.prompt(correction, { streamingBehavior: 'followUp' });
        result = await this.saveTerminal(invocation, 'correction');
      }
      if (!result) throw new Error('Pi session did not produce a valid terminal WorkerResult after bounded correction');
      const changed = await this.input.workspaceManager.changedFiles(this.input.workspace);
      if (JSON.stringify([...result.changed_files].sort()) !== JSON.stringify(changed)) throw new Error('WorkerResult changed_files claim does not match observed changes');
      await this.flushEvents();
      if (this.eventError) throw new Error('Pi evidence persistence failed');
      const contextOccupancy = observePiContext(this.session);
      this.artifacts.push(await this.input.journal.append({ source: 'pi.usage', sourceIdentity: `pi-usage:${this.input.attemptId}:${invocation}`, mediaType: 'application/json',
        bytes: Buffer.from(JSON.stringify({ commandId: this.input.commandId, attemptId: this.input.attemptId, sessionId: this.sessionId,
          observedTokens: this.session.getSessionStats().tokens, contextOccupancy, cost: { state: 'unknown' } })) }));
      return { result, artifacts: [...this.artifacts], repaired };
    } catch (error) {
      if (!saved) await this.saveTerminal(invocation, 'interrupted');
      await this.flushEvents();
      throw error;
    } finally { this.running = false; }
  }
  async cancel(timeoutMs = 5_000): Promise<'stopped' | 'unknown'> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) throw new Error('invalid cancellation deadline');
    this.cancelled = true;
    await this.input.authority.requestCancellation(this.input.commandId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.session.abort().then(async () => { await Promise.all([...this.activeRequests]); return !this.session.isStreaming && this.activeRequests.size === 0 ? 'stopped' as const : 'unknown' as const; }).catch(() => 'unknown' as const),
      new Promise<'unknown'>((resolve) => { timer = setTimeout(() => resolve('unknown'), timeoutMs); }),
    ]);
    clearTimeout(timer);
    await this.input.authority.reportWorkerStop(this.input.commandId, result);
    return result;
  }
  /**
   * A failed invocation has no trustworthy terminal effect observation yet.
   * Stop the local session, but quarantine the parent attempt rather than
   * claiming it stopped cleanly while its outer host effect is still unknown.
   */
  async abortAfterFailure(timeoutMs = 5_000): Promise<'stopped' | 'unknown'> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) throw new Error('invalid cancellation deadline');
    this.cancelled = true;
    await this.input.authority.requestCancellation(this.input.commandId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.session.abort().then(async () => { await Promise.all([...this.activeRequests]); return !this.session.isStreaming && this.activeRequests.size === 0 ? 'stopped' as const : 'unknown' as const; }).catch(() => 'unknown' as const),
      new Promise<'unknown'>((resolve) => { timer = setTimeout(() => resolve('unknown'), timeoutMs); }),
    ]);
    clearTimeout(timer);
    await this.input.authority.reportWorkerStop(this.input.commandId, 'unknown');
    return result;
  }
  async reopen(): Promise<PiNativeWorker> {
    this.assertActive();
    if (this.running || this.activeRequests.size) throw new Error('cannot reopen an active Pi session');
    const stats = this.session.getSessionStats();
    if (!stats.sessionFile) throw new Error('Pi has not persisted this session yet');
    await this.flushEvents();
    this.unsubscribe(); this.session.dispose();
    await this.initialize(stats.sessionFile);
    if (this.sessionId !== stats.sessionId) throw new Error('reopened Pi session identity changed');
    return this;
  }
  dispose(): void {
    if (this.running || this.activeRequests.size) throw new Error('cancel and observe the worker before disposing');
    this.disposed = true; this.unsubscribe(); this.session.dispose();
  }
  private lastAssistantText(): string {
    const last = [...this.session.messages].reverse().find((message) => message.role === 'assistant');
    return last && 'content' in last && Array.isArray(last.content) ? last.content.filter((entry) => entry.type === 'text').map((entry) => entry.type === 'text' ? entry.text : '').join('') : '';
  }
}
