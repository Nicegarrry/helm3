import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import type { AgentSession, AgentSessionEvent, ExtensionRuntime, ModelRuntime, ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import { BoundedPiAccess } from '../../access/index.js';
import { assertPiThinkingSupported } from '../../access/thinking-support.js';
import { observePiContext } from '../../context/index.js';
import { PiEventSpool } from './event-spool.js';
import { rawArtifactRefSchema, workerResultSchema, type RawArtifactRef, type WorkerResult } from '../../contracts/index.js';
import type { ArtifactJournal } from '../../journal/index.js';
import type { WorktreeOwner, WorktreeReservation, WorkspaceManager } from '../../workspace/index.js';
import { z } from 'zod/v3';

export type PiEffect = Readonly<{ effectId: string; kind: 'model.request' | 'workspace.write'; commandId: string }>;
export type PiCompactEffect = Readonly<{ effectId: string; commandId: string }>;
/** Trusted host must admit, claim, reserve and observe each effect. No authority is passed to the model. */
export interface PiAuthority {
  perform(effect: PiEffect, action: () => Promise<void>): Promise<void>;
  /** Separate non-monetary Core command for a manual compaction control effect. */
  performCompact?(effect: PiCompactEffect, action: () => Promise<readonly RawArtifactRef[]>): Promise<void>;
  requestCancellation(commandId: string): Promise<void>;
  reportWorkerStop(commandId: string, observed: 'stopped' | 'pending' | 'unknown'): Promise<void>;
}
const piThinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type PiThinkingLevel = z.infer<typeof piThinkingLevelSchema>;
const piThinkingPolicySchema = z.object({ level: piThinkingLevelSchema }).strict();
/** Trusted runtime configuration. It records Pi's selected SDK setting, never a provider reasoning guarantee. */
export type PiThinkingPolicy = Readonly<z.infer<typeof piThinkingPolicySchema>>;
export const defaultPiThinkingPolicy: PiThinkingPolicy = Object.freeze({ level: 'medium' });
export type PiWorkerInput = Readonly<{
  commandId: string; attemptId: string; workspace: WorktreeReservation; owner: WorktreeOwner;
  workspaceManager: WorkspaceManager; authority: PiAuthority; journal: ArtifactJournal;
  stateRoot: string; modelRuntime: ModelRuntime; model: Model<Api>;
  /** Optional live-provider boundary. Omission preserves provider-free fixture behaviour. */
  access?: BoundedPiAccess;
  /** Trusted host setting. The explicit default is forwarded to Pi rather than relying on its implicit default. */
  thinking?: PiThinkingPolicy;
  /** Review sessions deliberately receive no filesystem, shell, or mutation tools. */
  mode?: 'worker' | 'review-readonly';
}>;
/**
 * Host-only continuation evidence.  A persisted Pi transcript is useful only
 * when the host can prove that reopening it preserves this exact native ID.
 */
export type PiPersistedSession = Readonly<{ sessionId: string; sessionFile: string; historyHash: string; branchDigest: string }>;
/** Evidence returned by an idle native branch fork. No provider request is made. */
export type PiForkedSession = Readonly<{ worker: PiNativeWorker; predecessor: PiPersistedSession; successor: PiPersistedSession; leafId: string }>;
/** Read-only, host-trusted source facts needed to admit one exact native fork. */
export type PiForkSourceSnapshot = Readonly<{ sessionId: string; historyHash: string; branchDigest: string; leafId: string }>;
/** Caller-selected immutable evidence only; this API never discovers transcripts or tracker state. */
export type PiCheckpointEvidence = Readonly<{ sourceIdentity: string; raw: RawArtifactRef }>;
export type PiManualCheckpoint = Readonly<{ objective: PiCheckpointEvidence; acceptance: PiCheckpointEvidence; brief: PiCheckpointEvidence; map: PiCheckpointEvidence; decisions: readonly PiCheckpointEvidence[]; handoffs: readonly PiCheckpointEvidence[] }>;
/** A trusted host binds this to a distinct Core pi.compact command. It carries no monetary reservation: every summary remains a guarded pi.model request. */
export type PiManualCompaction = Readonly<{ commandId: string; effectId: string; checkpoint: PiManualCheckpoint }>;
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
/** Accept only direct JSON or one whole JSON fence; raw terminal bytes are journaled unchanged. */
export function parseEnvelope(text: string): WorkerResult | undefined {
  const fenced = text.match(/^```json\r?\n([\s\S]*)\r?\n```$/);
  const candidate = fenced ? fenced[1] : text;
  try { return workerResultSchema.parse(JSON.parse(candidate)); } catch { return undefined; }
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
  private reviewReadCalls = 0;
  private thinking!: Readonly<{ requested: PiThinkingLevel; nativeSelected: PiThinkingLevel; providerEffective: 'unknown' }>;
  private constructor(private readonly input: PiWorkerInput) {}
  get sessionId(): string { return this.session.getSessionStats().sessionId; }
  get isActive(): boolean { return this.running || this.activeRequests.size > 0; }
  /** Read-only observation; missing Pi SDK usage remains explicitly unknown. */
  get contextOccupancy() { return observePiContext(this.session); }
  /** Pi's requested and selected SDK setting; providers may ignore or translate it. */
  get thinkingConfiguration(): Readonly<{ requested: PiThinkingLevel; nativeSelected: PiThinkingLevel; providerEffective: 'unknown' }> { return this.thinking; }
  /** Immutable SDK model selected by the trusted host at worker creation. */
  get modelIdentity(): Readonly<{ modelId: string; provider: string; api: string }> {
    return Object.freeze({ modelId: this.input.model.id, provider: this.input.model.provider, api: this.input.model.api });
  }
  /**
   * A durable host record may retain this identity after this wrapper is
   * disposed.  It is deliberately unavailable until Pi has a session file.
   */
  async persistedSession(): Promise<PiPersistedSession> {
    const stats = this.session.getSessionStats();
    if (!stats.sessionFile || !stats.sessionId) throw new Error('Pi has not persisted this session yet');
    const branchDigest = `sha256:${createHash('sha256').update(JSON.stringify(this.session.sessionManager.getBranch())).digest('hex')}`;
    return Object.freeze({ sessionId: stats.sessionId, sessionFile: stats.sessionFile, historyHash: `sha256:${createHash('sha256').update(await readFile(stats.sessionFile)).digest('hex')}`, branchDigest });
  }

  static async start(input: PiWorkerInput): Promise<PiNativeWorker> {
    input.workspaceManager.assertOwner(input.workspace, input.owner);
    await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(input.stateRoot);
    const path = relative(input.workspace.root, stateRoot);
    if (!isAbsolute(path) && path !== '..' && !path.startsWith('../')) throw new Error('Pi state must be outside the writable worktree');
    const worker = new PiNativeWorker({ ...input, stateRoot }); await worker.initialize(); return worker;
  }
  /**
   * Rehydrate a persisted idle Pi session into a new wrapper.  The caller
   * supplies a fresh command/attempt/authority binding; this method never
   * carries authority from the earlier wrapper across an invocation boundary.
   */
  static async rehydrate(input: PiWorkerInput, persisted: PiPersistedSession): Promise<PiNativeWorker> {
    if (!persisted.sessionId.trim() || !persisted.sessionFile.trim() || !/^sha256:[0-9a-f]{64}$/.test(persisted.historyHash) || !/^sha256:[0-9a-f]{64}$/.test(persisted.branchDigest)) throw new Error('Pi persisted session identity is required');
    input.workspaceManager.assertOwner(input.workspace, input.owner);
    await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(input.stateRoot);
    const statePath = relative(input.workspace.root, stateRoot);
    if (!isAbsolute(statePath) && statePath !== '..' && !statePath.startsWith('../')) throw new Error('Pi state must be outside the writable worktree');
    const sessionRoot = await realpath(join(stateRoot, 'sessions'));
    const sessionFile = await realpath(persisted.sessionFile);
    const sessionPath = relative(sessionRoot, sessionFile);
    if (isAbsolute(sessionPath) || sessionPath === '..' || sessionPath.startsWith('../')) throw new Error('Pi persisted session is outside the trusted state root');
    if (`sha256:${createHash('sha256').update(await readFile(sessionFile)).digest('hex')}` !== persisted.historyHash) throw new Error('persisted Pi session history changed');
    const worker = new PiNativeWorker({ ...input, stateRoot });
    await worker.initialize(sessionFile);
    if (worker.sessionId !== persisted.sessionId) {
      worker.dispose();
      throw new Error('reopened Pi session identity changed');
    }
    const branchDigest = `sha256:${createHash('sha256').update(JSON.stringify(worker.session.sessionManager.getBranch())).digest('hex')}`;
    if (branchDigest !== persisted.branchDigest) {
      worker.dispose();
      throw new Error('reopened Pi session branch changed');
    }
    return worker;
  }
  /**
   * Copy the current persisted Pi branch into a fresh native session. This is
   * intentionally idle: the caller must create a separate Helm continuation
   * command before it can request a model turn.
   */
  static async inspectForkSource(input: Pick<PiWorkerInput, 'workspace' | 'workspaceManager' | 'owner' | 'stateRoot'>, persisted: PiPersistedSession): Promise<PiForkSourceSnapshot> {
    if (!persisted.sessionId.trim() || !persisted.sessionFile.trim() || !/^sha256:[0-9a-f]{64}$/.test(persisted.historyHash) || !/^sha256:[0-9a-f]{64}$/.test(persisted.branchDigest)) throw new Error('Pi persisted session identity is required');
    input.workspaceManager.assertOwner(input.workspace, input.owner);
    await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(input.stateRoot);
    const statePath = relative(input.workspace.root, stateRoot);
    if (!isAbsolute(statePath) && statePath !== '..' && !statePath.startsWith('../')) throw new Error('Pi state must be outside the writable worktree');
    const sessionRoot = await realpath(join(stateRoot, 'sessions'));
    const sourceFile = await realpath(persisted.sessionFile);
    const sourcePath = relative(sessionRoot, sourceFile);
    if (isAbsolute(sourcePath) || sourcePath === '..' || sourcePath.startsWith('../')) throw new Error('Pi persisted session is outside the trusted state root');
    if (`sha256:${createHash('sha256').update(await readFile(sourceFile)).digest('hex')}` !== persisted.historyHash) throw new Error('persisted Pi session history changed');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(sourceFile, sessionRoot, input.workspace.root);
    if (manager.getSessionId() !== persisted.sessionId) throw new Error('persisted Pi session identity changed');
    const leafId = manager.getLeafId();
    const branchDigest = `sha256:${createHash('sha256').update(JSON.stringify(manager.getBranch())).digest('hex')}`;
    if (!leafId || branchDigest !== persisted.branchDigest) throw new Error('persisted Pi session branch changed');
    return Object.freeze({ sessionId: persisted.sessionId, historyHash: persisted.historyHash, branchDigest, leafId });
  }
  static async forkAtCurrentTip(input: PiWorkerInput, persisted: PiPersistedSession, expectedLeafId?: string): Promise<PiForkedSession> {
    const source = await PiNativeWorker.inspectForkSource(input, persisted);
    if (expectedLeafId && source.leafId !== expectedLeafId) throw new Error('persisted Pi session leaf changed');
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const stateRoot = await realpath(input.stateRoot); const sessionRoot = await realpath(join(stateRoot, 'sessions'));
    const manager = SessionManager.open(await realpath(persisted.sessionFile), sessionRoot, input.workspace.root);
    const forkFile = manager.createBranchedSession(source.leafId);
    if (!forkFile) throw new Error('Pi persisted session fork was not written');
    const worker = new PiNativeWorker({ ...input, stateRoot });
    try {
      await worker.initialize(forkFile);
      const successor = await worker.persistedSession();
      if (successor.sessionId === persisted.sessionId || successor.branchDigest !== persisted.branchDigest) throw new Error('Pi fork did not create the expected independent current branch');
      return Object.freeze({ worker, predecessor: persisted, successor, leafId: source.leafId });
    } catch (error) { worker.dispose(); throw error; }
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
    const requestedThinking = piThinkingPolicySchema.parse(this.input.thinking ?? defaultPiThinkingPolicy).level;
    assertPiThinkingSupported(this.input.model, requestedThinking);
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
    const readParameters = Type.Object({ path: Type.String({ minLength: 1 }) });
    const readTool: ToolDefinition<typeof readParameters> = {
      name: 'helm_read', label: 'Helm read', description: 'Read up to 64 KiB from an allowed file in the assigned review worktree.', parameters: readParameters, executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        this.assertActive(); await this.flushEvents(); this.assertActive();
        if (this.reviewReadCalls >= 16) throw new Error('review read call bound exceeded');
        this.reviewReadCalls += 1;
        const text = await this.input.workspaceManager.read(this.input.workspace, params.path, 64 * 1024);
        return { content: [{ type: 'text', text }], details: {} };
      },
    };
    const reviewReadonly = this.input.mode === 'review-readonly';
    const created = await createAgentSession({
      cwd: this.input.workspace.root, agentDir, modelRuntime: await this.guardedRuntime(), model: this.input.model,
      sessionManager: sessionFile ? SessionManager.open(sessionFile, sessionDir, this.input.workspace.root) : SessionManager.create(this.input.workspace.root, sessionDir),
      // Automatic compaction remains disabled. Manual compaction must not silently
      // change Pi's retained-context policy.
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      thinkingLevel: requestedThinking,
      // This is a tool-surface restriction, not an OS sandbox claim. Review
      // context is captured by the host before launch; Pi has no shell or
      // mutable workspace tool through which to escape it.
      noTools: reviewReadonly ? 'builtin' : 'builtin', tools: reviewReadonly ? ['helm_read'] : ['helm_write'], customTools: reviewReadonly ? [readTool] : [writeTool], resourceLoader: noResources(createExtensionRuntime()),
    });
    this.session = created.session;
    this.thinking = Object.freeze({ requested: requestedThinking, nativeSelected: piThinkingLevelSchema.parse(this.session.thinkingLevel), providerEffective: 'unknown' });
    this.artifacts.push(await this.input.journal.append({ source: 'pi.configuration', sourceIdentity: `pi-configuration:${this.input.attemptId}:${this.sessionId}`,
      mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(this.thinking)) }));
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
  private async saveTerminal(invocation: string, phase: string, afterMessage: number): Promise<WorkerResult | undefined> {
    // A reopened native session retains prior terminal messages. Only an
    // assistant turn appended by this invocation may satisfy its new command;
    // otherwise a no-op prompt could replay an earlier WorkerResult without a
    // fresh model effect or correction.
    const text = this.lastAssistantText(afterMessage);
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
    // Automatic compaction is disabled for this worker, so this boundary is a
    // stable invocation marker even when the wrapper was rehydrated.
    const invocationMessage = this.session.messages.length;
    try {
      await this.session.prompt(prompt);
      let result = await this.saveTerminal(invocation, 'initial', invocationMessage); saved = true;
      const repaired = !result;
      if (!result && (this.input.access?.correctionAllowed ?? true)) {
        this.assertActive();
        const correctionMessage = this.session.messages.length;
        await this.session.prompt(correction, { streamingBehavior: 'followUp' });
        result = await this.saveTerminal(invocation, 'correction', correctionMessage);
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
      if (!saved) await this.saveTerminal(invocation, 'interrupted', invocationMessage);
      await this.flushEvents();
      throw error;
    } finally { this.running = false; }
  }
  /** Host-owned, idle-only manual compaction. The public AgentSession API keeps every summary request inside guardedRuntime. */
  async manualCompact(request: PiManualCompaction): Promise<readonly RawArtifactRef[]> {
    this.assertActive();
    if (this.isActive) throw new Error('Pi compaction requires an idle owned worker');
    this.running = true;
    try {
      const commandId = request.commandId;
      const effectId = request.effectId;
      if (!commandId || commandId.trim() !== commandId || !effectId || effectId.trim() !== effectId) throw new Error('Pi compaction command identity must be nonempty and trimmed');
      const freezeEvidence = (entry: PiCheckpointEvidence): PiCheckpointEvidence => Object.freeze({
        sourceIdentity: entry.sourceIdentity,
        // Copy the nested reference before any await; later caller mutation
        // cannot change the already-validated checkpoint.
        raw: Object.freeze(rawArtifactRefSchema.parse({ ref: entry.raw.ref, hash: entry.raw.hash, mediaType: entry.raw.mediaType })),
      });
      const source = request.checkpoint;
      const checkpoint = Object.freeze({
        objective: freezeEvidence(source.objective), acceptance: freezeEvidence(source.acceptance), brief: freezeEvidence(source.brief), map: freezeEvidence(source.map),
        decisions: Object.freeze(source.decisions.map(freezeEvidence)), handoffs: Object.freeze(source.handoffs.map(freezeEvidence)),
      });
      if (checkpoint.handoffs.length === 0) throw new Error('Pi compaction requires at least one immutable handoff reference');
      const evidence = [checkpoint.objective, checkpoint.acceptance, checkpoint.brief, checkpoint.map, ...checkpoint.decisions, ...checkpoint.handoffs];
      const identities = new Set<string>();
      for (const entry of evidence) {
        if (entry.sourceIdentity.trim() !== entry.sourceIdentity || !entry.sourceIdentity) throw new Error('checkpoint source identity must be nonempty and trimmed');
        if (identities.has(entry.sourceIdentity)) throw new Error('checkpoint source identities must be duplicate-free');
        identities.add(entry.sourceIdentity);
      }
      // read() validates copied raw refs, source bindings, classifications and digests.
      await Promise.all(evidence.map((entry) => this.input.journal.read(entry.raw, entry.sourceIdentity)));
      await this.flushEvents(); this.assertActive();
      const before = this.contextOccupancy;
      const sessionId = this.sessionId;
      const branch = this.session.sessionManager.getBranch();
      const branchDigest = `sha256:${createHash('sha256').update(JSON.stringify(branch)).digest('hex')}`;
      const provenance = Object.freeze({ attemptId: this.input.attemptId, workerCommandId: this.input.commandId, compactCommandId: commandId, sessionId, owner: this.input.owner, branchEntries: branch.length, branchDigest });
      if (!this.input.authority.performCompact) throw new Error('Pi compaction requires a distinct admitted host command binding');
      let refs: readonly RawArtifactRef[] | undefined;
      await this.input.authority.performCompact({ effectId, commandId }, async () => {
        this.assertActive();
        const currentBranch = this.session.sessionManager.getBranch();
        const currentDigest = `sha256:${createHash('sha256').update(JSON.stringify(currentBranch)).digest('hex')}`;
        if (this.sessionId !== sessionId || currentDigest !== branchDigest) throw new Error('Pi compaction context changed before the admitted effect');
        const checkpointRef = await this.input.journal.append({ source: 'pi.checkpoint', sourceIdentity: `pi-checkpoint:${this.input.attemptId}:${commandId}`,
          mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, state: 'prepared', provenance, checkpoint, model: { provider: this.input.model.provider, id: this.input.model.id, api: this.input.model.api }, thinking: this.thinking, occupancy: before })) });
        this.artifacts.push(checkpointRef);
        const result = await this.session.compact();
        await this.flushEvents(); this.assertActive();
        const outcome = await this.input.journal.append({ source: 'pi.compaction', sourceIdentity: `pi-compaction:${this.input.attemptId}:${commandId}`,
          mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, state: 'succeeded', provenance, checkpointRef, result, occupancy: this.contextOccupancy })) });
        this.artifacts.push(outcome);
        refs = Object.freeze([checkpointRef, outcome]);
        return refs;
      });
      if (!refs) throw new Error('Pi compaction completed without durable terminal evidence');
      return refs;
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
   * A host-admitted worker.stop owns cancellation intent.  Unlike `cancel`,
   * this method never marks the already-observed spawn command cancelled.
   */
  async stopLocal(timeoutMs = 5_000): Promise<'stopped' | 'unknown'> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) throw new Error('invalid cancellation deadline');
    this.cancelled = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.session.abort().then(async () => { await Promise.all([...this.activeRequests]); return !this.session.isStreaming && this.activeRequests.size === 0 ? 'stopped' as const : 'unknown' as const; }).catch(() => 'unknown' as const),
      new Promise<'unknown'>((resolve) => { timer = setTimeout(() => resolve('unknown'), timeoutMs); }),
    ]);
    clearTimeout(timer);
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
  private lastAssistantText(afterMessage = 0): string {
    const last = this.session.messages.slice(afterMessage).reverse().find((message) => message.role === 'assistant');
    return last && 'content' in last && Array.isArray(last.content) ? last.content.filter((entry) => entry.type === 'text').map((entry) => entry.type === 'text' ? entry.text : '').join('') : '';
  }
}
