import { createHash, randomUUID } from 'node:crypto';
import type { Attempt, Command, Event, Observation, Precondition } from '../contracts/index.js';
import type { KernelEffect, TrustedExecutor } from '../core/index.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import type { PiNativeWorker, PiPersistedSession } from '../runtime/pi/index.js';
import type { WorktreeOwner, WorktreeReservation, WorkspaceManager } from '../workspace/index.js';
import type { HostControlPlane } from './index.js';

export type WorkerSpawnInput = Readonly<{ objectiveRef: string; acceptanceRef: string; contextRefs: readonly string[]; modelId: string; role: string; label?: string }>;
/** A bounded, orchestrator-selected follow-up; all paths and authority remain host configured. */
export type WorkerSteerInput = Readonly<{ workerId: string; objectiveRef: string; evidenceRefs: readonly string[]; /** When gate output is used, this immutable command identity binds its raw refs to the predecessor and exact head. */ gateCommandId?: string; expectedSessionId: string; expectedHead: string }>;
export type WorkerInspect = Readonly<{
  workerId: string; attemptId: string; spawnCommandId: string; sessionId: string; workspace: string;
  state: 'ready' | 'running' | 'terminal' | 'unknown'; live: 'known' | 'unknown';
  activeRequests?: number; contextOccupancy?: unknown; eventCursor?: string;
  evidenceRefs: readonly string[]; cancellationRequested: boolean;
}>;
type SpawnProvenance = Readonly<{ modelId: string; modelProvider: string; modelApi: string; inputDigest: string; baseSha: string; modelFactVersion: number; dataPolicy: string }>;
/** v1 launch/terminal records predate continuation provenance. They remain readable, but cannot be steered. */
type StoredWorker = Readonly<{ schemaVersion: 1; workerId: string; attemptId: string; spawnCommandId: string; sessionId: string; workspace: string; owner?: WorktreeOwner; modelId?: string; modelProvider?: string; modelApi?: string; modelFactVersion?: number; dataPolicy?: string; state: WorkerInspect['state']; inputDigest: string; evidenceRefs: readonly string[]; cancellationRequested: boolean; persistedSession?: PiPersistedSession }>;
type ContinuationWorker = StoredWorker & Readonly<{ owner: WorktreeOwner; modelId: string; modelProvider: string; modelApi: string; modelFactVersion: number; dataPolicy: string; persistedSession: PiPersistedSession }>;
type LiveWorker = Readonly<{ worker: PiNativeWorker; record: StoredWorker; context: HelmToolExecutionContext; command: Command }>;
export class WorkerSteerUnknownError extends Error {
  constructor(readonly commandId: string) { super(`worker steer outcome is unknown; reconcile command ${commandId}`); }
}

function digest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function storedWorker(value: unknown): StoredWorker | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Partial<StoredWorker>;
  if (item.schemaVersion !== 1 || typeof item.workerId !== 'string' || typeof item.attemptId !== 'string' || typeof item.spawnCommandId !== 'string'
    || typeof item.sessionId !== 'string' || typeof item.workspace !== 'string' || typeof item.inputDigest !== 'string'
    || (item.modelId !== undefined && typeof item.modelId !== 'string') || (item.modelProvider !== undefined && typeof item.modelProvider !== 'string') || (item.modelApi !== undefined && typeof item.modelApi !== 'string') || (item.modelFactVersion !== undefined && (!Number.isInteger(item.modelFactVersion) || item.modelFactVersion < 1)) || (item.dataPolicy !== undefined && typeof item.dataPolicy !== 'string')
    || (item.owner !== undefined && (typeof item.owner.attemptId !== 'string' || !Number.isInteger(item.owner.generation) || typeof item.owner.expiresAt !== 'string'))
    || (item.state !== 'ready' && item.state !== 'running' && item.state !== 'terminal' && item.state !== 'unknown')
    || !Array.isArray(item.evidenceRefs) || !item.evidenceRefs.every((ref) => typeof ref === 'string') || typeof item.cancellationRequested !== 'boolean') return undefined;
  if (item.persistedSession && (typeof item.persistedSession.sessionId !== 'string' || typeof item.persistedSession.sessionFile !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(item.persistedSession.historyHash) || !/^sha256:[0-9a-f]{64}$/.test(item.persistedSession.branchDigest))) return undefined;
  return Object.freeze({ ...item, ...(item.owner ? { owner: Object.freeze({ ...item.owner }) } : {}), evidenceRefs: Object.freeze([...item.evidenceRefs]), ...(item.persistedSession ? { persistedSession: Object.freeze({ ...item.persistedSession }) } : {}) }) as StoredWorker;
}
function continuationWorker(record: StoredWorker | undefined): record is ContinuationWorker {
  return Boolean(record && record.state === 'terminal' && !record.cancellationRequested && record.persistedSession
    && record.owner && record.modelId && record.modelProvider && record.modelApi && Number.isInteger(record.modelFactVersion) && (record.modelFactVersion ?? 0) > 0 && record.dataPolicy);
}
function spawnProvenance(command: Command): SpawnProvenance {
  const value = command.payload as Partial<SpawnProvenance>;
  if (typeof value.modelId !== 'string' || typeof value.modelProvider !== 'string' || typeof value.modelApi !== 'string' || typeof value.inputDigest !== 'string' || typeof value.baseSha !== 'string'
    || !Number.isInteger(value.modelFactVersion) || (value.modelFactVersion ?? 0) < 1 || typeof value.dataPolicy !== 'string') {
    throw new Error('worker spawn command omits immutable launch provenance');
  }
  return value as SpawnProvenance;
}
function now(): string { return new Date().toISOString(); }
function event(kind: string, record: StoredWorker, runId: string, payload: unknown): Event {
  return { schemaVersion: 1, eventId: randomUUID(), kind, source: 'host.worker_fleet', sourceEventId: `${record.workerId}:${kind}:${randomUUID()}`,
    occurredAt: now(), recordedAt: now(), commandId: record.spawnCommandId, attemptId: record.attemptId, sessionId: record.sessionId,
    correlationId: runId, payload };
}

/** Host configuration, never model-facing JSON, resolves all effectful facts. */
export type WorkerFleetBinding = Readonly<{
  host: HostControlPlane;
  workspaceManager: WorkspaceManager;
  executor: TrustedExecutor;
  claimExpiresAt(): string;
  /** Trusted host fact reader. It must return an observation, never a model claim. */
  readFact(precondition: Precondition): Promise<Observation<boolean>>;
  spawnCommand(input: WorkerSpawnInput, workerId: string, attemptId: string, context: HelmToolExecutionContext): Command;
  /** The generated successor identity is host-owned and must be bound by the immutable command payload. */
  steerCommand?(input: WorkerSteerInput, workerId: string, record: StoredWorker, attemptId: string, context: HelmToolExecutionContext): Command;
  /** Extract the host-configured immutable input digest from the command payload. */
  inputDigest(command: Command): string;
  stopCommand(record: StoredWorker, context: HelmToolExecutionContext): Command;
  attempt(command: Command, workerId: string): Attempt;
  workspace(command: Command, workerId: string, attempt: Attempt): Readonly<{ repository: string; destination: string; branch: string; baseSha: string; owner: WorktreeOwner; policy: { writableRoots: readonly string[]; readableRoots?: readonly string[]; protectedRoots?: readonly string[] } }>;
  start(command: Command, workspace: WorktreeReservation): Promise<PiNativeWorker>;
  rehydrate?(command: Command, workspace: WorktreeReservation, persisted: PiPersistedSession): Promise<PiNativeWorker>;
  prompt(command: Command): string;
  correction(command: Command): string;
}>;

/**
 * The only owner of live Pi workers.  Durable launch/terminal records are
 * effect artifacts; the in-memory map is deliberately disposable.
 */
export class PiWorkerFleet {
  readonly #live = new Map<string, LiveWorker>();
  readonly #records = new Map<string, StoredWorker>();
  readonly #runs = new Map<string, Promise<void>>();
  readonly #stopping = new Map<string, Promise<'stopped' | 'unknown'>>();
  constructor(private readonly binding: WorkerFleetBinding) {}

  async spawn(context: HelmToolExecutionContext, input: WorkerSpawnInput): Promise<{ workerId: string; attemptId: string; sessionId: string; state: 'ready' }> {
    const validated = Object.freeze({ ...input, contextRefs: Object.freeze([...input.contextRefs]) });
    const artifacts = this.binding.host.artifactsFor(context);
    await Promise.all([artifacts.readText(validated.objectiveRef), artifacts.readText(validated.acceptanceRef), ...validated.contextRefs.map((ref) => artifacts.readText(ref))]);
    const workerId = `worker-${randomUUID()}`;
    const attemptId = `attempt-${workerId}`;
    const command = this.binding.spawnCommand(validated, workerId, attemptId, context);
    const provenance = spawnProvenance(command);
    if (provenance.modelId !== validated.modelId || this.binding.inputDigest(command) !== digest(validated)) throw new Error('worker spawn command does not bind the validated input references');
    this.binding.host.assertModelProvenance(provenance.modelId, provenance.modelProvider, provenance.modelFactVersion);
    const admitted = this.binding.host.admitOrchestrator(command, context, command.actorId, attemptId);
    const attempt = this.binding.attempt(admitted.command, workerId);
    let record: StoredWorker | undefined;
    const effect: KernelEffect = {
      effectId: `host:worker-spawn:${workerId}`,
      execute: async () => {
        // Immutable attempt provenance precedes workspace/session creation.
        this.binding.host.recordAttempt(attempt);
        const config = this.binding.workspace(admitted.command, workerId, attempt);
        if (config.baseSha !== provenance.baseSha || attempt.baseSha !== provenance.baseSha || attempt.model !== provenance.modelId) {
          throw new Error('worker spawn provenance does not match its worktree or attempt');
        }
        const workspace = await this.binding.workspaceManager.create(config.repository, config.destination, config.branch, config.baseSha, config.owner, config.policy);
        this.binding.host.assertModelProvenance(provenance.modelId, provenance.modelProvider, provenance.modelFactVersion);
        const worker = await this.binding.start(admitted.command, workspace);
        if (worker.modelIdentity.modelId !== provenance.modelId || worker.modelIdentity.provider !== provenance.modelProvider || worker.modelIdentity.api !== provenance.modelApi) {
          worker.dispose();
          throw new Error('Pi runtime model does not match the admitted worker model');
        }
        record = Object.freeze({ schemaVersion: 1, workerId, attemptId: attempt.attemptId, spawnCommandId: admitted.command.commandId, sessionId: worker.sessionId,
          workspace: workspace.root, owner: workspace.owner, modelId: provenance.modelId, modelProvider: provenance.modelProvider, modelApi: provenance.modelApi, modelFactVersion: provenance.modelFactVersion, dataPolicy: provenance.dataPolicy, state: 'ready', inputDigest: digest(validated), evidenceRefs: Object.freeze([]), cancellationRequested: false });
        this.#records.set(workerId, record);
        this.#live.set(workerId, Object.freeze({ worker, record, context: Object.freeze({ ...context }), command: admitted.command }));
      },
      observe: async () => {
        if (!record) return { commandId: admitted.command.commandId, effectId: `host:worker-spawn:${workerId}`, state: 'unknown', source: 'host.worker_fleet', observedAt: now(), evidenceRefs: [`worker:${workerId}:launch-missing`] };
        const ref = await this.binding.host.artifactsFor(context).writeEffect('host.worker_fleet.launch', JSON.stringify(record));
        const persisted = Object.freeze({ ...record, evidenceRefs: Object.freeze([ref]) });
        this.#records.set(workerId, persisted);
        const live = this.#live.get(workerId); if (live) this.#live.set(workerId, Object.freeze({ ...live, record: persisted }));
        this.binding.host.appendFleetEvent(event('worker.started', persisted, context.runId, { state: 'ready', launchRef: ref }));
        return { commandId: admitted.command.commandId, effectId: `host:worker-spawn:${workerId}`, state: 'succeeded', source: 'host.worker_fleet', observedAt: now(), evidenceRefs: [ref] };
      },
    };
    const observed = await this.binding.host.performAdmitted(admitted.command.commandId, this.binding.executor, this.binding.claimExpiresAt(), this.binding.readFact, effect);
    if (observed.state !== 'succeeded' || !record) throw new Error('worker setup was not durably observed');
    const live = this.#live.get(workerId)!;
    // A background runner is never awaited by spawn and always records a stable
    // disposition, preventing an unhandled rejection from becoming authority.
    const run = this.run(workerId, live).catch(async () => { await this.persistUnknown(workerId, live); });
    this.#runs.set(workerId, run);
    return { workerId, attemptId: record.attemptId, sessionId: record.sessionId, state: 'ready' };
  }

  /**
   * A continuation is deliberately a new command and attempt.  It may use a
   * persisted transcript only after the old invocation is durably terminal,
   * the exact clean head is re-observed, and ownership is transferred to a
   * fresh generation.  The old record is never reopened or rewritten.
   */
  async steer(context: HelmToolExecutionContext, input: WorkerSteerInput): Promise<{ workerId: string; attemptId: string; sessionId: string; state: 'ready'; predecessorWorkerId: string }> {
    if (!this.binding.steerCommand || !this.binding.rehydrate) throw new Error('same-session continuation is not configured by this host');
    // The caller's tool JSON must never retain mutable authority over an
    // admitted continuation while the host awaits artifact/Git observations.
    const validated = Object.freeze({ ...input, evidenceRefs: Object.freeze([...input.evidenceRefs]) });
    const predecessor = await this.durableRecord(context.runId, validated.workerId) ?? this.#records.get(validated.workerId);
    if (!continuationWorker(predecessor)) throw new Error('worker is not a recoverable idle same-session continuation');
    if (this.#live.has(validated.workerId) || predecessor.sessionId !== validated.expectedSessionId || predecessor.persistedSession.sessionId !== validated.expectedSessionId) throw new Error('worker is active or session identity changed');
    if (validated.gateCommandId) await this.binding.host.assertGateEvidence(context.runId, validated.gateCommandId, predecessor.spawnCommandId, predecessor.workerId, predecessor.workspace, validated.expectedHead, validated.evidenceRefs);
    const artifacts = this.binding.host.artifactsFor(context);
    await Promise.all([artifacts.readText(validated.objectiveRef), ...(validated.gateCommandId ? [] : validated.evidenceRefs.map((ref) => artifacts.readText(ref)))]);
    const oldWorkspace = this.binding.workspaceManager.reservation(predecessor.workspace);
    if (oldWorkspace.owner.attemptId !== predecessor.owner.attemptId || oldWorkspace.owner.generation !== predecessor.owner.generation || oldWorkspace.owner.expiresAt !== predecessor.owner.expiresAt) throw new Error('predecessor worktree generation is no longer current');
    await this.binding.workspaceManager.assertExactHead(oldWorkspace, validated.expectedHead);
    const workerId = `worker-${randomUUID()}`;
    const attemptId = `attempt-${workerId}`;
    const command = this.binding.steerCommand(validated, workerId, predecessor, attemptId, context);
    const payload = command.payload as { workerId?: unknown; attemptId?: unknown; predecessorWorkerId?: unknown; inputDigest?: unknown; modelId?: unknown; modelProvider?: unknown; modelApi?: unknown; modelFactVersion?: unknown; dataPolicy?: unknown };
    if (payload.workerId !== workerId || payload.attemptId !== attemptId || payload.predecessorWorkerId !== predecessor.workerId || payload.inputDigest !== digest(validated)
      || payload.modelId !== predecessor.modelId || payload.modelProvider !== predecessor.modelProvider || payload.modelApi !== predecessor.modelApi || payload.modelFactVersion !== predecessor.modelFactVersion || payload.dataPolicy !== predecessor.dataPolicy) {
      throw new Error('worker steer command does not bind successor, predecessor, and immutable validated inputs');
    }
    const admitted = this.binding.host.admitOrchestrator(command, context, command.actorId, attemptId);
    const attempt = this.binding.attempt(admitted.command, workerId);
    let record: StoredWorker | undefined;
    const effect: KernelEffect = {
      effectId: `host:worker-steer:${workerId}`,
      execute: async () => {
        await this.binding.workspaceManager.assertExactHead(oldWorkspace, validated.expectedHead);
        this.binding.host.assertEffectAuthority(admitted.command.commandId, context);
        this.binding.host.assertModelProvenance(predecessor.modelId, predecessor.modelProvider, predecessor.modelFactVersion);
        this.binding.host.recordAttempt(attempt);
        const config = this.binding.workspace(admitted.command, workerId, attempt);
        if (config.destination !== predecessor.workspace || config.baseSha !== validated.expectedHead || attempt.baseSha !== validated.expectedHead) throw new Error('continuation does not preserve the verified workspace head');
        const workspace = this.binding.workspaceManager.transfer(oldWorkspace, oldWorkspace.owner.generation, config.owner);
        const worker = await this.binding.rehydrate!(admitted.command, workspace, predecessor.persistedSession!);
        if (worker.sessionId !== predecessor.sessionId || worker.modelIdentity.modelId !== predecessor.modelId || worker.modelIdentity.provider !== predecessor.modelProvider || worker.modelIdentity.api !== predecessor.modelApi) { worker.dispose(); throw new Error('continuation native identity changed'); }
        record = Object.freeze({ schemaVersion: 1, workerId, attemptId: attempt.attemptId, spawnCommandId: admitted.command.commandId, sessionId: worker.sessionId,
          workspace: workspace.root, owner: workspace.owner, modelId: predecessor.modelId, modelProvider: predecessor.modelProvider, modelApi: predecessor.modelApi, modelFactVersion: predecessor.modelFactVersion, dataPolicy: predecessor.dataPolicy, state: 'ready', inputDigest: digest(validated), evidenceRefs: Object.freeze([]), cancellationRequested: false });
        this.#records.set(workerId, record);
        this.#live.set(workerId, Object.freeze({ worker, record, context: Object.freeze({ ...context }), command: admitted.command }));
      },
      observe: async () => {
        if (!record) return { commandId: admitted.command.commandId, effectId: `host:worker-steer:${workerId}`, state: 'unknown', source: 'host.worker_fleet', observedAt: now(), evidenceRefs: [`worker:${workerId}:steer-missing`] };
        const ref = await artifacts.writeEffect('host.worker_fleet.steer', JSON.stringify({ ...record, predecessorWorkerId: predecessor.workerId, predecessorAttemptId: predecessor.attemptId, expectedHead: validated.expectedHead }));
        const persisted = Object.freeze({ ...record, evidenceRefs: Object.freeze([ref]) }); this.#records.set(workerId, persisted);
        const live = this.#live.get(workerId); if (live) this.#live.set(workerId, Object.freeze({ ...live, record: persisted }));
        this.binding.host.appendFleetEvent(event('worker.steered', persisted, context.runId, { predecessorWorkerId: predecessor.workerId, predecessorAttemptId: predecessor.attemptId, expectedHead: validated.expectedHead, evidenceRefs: validated.evidenceRefs }));
        return { commandId: admitted.command.commandId, effectId: `host:worker-steer:${workerId}`, state: 'succeeded', source: 'host.worker_fleet', observedAt: now(), evidenceRefs: [ref] };
      },
    };
    const observed = await this.binding.host.performAdmitted(admitted.command.commandId, this.binding.executor, this.binding.claimExpiresAt(), this.binding.readFact, effect);
    if (observed.state === 'unknown') throw new WorkerSteerUnknownError(admitted.command.commandId);
    if (observed.state !== 'succeeded' || !record) throw new Error('worker continuation was not durably observed');
    const live = this.#live.get(workerId)!; const run = this.run(workerId, live).catch(async () => { await this.persistUnknown(workerId, live); }); this.#runs.set(workerId, run);
    return { workerId, attemptId: record.attemptId, sessionId: record.sessionId, state: 'ready', predecessorWorkerId: predecessor.workerId };
  }

  /** Test/controlled-host hook; normal orchestration must use inspect/events. */
  async waitForTerminal(workerId: string): Promise<void> { await this.#runs.get(workerId); }

  private async run(workerId: string, live: LiveWorker): Promise<void> {
    let terminal: StoredWorker | undefined;
    try {
      const outcome = await live.worker.run(this.binding.prompt(live.command), this.binding.correction(live.command));
      const completed = Object.freeze({ ...live.record, state: 'terminal' as const, persistedSession: await live.worker.persistedSession(), evidenceRefs: Object.freeze([...live.record.evidenceRefs, ...outcome.artifacts.map((item) => item.ref)]) });
      // Write a disposition before updating the query projection. A completed
      // agent may disappear between these operations; its evidence must not.
      terminal = await this.persistRecord(live.context, completed, 'terminal');
      this.#records.set(workerId, terminal);
      this.binding.host.reportAttemptStop(live.record.attemptId, 'stopped');
      this.binding.host.appendFleetEvent(event('worker.completed', terminal, live.context.runId, { result: outcome.result.status, evidenceRefs: terminal.evidenceRefs }));
    } catch {
      const stop = this.#stopping.get(workerId);
      // A confirmed local stop has one authoritative disposition, recorded by
      // worker.stop.  If cancellation was not confirmed, this runner still
      // owns reconciliation: an ignored abort can later complete or fail.
      if (stop && await stop === 'stopped') return;
      // Once completion is durably recorded it wins over a later projection or
      // event failure. Never rewrite that stable terminal disposition as an
      // unknown worker merely because a subsequent bookkeeping call failed.
      if (terminal?.state === 'terminal') return;
      const unknown = Object.freeze({ ...live.record, state: 'unknown' as const });
      terminal = await this.persistRecord(live.context, unknown, 'terminal');
      this.#records.set(workerId, terminal);
      this.binding.host.reportAttemptStop(live.record.attemptId, 'unknown');
      this.binding.host.appendFleetEvent(event('worker.failed', terminal, live.context.runId, { disposition: 'unknown' }));
    } finally {
      if (!this.#stopping.has(workerId)) {
        if (terminal) this.#records.set(workerId, terminal);
        this.#live.delete(workerId);
        this.#runs.delete(workerId);
        if (!live.worker.isActive) live.worker.dispose();
        else this.#live.set(workerId, live);
      }
    }
  }

  private async persistUnknown(workerId: string, live: LiveWorker): Promise<void> {
    const unknown = Object.freeze({ ...live.record, state: 'unknown' as const });
    try {
      const persisted = await this.persistRecord(live.context, unknown, 'terminal');
      this.#records.set(workerId, persisted);
      this.binding.host.reportAttemptStop(live.record.attemptId, 'unknown');
      this.binding.host.appendFleetEvent(event('worker.failed', persisted, live.context.runId, { disposition: 'unknown', persistence: 'recovered' }));
    } catch {
      // Keep an active worker inspectable when even the unknown disposition
      // cannot be durably written; no success/terminal claim is manufactured.
      this.#records.set(workerId, unknown); this.#live.set(workerId, live);
    }
  }

  private async persistRecord(context: HelmToolExecutionContext, record: StoredWorker, phase: 'terminal' | 'stop'): Promise<StoredWorker> {
    const evidencePhase = phase === 'terminal'
      ? record.state === 'terminal' ? 'terminal-known' as const : 'terminal-unknown' as const
      : record.state === 'terminal' ? 'stop-confirmed' as const : 'stop-unknown' as const;
    const ref = await this.binding.host.writeFleetEffect({ runId: context.runId, attemptId: record.attemptId, spawnCommandId: record.spawnCommandId, phase: evidencePhase, text: JSON.stringify(record) });
    return Object.freeze({ ...record, evidenceRefs: Object.freeze([...record.evidenceRefs, ref]) });
  }

  private async durableRecord(runId: string, workerId: string): Promise<StoredWorker | undefined> {
    const snapshot = await this.binding.host.snapshot(runId);
    const command = snapshot.commands.find((entry) => (entry.command.payload as { workerId?: unknown }).workerId === workerId);
    const attemptId = (command?.command.payload as { attemptId?: unknown } | undefined)?.attemptId;
    if (typeof attemptId === 'string') {
      const [terminalKnownText, terminalUnknownText, stopConfirmedText, stopUnknownText] = await Promise.all([
        this.binding.host.readFleetEffectByIdentity(runId, `host-worker-terminal-known:${runId}:${attemptId}`),
        this.binding.host.readFleetEffectByIdentity(runId, `host-worker-terminal-unknown:${runId}:${attemptId}`),
        this.binding.host.readFleetEffectByIdentity(runId, `host-worker-stop-confirmed:${runId}:${attemptId}`),
        this.binding.host.readFleetEffectByIdentity(runId, `host-worker-stop-unknown:${runId}:${attemptId}`),
      ]);
      try {
        const terminalKnown = terminalKnownText ? storedWorker(JSON.parse(terminalKnownText)) : undefined;
        const terminalUnknown = terminalUnknownText ? storedWorker(JSON.parse(terminalUnknownText)) : undefined;
        const stopConfirmed = stopConfirmedText ? storedWorker(JSON.parse(stopConfirmedText)) : undefined;
        const stopUnknown = stopUnknownText ? storedWorker(JSON.parse(stopUnknownText)) : undefined;
        // A confirmed stop or completed run is a stronger durable observation
        // than an earlier runner-failure unknown.  Keep both evidence chains
        // and cancellation intent; neither record is overwritten.
        const winner = terminalKnown ?? stopConfirmed ?? terminalUnknown ?? stopUnknown;
        if (winner) return Object.freeze({ ...winner,
          evidenceRefs: Object.freeze([...new Set([...(terminalKnown?.evidenceRefs ?? []), ...(terminalUnknown?.evidenceRefs ?? []), ...(stopConfirmed?.evidenceRefs ?? []), ...(stopUnknown?.evidenceRefs ?? [])])]),
          cancellationRequested: Boolean(terminalKnown?.cancellationRequested || terminalUnknown?.cancellationRequested || stopConfirmed?.cancellationRequested || stopUnknown?.cancellationRequested),
        });
      } catch { return undefined; }
    }
    const ref = command?.observations.flatMap((entry) => entry.evidenceRefs).find((entry) => entry.includes('"kind":"effect"'));
    if (!ref) return undefined;
    try { return storedWorker(JSON.parse(await this.binding.host.readFleetEffect(runId, ref))); } catch { return undefined; }
  }

  async inspect(context: HelmToolExecutionContext, workerId: string): Promise<WorkerInspect> {
    // Durable terminal/stop evidence wins over a stale in-memory projection.
    let record = await this.durableRecord(context.runId, workerId) ?? this.#records.get(workerId);
    const live = this.#live.get(workerId);
    if (!record) throw new Error('unknown worker');
    this.#records.set(workerId, record);
    const { persistedSession: _privateSession, owner: _privateOwner, modelId: _privateModelId, modelProvider: _privateModelProvider, modelApi: _privateModelApi, modelFactVersion: _privateModelFactVersion, dataPolicy: _privateDataPolicy, ...publicRecord } = record;
    if (!live) return { ...publicRecord, live: 'unknown', state: record.state === 'terminal' ? 'terminal' : 'unknown', evidenceRefs: record.evidenceRefs };
    // Liveness is an observation of the local process only; durable outcome,
    // cancellation intent and evidence remain authoritative for the worker.
    return { ...publicRecord, state: record.state === 'ready' && live.worker.isActive ? 'running' : record.state, live: 'known', contextOccupancy: live.worker.contextOccupancy, evidenceRefs: record.evidenceRefs };
  }

  async stop(context: HelmToolExecutionContext, workerId: string): Promise<{ state: 'stopped' | 'pending' | 'unknown'; evidenceRefs: readonly string[] }> {
    const live = this.#live.get(workerId); const record = await this.durableRecord(context.runId, workerId) ?? this.#records.get(workerId);
    if (!record) throw new Error('unknown worker');
    if (!live && record.state === 'terminal') return { state: 'stopped', evidenceRefs: record.evidenceRefs };
    if (!live && record.cancellationRequested) return { state: 'unknown', evidenceRefs: record.evidenceRefs };
    const command = this.binding.stopCommand(record, context);
    const admitted = this.binding.host.admitOrchestrator(command, context, command.actorId);
    let disposition: 'stopped' | 'unknown' = 'unknown'; let ref: string | undefined;
    let resolveStop: (value: 'stopped' | 'unknown') => void = () => undefined;
    const stopObserved = new Promise<'stopped' | 'unknown'>((resolve) => { resolveStop = resolve; });
    const effect: KernelEffect = {
      effectId: `host:worker-stop:${workerId}`,
      execute: async () => {
        if (!live) { resolveStop('unknown'); return; }
        this.#stopping.set(workerId, stopObserved);
        try { disposition = await live.worker.stopLocal(); }
        catch { disposition = 'unknown'; }
        finally { resolveStop(disposition); }
      },
      observe: async () => {
        const updated = await this.persistRecord(context, Object.freeze({ ...record, state: disposition === 'stopped' ? 'terminal' : 'unknown', cancellationRequested: true }), 'stop');
        this.#records.set(workerId, updated); ref = updated.evidenceRefs.at(-1)!;
        if (disposition !== 'stopped') this.binding.host.reportAttemptStop(record.attemptId, 'unknown');
        return { commandId: admitted.command.commandId, effectId: `host:worker-stop:${workerId}`, state: disposition === 'stopped' ? 'succeeded' : 'unknown', source: 'host.worker_fleet', observedAt: now(), evidenceRefs: [ref] };
      },
    };
    const observed = await this.binding.host.performAdmitted(admitted.command.commandId, this.binding.executor, this.binding.claimExpiresAt(), this.binding.readFact, effect);
    if (observed.state === 'succeeded') {
      // Only after worker.stop itself is observed are all attempt commands
      // terminal, so this is the point at which capacity can be released.
      this.binding.host.reportAttemptStop(record.attemptId, 'stopped');
      this.#live.delete(workerId); this.#runs.delete(workerId); this.#stopping.delete(workerId);
      if (live && !live.worker.isActive) live.worker.dispose();
    } else this.#stopping.delete(workerId);
    return { state: observed.state === 'succeeded' ? 'stopped' : 'unknown', evidenceRefs: ref ? [ref] : [] };
  }
}
