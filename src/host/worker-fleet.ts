import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { type Attempt, type Command, type Event, type Observation, type Precondition, utcTimestampSchema } from '../contracts/index.js';
import type { KernelEffect, TrustedExecutor } from '../core/index.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import { validProcessIdentity, type ProcessIdentity, type ProcessObservation, type ProcessProbe } from './process-liveness.js';
import type { PiForkSourceSnapshot, PiNativeWorker, PiPersistedSession } from '../runtime/pi/index.js';
import type { WorktreeOwner, WorktreeReservation, WorkspaceManager } from '../workspace/index.js';
import type { HostControlPlane } from './index.js';

/** Private host constraint used only by independent review; it is never a public tool field. */
export type ReviewSpawnConstraint = Readonly<{ repository: string; expectedHead: string; mode: 'review-readonly' }>;
export type WorkerSpawnInput = Readonly<{ objectiveRef: string; acceptanceRef: string; contextRefs: readonly string[]; modelId: string; role: string; label?: string; reviewConstraint?: ReviewSpawnConstraint }>;
/** A bounded, orchestrator-selected follow-up; all paths and authority remain host configured. */
export type WorkerSteerInput = Readonly<{ workerId: string; objectiveRef: string; evidenceRefs: readonly string[]; /** When gate output is used, this immutable command identity binds its raw refs to the predecessor and exact head. */ gateCommandId?: string; expectedSessionId: string; expectedHead: string }>;
/** Clone an idle terminal Pi branch; the resulting child is `fork_ready`, not completed. */
export type WorkerForkInput = Readonly<{ workerId: string; expectedSessionId: string; expectedHead: string }>;
export type WorkerInspect = Readonly<{
  workerId: string; attemptId: string; spawnCommandId: string; sessionId: string; workspace: string;
  state: 'ready' | 'running' | 'fork_ready' | 'terminal' | 'unknown'; live: 'known' | 'unknown'; ownerProcessObservation?: ProcessObservation;
  activeRequests?: number; contextOccupancy?: unknown; eventCursor?: string;
  evidenceRefs: readonly string[]; cancellationRequested: boolean;
}>;
/** Read-only terminal provenance for a native worker. It is deliberately not a model tool surface. */
export type WorkerTerminalJournal = Readonly<{
  workerId: string; attemptId: string; sessionId: string; spawnCommandId: string; workspace: string;
  owner: WorktreeOwner; modelId: string; modelProvider: string; modelApi: string;
  evidenceRefs: readonly string[]; reviewBeforeRef: string;
}>;
type SpawnProvenance = Readonly<{ modelId: string; modelProvider: string; modelApi: string; inputDigest: string; baseSha: string; modelFactVersion: number; dataPolicy: string }>;
/** v1 launch/terminal records predate continuation provenance. They remain readable, but cannot be steered. */
type StoredWorker = Readonly<{ schemaVersion: 1; workerId: string; attemptId: string; spawnCommandId: string; sessionId: string; workspace: string; owner?: WorktreeOwner; ownerProcess?: ProcessIdentity; modelId?: string; modelProvider?: string; modelApi?: string; modelFactVersion?: number; dataPolicy?: string; reviewBeforeRef?: string; forkLeafId?: string; state: WorkerInspect['state']; inputDigest: string; evidenceRefs: readonly string[]; cancellationRequested: boolean; persistedSession?: PiPersistedSession }>;
type ContinuationWorker = StoredWorker & Readonly<{ owner: WorktreeOwner; modelId: string; modelProvider: string; modelApi: string; modelFactVersion: number; dataPolicy: string; persistedSession: PiPersistedSession }>;
type LiveWorker = Readonly<{ worker: PiNativeWorker; record: StoredWorker; context: HelmToolExecutionContext; command: Command }>;
export class WorkerSteerUnknownError extends Error {
  constructor(readonly commandId: string) { super(`worker steer outcome is unknown; reconcile command ${commandId}`); }
}

function digest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
const OBSERVATION_MAX_AGE_MS = 30_000;
/** Bounded, generic reason. Never carries arbitrary probe/thrown text into a durable field. */
function unknownObservation(reason: string): ProcessObservation {
  return Object.freeze({ state: 'unknown', observedAt: utcTimestampSchema.parse(new Date().toISOString()), reason });
}
/** Shared capture: the single trusted host probe of "who owns me right now". */
async function captureOwnerProcess(probe: ProcessProbe | undefined): Promise<ProcessIdentity | undefined> {
  if (!probe) return undefined;
  try {
    const captured = await probe.capture();
    return validProcessIdentity(captured) ? Object.freeze({ ...captured }) : undefined;
  } catch { return undefined; }
}
function storedWorker(value: unknown): StoredWorker | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Partial<StoredWorker>;
  if (item.schemaVersion !== 1 || typeof item.workerId !== 'string' || typeof item.attemptId !== 'string' || typeof item.spawnCommandId !== 'string'
    || typeof item.sessionId !== 'string' || typeof item.workspace !== 'string' || typeof item.inputDigest !== 'string'
    || (item.modelId !== undefined && typeof item.modelId !== 'string') || (item.modelProvider !== undefined && typeof item.modelProvider !== 'string') || (item.modelApi !== undefined && typeof item.modelApi !== 'string') || (item.modelFactVersion !== undefined && (!Number.isInteger(item.modelFactVersion) || item.modelFactVersion < 1)) || (item.dataPolicy !== undefined && typeof item.dataPolicy !== 'string') || (item.reviewBeforeRef !== undefined && typeof item.reviewBeforeRef !== 'string') || (item.forkLeafId !== undefined && typeof item.forkLeafId !== 'string')
    || (item.owner !== undefined && (typeof item.owner.attemptId !== 'string' || !Number.isInteger(item.owner.generation) || typeof item.owner.expiresAt !== 'string'))
    || (item.ownerProcess !== undefined && !validProcessIdentity(item.ownerProcess))
    || (item.state !== 'ready' && item.state !== 'running' && item.state !== 'fork_ready' && item.state !== 'terminal' && item.state !== 'unknown')
    || !Array.isArray(item.evidenceRefs) || !item.evidenceRefs.every((ref) => typeof ref === 'string') || typeof item.cancellationRequested !== 'boolean') return undefined;
  if (item.persistedSession && (typeof item.persistedSession.sessionId !== 'string' || typeof item.persistedSession.sessionFile !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(item.persistedSession.historyHash) || !/^sha256:[0-9a-f]{64}$/.test(item.persistedSession.branchDigest))) return undefined;
  return Object.freeze({ ...item, ...(item.owner ? { owner: Object.freeze({ ...item.owner }) } : {}), ...(item.ownerProcess ? { ownerProcess: Object.freeze({ ...item.ownerProcess }) } : {}), evidenceRefs: Object.freeze([...item.evidenceRefs]), ...(item.persistedSession ? { persistedSession: Object.freeze({ ...item.persistedSession }) } : {}) }) as StoredWorker;
}
function continuationWorker(record: StoredWorker | undefined): record is ContinuationWorker {
  return Boolean(record && (record.state === 'terminal' || record.state === 'fork_ready') && !record.cancellationRequested && record.persistedSession
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
  processProbe?: ProcessProbe;
  executor: TrustedExecutor;
  claimExpiresAt(): string;
  /** Trusted host fact reader. It must return an observation, never a model claim. */
  readFact(precondition: Precondition): Promise<Observation<boolean>>;
  spawnCommand(input: WorkerSpawnInput, workerId: string, attemptId: string, context: HelmToolExecutionContext): Command;
  /** The generated successor identity is host-owned and must be bound by the immutable command payload. */
  steerCommand?(input: WorkerSteerInput, workerId: string, record: StoredWorker, attemptId: string, context: HelmToolExecutionContext): Command;
  /** The source snapshot is observed by the host, never supplied by the model. */
  forkCommand?(input: WorkerForkInput, workerId: string, record: StoredWorker, attemptId: string, source: PiForkSourceSnapshot, context: HelmToolExecutionContext): Command;
  /** Extract the host-configured immutable input digest from the command payload. */
  inputDigest(command: Command): string;
  stopCommand(record: StoredWorker, context: HelmToolExecutionContext): Command;
  attempt(command: Command, workerId: string): Attempt;
  workspace(command: Command, workerId: string, attempt: Attempt): Readonly<{ repository: string; destination: string; branch: string; baseSha: string; owner: WorktreeOwner; policy: { writableRoots: readonly string[]; readableRoots?: readonly string[]; protectedRoots?: readonly string[] } }>;
  start(command: Command, workspace: WorktreeReservation): Promise<PiNativeWorker>;
  rehydrate?(command: Command, workspace: WorktreeReservation, persisted: PiPersistedSession): Promise<PiNativeWorker>;
  fork?(command: Command, workspace: WorktreeReservation, persisted: PiPersistedSession, expectedLeafId: string): Promise<{ worker: PiNativeWorker; successor: PiPersistedSession; leafId: string }>;
  forkSourceSnapshot?(persisted: PiPersistedSession, workspace: WorktreeReservation): Promise<PiForkSourceSnapshot>;
  /** Host-built prompt bytes may be read from the immutable artifact refs captured at spawn. */
  prompt(command: Command): string | Promise<string>;
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
  /** Process-local half of the one-fork-per-source fence; the command journal is its restart-safe half. */
  readonly #forkSources = new Set<string>();
  constructor(private readonly binding: WorkerFleetBinding) {}

  /**
   * Safe owner probe for a durable record. Validates the probe result's state,
   * a bounded reason string, a strict UTC `observedAt`, and a fresh age in
   * 0..OBSERVATION_MAX_AGE_MS against `new Date()`. Returns a copied frozen
   * observation on success; every missing/failed/stale/future/malformed path
   * yields an explicit unknown with a generic reason. Arbitrary thrown error
   * text is never carried into the result or logged.
   */
  private async observeOwner(record: StoredWorker): Promise<ProcessObservation> {
    if (!record.ownerProcess) return unknownObservation('no owner process identity recorded');
    if (!this.binding.processProbe) return unknownObservation('process probe not configured');
    let probeResult: ProcessObservation | undefined;
    try { probeResult = await this.binding.processProbe.observe(record.ownerProcess); }
    catch { return unknownObservation('owner process probe failed'); }
    if (!probeResult || (probeResult.state !== 'same-process' && probeResult.state !== 'not-running' && probeResult.state !== 'unknown'))
      return unknownObservation('owner process probe returned an unexpected state');
    if (typeof probeResult.reason !== 'string' || probeResult.reason.length === 0 || probeResult.reason.length > 256)
      return unknownObservation('owner process probe reason is not a bounded string');
    let observedAt: string;
    try { observedAt = utcTimestampSchema.parse(probeResult.observedAt); }
    catch { return unknownObservation('owner process probe timestamp is malformed'); }
    const age = Date.now() - Date.parse(observedAt);
    if (age < 0) return unknownObservation('owner process probe observation is from the future');
    if (age > OBSERVATION_MAX_AGE_MS) return unknownObservation('owner process probe observation is stale');
    return Object.freeze({ state: probeResult.state, observedAt, reason: probeResult.reason });
  }

  async spawn(context: HelmToolExecutionContext, input: WorkerSpawnInput): Promise<{ workerId: string; attemptId: string; sessionId: string; state: 'ready' }> {
    const validated = Object.freeze({ ...input, contextRefs: Object.freeze([...input.contextRefs]), ...(input.reviewConstraint ? { reviewConstraint: Object.freeze({ ...input.reviewConstraint }) } : {}) });
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
        const review = validated.reviewConstraint;
        const sameRepository = !review || await realpath(config.repository) === await realpath(review.repository).catch(() => '');
        if (review && (review.mode !== 'review-readonly' || !/^[0-9a-f]{40}$/.test(review.expectedHead)
          || !sameRepository || config.baseSha !== review.expectedHead
          || config.policy.writableRoots.length !== 0 || (admitted.command.payload as { mode?: unknown }).mode !== 'review-readonly')) {
          throw new Error('independent review spawn does not bind its readonly repository head');
        }
        const workspace = await this.binding.workspaceManager.create(config.repository, config.destination, config.branch, config.baseSha, config.owner, config.policy);
        this.binding.host.assertModelProvenance(provenance.modelId, provenance.modelProvider, provenance.modelFactVersion);
        // This is the last trusted observation before a reviewer's native
        // request can begin. Persist it before creating the native worker;
        // later terminal observation compares these bytes instead of inferring
        // a before-state from the requested SHA or the after-state.
        const before = review ? await this.binding.workspaceManager.inspectGitReadonly(workspace) : undefined;
        const reviewBeforeRef = before
          ? (await this.binding.host.artifactsFor(context).journalForTrustedPi().append({ source: 'host.review.git.before', sourceIdentity: `host-review-git-before:${context.runId}:${attemptId}`, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, workerId, attemptId, spawnCommandId: admitted.command.commandId, repository: workspace.repository, workspace: workspace.root, head: before.head, clean: before.clean, status: before.status }), 'utf8'), classification: 'sensitive' }, { permitSensitive: true })).ref
          : undefined;
        const worker = await this.binding.start(admitted.command, workspace);
        if (worker.modelIdentity.modelId !== provenance.modelId || worker.modelIdentity.provider !== provenance.modelProvider || worker.modelIdentity.api !== provenance.modelApi) {
          worker.dispose();
          throw new Error('Pi runtime model does not match the admitted worker model');
        }
        // Freshly captured; never inherits a predecessor identity on steer/fork.
        const ownerProcess = await captureOwnerProcess(this.binding.processProbe);
        record = Object.freeze({ schemaVersion: 1, workerId, attemptId: attempt.attemptId, spawnCommandId: admitted.command.commandId, sessionId: worker.sessionId,
          workspace: workspace.root, owner: workspace.owner, ...(ownerProcess ? { ownerProcess } : {}), modelId: provenance.modelId, modelProvider: provenance.modelProvider, modelApi: provenance.modelApi, modelFactVersion: provenance.modelFactVersion, dataPolicy: provenance.dataPolicy, ...(reviewBeforeRef ? { reviewBeforeRef } : {}), state: 'ready', inputDigest: digest(validated), evidenceRefs: Object.freeze([]), cancellationRequested: false });
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
    if ((this.#live.has(validated.workerId) && predecessor.state !== 'fork_ready') || predecessor.sessionId !== validated.expectedSessionId || predecessor.persistedSession.sessionId !== validated.expectedSessionId) throw new Error('worker is active or session identity changed');
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
        // A fork-ready child is an idle live wrapper. Its transcript is already
        // durable; dispose it before reopening under the fresh continuation.
        if (predecessor.state === 'fork_ready') { this.#live.get(predecessor.workerId)?.worker.dispose(); this.#live.delete(predecessor.workerId); }
        const workspace = this.binding.workspaceManager.transfer(oldWorkspace, oldWorkspace.owner.generation, config.owner);
        const worker = await this.binding.rehydrate!(admitted.command, workspace, predecessor.persistedSession!);
        if (worker.sessionId !== predecessor.sessionId || worker.modelIdentity.modelId !== predecessor.modelId || worker.modelIdentity.provider !== predecessor.modelProvider || worker.modelIdentity.api !== predecessor.modelApi) { worker.dispose(); throw new Error('continuation native identity changed'); }
        // Freshly captured; never inherits a predecessor identity on steer/fork.
        const ownerProcess = await captureOwnerProcess(this.binding.processProbe);
        record = Object.freeze({ schemaVersion: 1, workerId, attemptId: attempt.attemptId, spawnCommandId: admitted.command.commandId, sessionId: worker.sessionId,
          workspace: workspace.root, owner: workspace.owner, ...(ownerProcess ? { ownerProcess } : {}), modelId: predecessor.modelId, modelProvider: predecessor.modelProvider, modelApi: predecessor.modelApi, modelFactVersion: predecessor.modelFactVersion, dataPolicy: predecessor.dataPolicy, state: 'ready', inputDigest: digest(validated), evidenceRefs: Object.freeze([]), cancellationRequested: false });
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

  /** Create a distinct, durable, idle Pi branch in a new worktree. */
  async fork(context: HelmToolExecutionContext, input: WorkerForkInput): Promise<{ workerId: string; attemptId: string; sessionId: string; state: 'fork_ready'; predecessorWorkerId: string }> {
    if (!this.binding.forkCommand || !this.binding.fork || !this.binding.forkSourceSnapshot) throw new Error('native session fork is not configured by this host');
    const validated = Object.freeze({ ...input });
    const predecessor = await this.durableRecord(context.runId, validated.workerId) ?? this.#records.get(validated.workerId);
    if (!continuationWorker(predecessor) || predecessor.state !== 'terminal') throw new Error('worker is not a durable terminal Pi fork source');
    if (this.#live.has(validated.workerId) || predecessor.sessionId !== validated.expectedSessionId || predecessor.persistedSession.sessionId !== validated.expectedSessionId) throw new Error('worker is active or session identity changed');
    const sourceWorkspace = this.binding.workspaceManager.reservation(predecessor.workspace);
    if (sourceWorkspace.owner.attemptId !== predecessor.owner.attemptId || sourceWorkspace.owner.generation !== predecessor.owner.generation || sourceWorkspace.owner.expiresAt !== predecessor.owner.expiresAt) throw new Error('predecessor worktree generation is no longer current');
    await this.binding.workspaceManager.assertExactHead(sourceWorkspace, validated.expectedHead);
    const source = await this.binding.forkSourceSnapshot(predecessor.persistedSession, sourceWorkspace);
    const prior = (await this.binding.host.snapshot(context.runId)).commands.find((item) => item.command.kind === 'worker.fork'
      && (item.command.payload as { predecessorWorkerId?: unknown }).predecessorWorkerId === predecessor.workerId);
    if (prior || this.#forkSources.has(predecessor.workerId)) throw new Error('worker already has a durable fork attempt');
    this.#forkSources.add(predecessor.workerId);
    // A source has at most one fork identity.  This turns concurrent fleet
    // instances into Core idempotency of the same durable command, rather
    // than a check-then-create race between independently random children.
    const forkIdentity = digest({ runId: context.runId, predecessorWorkerId: predecessor.workerId, sessionId: predecessor.sessionId, expectedHead: validated.expectedHead }).slice('sha256:'.length, 'sha256:'.length + 32);
    const workerId = `worker-fork-${forkIdentity}`; const attemptId = `attempt-${workerId}`;
    const command = this.binding.forkCommand(validated, workerId, predecessor, attemptId, source, context);
    const payload = command.payload as { workerId?: unknown; attemptId?: unknown; predecessorWorkerId?: unknown; inputDigest?: unknown; modelId?: unknown; modelProvider?: unknown; modelApi?: unknown; modelFactVersion?: unknown; dataPolicy?: unknown; sourceHistoryHash?: unknown; sourceBranchDigest?: unknown; sourceSessionId?: unknown; sourceLeafId?: unknown };
    if (payload.workerId !== workerId || payload.attemptId !== attemptId || payload.predecessorWorkerId !== predecessor.workerId || payload.inputDigest !== digest(validated)
      || payload.modelId !== predecessor.modelId || payload.modelProvider !== predecessor.modelProvider || payload.modelApi !== predecessor.modelApi || payload.modelFactVersion !== predecessor.modelFactVersion || payload.dataPolicy !== predecessor.dataPolicy
      || payload.sourceSessionId !== source.sessionId || payload.sourceHistoryHash !== source.historyHash || payload.sourceBranchDigest !== source.branchDigest || payload.sourceLeafId !== source.leafId) throw new Error('worker fork command does not bind successor, predecessor, source session, leaf, and immutable validated inputs');
    // The destination and its owner are selected before admission and copied
    // into the immutable command bytes; an effect may only recreate this plan.
    const plannedAttempt = this.binding.attempt(command, workerId);
    const plannedConfig = this.binding.workspace(command, workerId, plannedAttempt);
    const destination = (command.payload as { destination?: unknown; ownerAttemptId?: unknown; ownerGeneration?: unknown; ownerExpiresAt?: unknown });
    if (destination.destination !== plannedConfig.destination || destination.ownerAttemptId !== plannedConfig.owner.attemptId || destination.ownerGeneration !== plannedConfig.owner.generation || destination.ownerExpiresAt !== plannedConfig.owner.expiresAt) throw new Error('worker fork command does not bind child destination and owner');
    const admitted = this.binding.host.admitOrchestrator(command, context, command.actorId, attemptId); const attempt = this.binding.attempt(admitted.command, workerId);
    let record: StoredWorker | undefined;
    const effect: KernelEffect = { effectId: `host:worker-fork:${workerId}`,
      execute: async () => {
        await this.binding.workspaceManager.assertExactHead(sourceWorkspace, validated.expectedHead);
        const currentSource = await this.binding.forkSourceSnapshot!(predecessor.persistedSession!, sourceWorkspace);
        if (currentSource.sessionId !== source.sessionId || currentSource.leafId !== source.leafId || currentSource.historyHash !== source.historyHash || currentSource.branchDigest !== source.branchDigest) throw new Error('fork source changed after admission');
        const currentOwner = this.binding.workspaceManager.reservation(predecessor.workspace).owner;
        if (currentOwner.attemptId !== predecessor.owner.attemptId || currentOwner.generation !== predecessor.owner.generation || currentOwner.expiresAt !== predecessor.owner.expiresAt) throw new Error('predecessor worktree generation changed before fork effect');
        this.binding.host.assertEffectAuthority(admitted.command.commandId, context);
        this.binding.host.assertModelProvenance(predecessor.modelId, predecessor.modelProvider, predecessor.modelFactVersion);
        this.binding.host.recordAttempt(attempt);
        const config = this.binding.workspace(admitted.command, workerId, attempt);
        if (config.destination !== plannedConfig.destination || config.owner.attemptId !== plannedConfig.owner.attemptId || config.owner.generation !== plannedConfig.owner.generation || config.owner.expiresAt !== plannedConfig.owner.expiresAt) throw new Error('fork destination or owner changed after admission');
        if (config.destination === predecessor.workspace || config.baseSha !== validated.expectedHead || attempt.baseSha !== validated.expectedHead) throw new Error('fork must use a new worktree at the verified source head');
        const workspace = await this.binding.workspaceManager.create(config.repository, config.destination, config.branch, config.baseSha, config.owner, config.policy);
        const forked = await this.binding.fork!(admitted.command, workspace, predecessor.persistedSession!, source.leafId);
        if (forked.worker.sessionId === predecessor.sessionId || forked.successor.sessionId !== forked.worker.sessionId || forked.successor.branchDigest !== predecessor.persistedSession!.branchDigest
          || forked.leafId !== source.leafId || forked.worker.modelIdentity.modelId !== predecessor.modelId || forked.worker.modelIdentity.provider !== predecessor.modelProvider || forked.worker.modelIdentity.api !== predecessor.modelApi) { forked.worker.dispose(); throw new Error('fork native identity changed'); }
        const ownerProcess = await captureOwnerProcess(this.binding.processProbe);
        record = Object.freeze({ schemaVersion: 1, workerId, attemptId: attempt.attemptId, spawnCommandId: admitted.command.commandId, sessionId: forked.worker.sessionId, workspace: workspace.root, owner: workspace.owner, modelId: predecessor.modelId, modelProvider: predecessor.modelProvider, modelApi: predecessor.modelApi, modelFactVersion: predecessor.modelFactVersion, dataPolicy: predecessor.dataPolicy, forkLeafId: forked.leafId, state: 'fork_ready', inputDigest: digest(validated), evidenceRefs: Object.freeze([]), cancellationRequested: false, persistedSession: forked.successor });
        record = Object.freeze({ ...record, ...(ownerProcess ? { ownerProcess } : {}) });
        this.#records.set(workerId, record); this.#live.set(workerId, Object.freeze({ worker: forked.worker, record, context: Object.freeze({ ...context }), command: admitted.command }));
      },
      observe: async () => {
        if (!record) return { commandId: admitted.command.commandId, effectId: `host:worker-fork:${workerId}`, state: 'unknown' as const, source: 'host.worker_fleet', observedAt: now(), evidenceRefs: [`worker:${workerId}:fork-missing`] };
        const ref = await this.binding.host.artifactsFor(context).writeEffect('host.worker_fleet.fork', JSON.stringify({ ...record, predecessorWorkerId: predecessor.workerId, predecessorAttemptId: predecessor.attemptId, expectedHead: validated.expectedHead }));
        const persisted = Object.freeze({ ...record, evidenceRefs: Object.freeze([ref]) }); this.#records.set(workerId, persisted);
        const live = this.#live.get(workerId); if (live) this.#live.set(workerId, Object.freeze({ ...live, record: persisted }));
        this.binding.host.appendFleetEvent(event('worker.forked', persisted, context.runId, { predecessorWorkerId: predecessor.workerId, predecessorAttemptId: predecessor.attemptId, expectedHead: validated.expectedHead, leafId: record.forkLeafId }));
        return { commandId: admitted.command.commandId, effectId: `host:worker-fork:${workerId}`, state: 'succeeded' as const, source: 'host.worker_fleet', observedAt: now(), evidenceRefs: [ref] };
      } };
    const observed = await this.binding.host.performAdmitted(admitted.command.commandId, this.binding.executor, this.binding.claimExpiresAt(), this.binding.readFact, effect);
    if (observed.state === 'unknown') {
      if (record) {
        const unknown = Object.freeze({ ...record, state: 'unknown' as const });
        this.#live.get(workerId)?.worker.dispose(); this.#live.delete(workerId); this.#records.set(workerId, unknown);
        try { this.#records.set(workerId, await this.persistRecord(context, unknown, 'terminal')); } catch { /* Core already recorded an unknown effect; keep the local quarantine. */ }
      }
      throw new WorkerSteerUnknownError(admitted.command.commandId);
    }
    if (observed.state !== 'succeeded' || !record) throw new Error('worker fork was not durably observed');
    return { workerId, attemptId: record.attemptId, sessionId: record.sessionId, state: 'fork_ready', predecessorWorkerId: predecessor.workerId };
  }

  /** Test/controlled-host hook; normal orchestration must use inspect/events. */
  async waitForTerminal(workerId: string): Promise<void> { await this.#runs.get(workerId); }

  private async run(workerId: string, live: LiveWorker): Promise<void> {
    let terminal: StoredWorker | undefined;
    try {
      const outcome = await live.worker.run(await this.binding.prompt(live.command), this.binding.correction(live.command));
      const completed = Object.freeze({ ...live.record, state: 'terminal' as const, persistedSession: await live.worker.persistedSession(), evidenceRefs: Object.freeze([...live.record.evidenceRefs, ...outcome.artifacts.map((item) => item.ref)]) });
      // Write a disposition before updating the query projection. A completed
      // agent may disappear between these operations; its evidence must not.
      terminal = await this.persistRecord(live.context, completed, 'terminal');
      this.#records.set(workerId, terminal);
      this.binding.host.reportAttemptStop(live.record.attemptId, 'stopped');
      await this.appendAndDeliverSupervisorEvent(event('worker.completed', terminal, live.context.runId, { result: outcome.result.status, evidenceRefs: terminal.evidenceRefs }));
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
      await this.appendAndDeliverSupervisorEvent(event('worker.failed', terminal, live.context.runId, { disposition: 'unknown' }));
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
      await this.appendAndDeliverSupervisorEvent(event('worker.failed', persisted, live.context.runId, { disposition: 'unknown', persistence: 'recovered' }));
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

  /**
   * Terminal evidence and its fleet event are the durable fact.  Supervisor
   * notification is deliberately best-effort: a delivery failure must leave
   * that fact intact for replay, rather than turning a completed worker into
   * a new unknown outcome or an unhandled runner rejection.
   */
  private async appendAndDeliverSupervisorEvent(fleetEvent: Event): Promise<void> {
    this.binding.host.appendFleetEvent(fleetEvent);
    try { await this.deliverSupervisorEvent(fleetEvent); }
    catch { /* The durable fleet event is replayable after any delivery fault. */ }
  }

  /** Convert one already-persisted native terminal observation into a signal. */
  private async deliverSupervisorEvent(fleetEvent: Event): Promise<void> {
    if (fleetEvent.source !== 'host.worker_fleet'
      || (fleetEvent.kind !== 'worker.completed' && fleetEvent.kind !== 'worker.failed')
      || !fleetEvent.commandId || !fleetEvent.attemptId || !fleetEvent.sessionId) {
      throw new Error('fleet event is not a terminal worker observation');
    }
    const runId = fleetEvent.correlationId;
    const snapshot = await this.binding.host.snapshot(runId);
    const admitted = snapshot.commands.find((entry) => entry.command.commandId === fleetEvent.commandId);
    const payload = admitted?.command.payload as { workerId?: unknown; attemptId?: unknown } | undefined;
    if (!admitted || (admitted.command.kind !== 'worker.spawn' && admitted.command.kind !== 'worker.steer')
      || admitted.command.runId !== runId || admitted.command.scope.mapNodeId === undefined
      || payload?.attemptId !== fleetEvent.attemptId || typeof payload.workerId !== 'string'
      || !snapshot.attempts.some((attempt) => attempt.attemptId === fleetEvent.attemptId && attempt.commandIds.includes(admitted.command.commandId))) {
      throw new Error('fleet event is not bound to an admitted worker attempt');
    }
    const phase = fleetEvent.kind === 'worker.completed' ? 'terminal-known' : 'terminal-unknown';
    const phaseRecord = await this.binding.host.readFleetEffectRecordByIdentity(runId, `host-worker-${phase}:${runId}:${fleetEvent.attemptId}`);
    if (!phaseRecord) throw new Error('fleet terminal evidence is absent');
    let record: StoredWorker | undefined;
    try { record = storedWorker(JSON.parse(phaseRecord.text)); } catch { throw new Error('fleet terminal evidence is malformed'); }
    if (!record || record.state !== (fleetEvent.kind === 'worker.completed' ? 'terminal' : 'unknown')
      || record.workerId !== payload.workerId || record.attemptId !== fleetEvent.attemptId
      || record.spawnCommandId !== admitted.command.commandId || record.sessionId !== fleetEvent.sessionId) {
      throw new Error('fleet terminal evidence does not match its event binding');
    }
    let needsJudgement = fleetEvent.kind === 'worker.failed';
    if (fleetEvent.kind === 'worker.completed') {
      const reported = typeof (fleetEvent.payload as { result?: unknown } | null)?.result === 'string'
        ? (fleetEvent.payload as { result: string }).result : undefined;
      const result = await this.binding.host.readFleetTerminalResult({ attemptId: record.attemptId, evidenceRefs: record.evidenceRefs });
      if (!reported || !result || result.status !== reported) throw new Error('fleet completion result is not bound to its immutable terminal envelope');
      // A valid native failure is distinct from an infrastructure-unknown
      // event. It remains a completed worker fact, but requires judgement.
      needsJudgement = result?.status === 'failed' || result?.status === 'partial';
    }
    await this.binding.host.createSupervisor().process({ signal: {
      runId,
      mapNodeId: admitted.command.scope.mapNodeId,
      source: 'host.worker_fleet',
      // The appended event ID is the stable identity on direct delivery and
      // after restart; never derive a replacement ID during replay.
      sourceEventId: fleetEvent.eventId,
      group: record.workerId,
      observedAt: fleetEvent.occurredAt,
      kind: fleetEvent.kind,
      evidenceRefs: [...new Set([...record.evidenceRefs, phaseRecord.evidenceRef])],
      needsJudgement,
    } });
  }

  /**
   * Explicit library recovery hook. Hosts call it after reopening their
   * durable control plane; it neither discovers processes nor starts/retries
   * workers, and replaying an event is deduplicated by its persisted ID.
   */
  async replaySupervisorEvents(runId: string): Promise<void> {
    const events = this.binding.host.createSupervisor().log().readEvents(runId);
    for (const fleetEvent of events) {
      if (fleetEvent.source !== 'host.worker_fleet' || (fleetEvent.kind !== 'worker.completed' && fleetEvent.kind !== 'worker.failed')) continue;
      try { await this.deliverSupervisorEvent(fleetEvent); }
      catch { /* Invalid or incomplete historical records never create a signal. */ }
    }
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
        if (winner) {
          if (winner.state === 'fork_ready' && command?.status !== 'succeeded') return Object.freeze({ ...winner, state: 'unknown' as const });
          return Object.freeze({ ...winner,
          evidenceRefs: Object.freeze([...new Set([...(terminalKnown?.evidenceRefs ?? []), ...(terminalUnknown?.evidenceRefs ?? []), ...(stopConfirmed?.evidenceRefs ?? []), ...(stopUnknown?.evidenceRefs ?? [])])]),
          cancellationRequested: Boolean(terminalKnown?.cancellationRequested || terminalUnknown?.cancellationRequested || stopConfirmed?.cancellationRequested || stopUnknown?.cancellationRequested),
        });
        }
      } catch { return undefined; }
    }
    const ref = command?.observations.flatMap((entry) => entry.evidenceRefs).find((entry) => entry.includes('"kind":"effect"'));
    if (!ref) return undefined;
    try {
      const record = storedWorker(JSON.parse(await this.binding.host.readFleetEffect(runId, ref)));
      return record?.state === 'fork_ready' && command?.status !== 'succeeded' ? Object.freeze({ ...record, state: 'unknown' as const }) : record;
    } catch { return undefined; }
  }

  async inspect(context: HelmToolExecutionContext, workerId: string): Promise<WorkerInspect> {
    // Durable terminal/stop evidence wins over a stale in-memory projection.
    let record = await this.durableRecord(context.runId, workerId) ?? this.#records.get(workerId);
    const live = this.#live.get(workerId);
    if (!record) throw new Error('unknown worker');
    this.#records.set(workerId, record);
    let ownerProcessObservation: ProcessObservation | undefined;
    // Honest inspection: a failed probe yields an explicit unknown observation
    // rather than silently omitting it.
    ownerProcessObservation = await this.observeOwner(record);
    const { persistedSession: _privateSession, owner: _privateOwner, ownerProcess: _privateOwnerProcess, modelId: _privateModelId, modelProvider: _privateModelProvider, modelApi: _privateModelApi, modelFactVersion: _privateModelFactVersion, dataPolicy: _privateDataPolicy, ...publicRecord } = record;
    if (ownerProcessObservation) (publicRecord as { ownerProcessObservation?: ProcessObservation }).ownerProcessObservation = ownerProcessObservation;
    if (!live) return { ...publicRecord, live: 'unknown', state: record.state === 'terminal' || record.state === 'fork_ready' ? record.state : 'unknown', evidenceRefs: record.evidenceRefs };
    // Liveness is an observation of the local process only; durable outcome,
    // cancellation intent and evidence remain authoritative for the worker.
    return { ...publicRecord, state: record.state === 'ready' && live.worker.isActive ? 'running' : record.state, live: 'known', contextOccupancy: live.worker.contextOccupancy, evidenceRefs: record.evidenceRefs };
  }

  /**
   * Reconstructs terminal provenance from the durable fleet journal. It does
   * not await, start, stop, steer, claim, or otherwise affect a worker.
   */
  async terminalJournal(context: HelmToolExecutionContext, workerId: string): Promise<WorkerTerminalJournal | undefined> {
    const record = await this.durableRecord(context.runId, workerId);
    if (!record || record.state !== 'terminal' || record.cancellationRequested || !record.owner || !record.modelId || !record.modelProvider || !record.modelApi || !record.reviewBeforeRef) return undefined;
    return Object.freeze({ workerId: record.workerId, attemptId: record.attemptId, sessionId: record.sessionId, spawnCommandId: record.spawnCommandId, workspace: record.workspace, owner: Object.freeze({ ...record.owner }), modelId: record.modelId, modelProvider: record.modelProvider, modelApi: record.modelApi, evidenceRefs: Object.freeze([...record.evidenceRefs]), reviewBeforeRef: record.reviewBeforeRef });
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

  async observeProcesses(runId: string): Promise<void> {
    const snapshot = await this.binding.host.snapshot(runId);
    for (const entry of snapshot.commands) {
      const cmd = entry.command;
      if (cmd.kind !== 'worker.spawn' && cmd.kind !== 'worker.steer') continue;
      if (cmd.runId !== runId) continue;
      const payload = cmd.payload as { workerId?: unknown; attemptId?: unknown } | undefined;
      const workerId = payload?.workerId;
      const attemptId = payload?.attemptId;
      if (typeof workerId !== 'string' || typeof attemptId !== 'string') continue;
      // Attempt commandIds is historical metadata and can legitimately be empty.
      // The trusted durable launch record below binds the command and attempt.
      const attempt = snapshot.attempts.find((a) => a.attemptId === attemptId && a.mapNodeId === cmd.scope.mapNodeId);
      if (!attempt) continue;
      // 1. Read the durable record first.
      const record = await this.durableRecord(runId, workerId);
      if (!record) continue;
      if (record.attemptId !== attemptId || record.spawnCommandId !== cmd.commandId) continue;
      // Skip settled records; monitoring never questions a durable disposition.
      if (record.state === 'terminal' || record.state === 'fork_ready') continue;
      // 2. Probe the owner freshly (safe, bounded, never leaks thrown text).
      const observation = await this.observeOwner(record);
      // 3. Re-read durable terminal/owner/generation AFTER the await, before
      //    emitting, so a race cannot make us question an already-settled or
      //    re-owned worker.
      const settled = await this.durableRecord(runId, workerId);
      if (!settled || settled.state === 'terminal' || settled.state === 'fork_ready') continue;
      if (settled.workerId !== workerId || settled.attemptId !== attemptId || settled.spawnCommandId !== cmd.commandId || settled.sessionId !== record.sessionId || settled.workspace !== record.workspace) continue;
      // A missing owner is an uncertain condition, not a silent skip.
      let currentOwner: WorktreeOwner | undefined;
      if (settled.workspace) {
        try { currentOwner = this.binding.workspaceManager.reservation(settled.workspace).owner; }
        catch { currentOwner = undefined; }
      }
      const ownerMatches = Boolean(
        settled.owner
        && currentOwner
        && currentOwner.attemptId === settled.owner.attemptId
        && currentOwner.generation === settled.owner.generation
        && currentOwner.expiresAt === settled.owner.expiresAt
      );
      // Same process with the current owner is the only quiet case. Everything
      // else merely raises a question; monitoring never stops, retries, or
      // reports success.
      if (observation.state === 'same-process' && ownerMatches) continue;
      // 4. Stable semantic fingerprint: run + immutable worker/session binding
      //    + process state/reason + the CURRENT owner identity.
      const semanticFingerprint = digest({
        runId,
        workerId: settled.workerId,
        attemptId: settled.attemptId,
        sessionId: settled.sessionId,
        spawnCommandId: settled.spawnCommandId,
        processState: observation.state,
        reason: observation.reason,
        currentOwner: currentOwner ? { attemptId: currentOwner.attemptId, generation: currentOwner.generation, expiresAt: currentOwner.expiresAt } : null,
      });
      const deterministicSourceEventId = `process-obs:${settled.workerId}:${settled.attemptId}:${semanticFingerprint}`;
      // 5. Reuse an exact persisted event across ticks/reopen; verify it; on a
      //    concurrent append failure recover only if the exact event persisted.
      const supervisorLog = this.binding.host.createSupervisor().log();
      const priorEvent = supervisorLog.readEvents(runId).find((ev) => ev.source === 'host.worker_fleet' && ev.sourceEventId === deterministicSourceEventId);
      let fleetEvent: Event;
      if (priorEvent) {
        fleetEvent = this.#verifyReusedEvent(priorEvent, deterministicSourceEventId, runId, settled, semanticFingerprint);
      } else {
        const eventOccurredAt = now();
        const candidateEvent: Event = {
          schemaVersion: 1,
          eventId: deterministicSourceEventId,
          kind: 'reconciliation.ambiguous',
          source: 'host.worker_fleet',
          sourceEventId: deterministicSourceEventId,
          occurredAt: eventOccurredAt,
          recordedAt: eventOccurredAt,
          commandId: settled.spawnCommandId,
          attemptId: settled.attemptId,
          sessionId: settled.sessionId,
          correlationId: runId,
          payload: {
            workerId: settled.workerId,
            attemptId: settled.attemptId,
            observation,
            ownerMatches,
            currentOwner: currentOwner ? { ...currentOwner } : undefined,
            recordedOwner: settled.owner ? { ...settled.owner } : undefined,
            semanticFingerprint,
          },
        };
        try {
          this.binding.host.appendFleetEvent(candidateEvent);
          fleetEvent = candidateEvent;
        } catch {
          // Concurrent append: only recover when the exact matching event exists.
          const raced = supervisorLog.readEvents(runId).find((ev) => ev.source === 'host.worker_fleet' && ev.sourceEventId === deterministicSourceEventId);
          if (!raced) throw new Error('worker reconciliation observation was not durably recorded');
          fleetEvent = this.#verifyReusedEvent(raced, deterministicSourceEventId, runId, settled, semanticFingerprint);
        }
      }
      if (cmd.scope.mapNodeId !== undefined) {
        // Reference the persisted observation event alongside prior evidence.
        const evidenceRefs = [...new Set([...settled.evidenceRefs, `event:${fleetEvent.eventId}`])];
        await this.binding.host.createSupervisor().process({ signal: { runId, mapNodeId: cmd.scope.mapNodeId, source: 'host.worker_fleet', sourceEventId: fleetEvent.eventId, group: settled.workerId, observedAt: fleetEvent.occurredAt, kind: 'reconciliation.ambiguous', evidenceRefs, needsJudgement: true } });
      }
    }
  }

  /** Verify a reused observation event; a malformed existing event throws. */
  #verifyReusedEvent(event: Event, expectedSourceEventId: string, runId: string, record: StoredWorker, expectedFingerprint: string): Event {
    const payload = event.payload as { workerId?: unknown; attemptId?: unknown; semanticFingerprint?: unknown } | undefined;
    if (event.eventId !== expectedSourceEventId || event.sourceEventId !== expectedSourceEventId
      || event.source !== 'host.worker_fleet'
      || event.kind !== 'reconciliation.ambiguous'
      || event.correlationId !== runId
      || event.commandId !== record.spawnCommandId
      || event.attemptId !== record.attemptId
      || event.sessionId !== record.sessionId
      || payload?.workerId !== record.workerId
      || payload?.attemptId !== record.attemptId
      || payload?.semanticFingerprint !== expectedFingerprint) {
      throw new Error('persisted reconciliation observation is malformed');
    }
    return event;
  }
}
