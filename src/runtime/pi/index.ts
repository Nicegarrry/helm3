import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { workerResultSchema, type RawArtifactRef, type WorkerResult } from '../../contracts/index.js';
import type { ArtifactJournal } from '../../journal/index.js';
import type { WorktreeOwner, WorktreeReservation, WorkspaceManager } from '../../workspace/index.js';


export type PiEffect = Readonly<{ effectId: string; kind: 'model.request' | 'workspace.write'; commandId: string }>;

/** Implemented by the trusted authority host. It must run the effect through its
 * admitted command, claim and fresh guard; Pi never receives authority state. */
export interface PiAuthority {
  perform(effect: PiEffect, action: () => Promise<void>): Promise<void>;
  requestCancellation(commandId: string): Promise<void>;
  reportWorkerStop(commandId: string, observed: 'stopped' | 'pending' | 'unknown'): Promise<void>;
}

export type PiWorkerInput = Readonly<{
  commandId: string;
  attemptId: string;
  workspace: WorktreeReservation;
  owner: WorktreeOwner;
  workspaceManager: WorkspaceManager;
  authority: PiAuthority;
  journal: ArtifactJournal;
  stateRoot: string;
  modelRuntime: unknown;
  model: unknown;
}>;

function noResources(runtime: unknown) { return {
  getExtensions: () => ({ extensions: [], errors: [], runtime }),
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
}; }

function toolResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: { text }, ...(isError ? { isError } : {}) };
}

function parseTerminalEnvelope(text: string): WorkerResult | undefined {
  try { return workerResultSchema.parse(JSON.parse(text)); } catch { return undefined; }
}

/** The SDK calls `streamSimple` for every turn, including automatic turns after
 * a tool result.  Delay the trusted guard until the lazy stream is consumed. */
async function guardedModelRuntime(input: PiWorkerInput): Promise<any> {
  const { lazyStream } = await import('@earendil-works/pi-ai');
  return new Proxy(input.modelRuntime as object, { get(target, property, receiver) {
    if (property !== 'streamSimple') return Reflect.get(target, property, receiver);
    const original = Reflect.get(target, property, receiver) as (model: unknown, context: unknown, options?: object) => any;
    return (model: any, context: unknown, options?: object) => lazyStream(model, async () => {
      let stream: any;
      await input.authority.perform({ effectId: `model:${randomUUID()}`, kind: 'model.request', commandId: input.commandId }, async () => {
        stream = original.call(target, model, context, { ...options, maxRetries: 0 });
      });
      return stream;
    });
  } });
}

export class PiNativeWorker {
  private constructor(
    private readonly input: PiWorkerInput,
  private readonly session: any,
    readonly sessionId: string,
    private readonly unsubscribe: () => void,
    private readonly artifacts: RawArtifactRef[],
    private readonly waitForEvents: () => Promise<void>,
  ) {}

  static async start(input: PiWorkerInput): Promise<PiNativeWorker> {
    await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
    const sessionDir = join(input.stateRoot, 'sessions');
    const agentDir = join(input.stateRoot, 'agent');
    await Promise.all([mkdir(sessionDir, { recursive: true, mode: 0o700 }), mkdir(agentDir, { recursive: true, mode: 0o700 })]);
    const events: RawArtifactRef[] = [];
    let eventFlush = Promise.resolve();
    const [{ createAgentSession, SessionManager, createExtensionRuntime }, { Type }] = await Promise.all([
      import('@earendil-works/pi-coding-agent'), import('typebox'),
    ]);
    const writeTool: any = {
      name: 'helm_write', label: 'Helm write', description: 'Write a new UTF-8 file inside the assigned worktree.',
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), contents: Type.String() }), executionMode: 'sequential',
      execute: async (toolCallId: string, params: { path: string; contents: string }) => {
        try {
          await input.authority.perform({ effectId: `tool:${toolCallId}`, kind: 'workspace.write', commandId: input.commandId }, async () => {
            await input.workspaceManager.write(input.workspace, input.owner, params.path, params.contents);
          });
          return toolResult(`wrote ${params.path}`);
        } catch (error) { return toolResult(`refused: ${(error as Error).message}`, true); }
      },
    };
    const created = await createAgentSession({
      cwd: input.workspace.root, agentDir, modelRuntime: await guardedModelRuntime(input), model: input.model as any,
      sessionManager: SessionManager.create(input.workspace.root, sessionDir),
      noTools: 'builtin', tools: ['helm_write'], customTools: [writeTool], resourceLoader: noResources(createExtensionRuntime()) as any,
    });
    const sessionId = created.session.getSessionStats().sessionId;
    const unsubscribe = created.session.subscribe((event) => {
      const sourceIdentity = `pi-event:${sessionId}:${randomUUID()}`;
      eventFlush = eventFlush.then(() => input.journal.append({ source: 'pi.event', sourceIdentity, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ commandId: input.commandId, attemptId: input.attemptId, sessionId, event })) })
        .then((ref) => { events.push(ref); }));
    });
    return new PiNativeWorker(input, created.session, sessionId, unsubscribe, events, () => eventFlush);
  }

  /** Prompts and a bounded correction remain in this same native Pi session. */
  async run(prompt: string, correction: string): Promise<{ result: WorkerResult; artifacts: RawArtifactRef[]; repaired: boolean }> {
    await this.session.prompt(prompt);
    let result = parseTerminalEnvelope(this.lastAssistantText());
    let repaired = false;
    if (!result) {
      repaired = true;
      await this.session.prompt(correction, { streamingBehavior: 'followUp' });
      result = parseTerminalEnvelope(this.lastAssistantText());
    }
    if (!result) throw new Error('Pi session did not produce a valid terminal WorkerResult after bounded correction');
    const observedChangedFiles = await this.input.workspaceManager.changedFiles(this.input.workspace);
    if (JSON.stringify([...result.changed_files].sort()) !== JSON.stringify(observedChangedFiles)) {
      throw new Error('WorkerResult changed_files claim does not match post-attempt Git diff');
    }
    await this.waitForEvents();
    // Retain the exact terminal assistant text; parsing a claim must never replace
    // the worker's raw bytes in the evidence journal.
    const envelope = await this.input.journal.append({ source: 'pi.envelope', sourceIdentity: `pi-envelope:${this.input.attemptId}`, mediaType: 'text/plain; charset=utf-8', bytes: Buffer.from(this.lastAssistantText()) });
    const stats = this.session.getSessionStats();
    const usage = await this.input.journal.append({ source: 'pi.usage', sourceIdentity: `pi-usage:${this.input.attemptId}`, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ commandId: this.input.commandId, attemptId: this.input.attemptId, sessionId: this.sessionId, observedTokens: stats.tokens, contextOccupancy: { state: 'unknown', reason: 'Pi SDK does not provide an authoritative context window or compaction count in this slice' }, cost: { state: 'unknown', reason: 'local faux provider has no billable cost' } })) });
    return { result, artifacts: [...this.artifacts, envelope, usage], repaired };
  }

  async cancel(): Promise<void> {
    await this.input.authority.requestCancellation(this.input.commandId);
    this.session.abort();
    const settled = await Promise.race([
      new Promise<void>((resolve) => { const unsubscribe = this.session.subscribe((event: { type: string }) => { if (event.type === 'agent_settled') { unsubscribe(); resolve(); } }); }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ]);
    await this.input.authority.reportWorkerStop(this.input.commandId, settled === 'timeout' ? 'unknown' : 'stopped');
  }

  async reopen(): Promise<PiNativeWorker> {
    const stats = this.session.getSessionStats();
    if (!stats.sessionFile) throw new Error('Pi has not persisted this session yet');
    this.unsubscribe(); this.session.dispose();
    const [{ createAgentSession, SessionManager, createExtensionRuntime }, { Type }] = await Promise.all([import('@earendil-works/pi-coding-agent'), import('typebox')]);
    this.input.workspaceManager.assertOwner(this.input.workspace, this.input.owner);
    const writeTool: any = {
      name: 'helm_write', label: 'Helm write', description: 'Write a UTF-8 file inside the assigned worktree.',
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), contents: Type.String() }), executionMode: 'sequential',
      execute: async (toolCallId: string, params: { path: string; contents: string }) => {
        try { await this.input.authority.perform({ effectId: `tool:${toolCallId}`, kind: 'workspace.write', commandId: this.input.commandId }, async () => this.input.workspaceManager.write(this.input.workspace, this.input.owner, params.path, params.contents)); return toolResult(`wrote ${params.path}`); }
        catch (error) { return toolResult(`refused: ${(error as Error).message}`, true); }
      },
    };
    const reopened = await createAgentSession({ cwd: this.input.workspace.root, modelRuntime: await guardedModelRuntime(this.input), model: this.input.model as any,
      sessionManager: SessionManager.open(stats.sessionFile, join(this.input.stateRoot, 'sessions'), this.input.workspace.root), noTools: 'builtin', tools: ['helm_write'], customTools: [writeTool], resourceLoader: noResources(createExtensionRuntime()) as any });
    const id = reopened.session.getSessionStats().sessionId;
    if (id !== this.sessionId) throw new Error('reopened Pi session identity changed');
    return new PiNativeWorker(this.input, reopened.session, id, () => undefined, this.artifacts, async () => undefined);
  }

  dispose(): void { this.unsubscribe(); this.session.dispose(); }

  private lastAssistantText(): string {
    const messages = this.session.messages;
    const last = [...messages].reverse().find((message) => message.role === 'assistant');
    return last && 'content' in last ? last.content.filter((entry: any): entry is { type: 'text'; text: string } => entry.type === 'text').map((entry: { type: 'text'; text: string }) => entry.text).join('') : '';
  }
}
