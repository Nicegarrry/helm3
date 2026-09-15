import { createHash, randomUUID } from 'node:crypto';
import type { Attempt, Command, Event, Observation, Precondition } from '../contracts/index.js';
import type { KernelEffect, TrustedExecutor } from '../core/index.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import type { PiNativeWorker } from '../runtime/pi/index.js';
import type { WorktreeOwner, WorktreeReservation, WorkspaceManager } from '../workspace/index.js';
import type { HostControlPlane } from './index.js';

export type WorkerSpawnInput = Readonly<{ objectiveRef: string; acceptanceRef: string; contextRefs: readonly string[]; modelId: string; role: string; label?: string }>;
export type WorkerInspect = Readonly<{
  workerId: string; attemptId: string; spawnCommandId: string; sessionId: string; workspace: string;
  state: 'ready' | 'running' | 'terminal' | 'unknown'; live: 'known' | 'unknown';
  activeRequests?: number; contextOccupancy?: unknown; eventCursor?: string;
  evidenceRefs: readonly string[]; cancellationRequested: boolean;
}>;
type SpawnProvenance = Readonly<{ modelId: string; inputDigest: string; baseSha: string; modelFactVersion: number; dataPolicy: string }>;
type StoredWorker = Readonly<{ schemaVersion: 1; workerId: string; attemptId: string; spawnCommandId: string; sessionId: string; workspace: string; state: WorkerInspect['state']; inputDigest: string; evidenceRefs: readonly string[]; cancellationRequested: boolean }>;
type LiveWorker = Readonly<{ worker: PiNativeWorker; record: StoredWorker; context: HelmToolExecutionContext; command: Command }>;

function digest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function spawnProvenance(command: Command): SpawnProvenance {
  const value = command.payload as Partial<SpawnProvenance>;
  if (typeof value.modelId !== 'string' || typeof value.inputDigest !== 'string' || typeof value.baseSha !== 'string'
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
  /** Extract the host-configured immutable input digest from the command payload. */
  inputDigest(command: Command): string;
  stopCommand(record: StoredWorker, context: HelmToolExecutionContext): Command;
  attempt(command: Command, workerId: string): Attempt;
  workspace(command: Command, workerId: string, attempt: Attempt): Readonly<{ repository: string; destination: string; branch: string; baseSha: string; owner: WorktreeOwner; policy: { writableRoots: readonly string[]; protectedRoots?: readonly string[] } }>;
  start(command: Command, workspace: WorktreeReservation): Promise<PiNativeWorker>;
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
  readonly #stopping = new Set<string>();
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
    const admitted = this.binding.host.admitOrchestrator(command, context, command.actorId);
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
        const worker = await this.binding.start(admitted.command, workspace);
        if (worker.modelIdentity.modelId !== provenance.modelId) {
          worker.dispose();
          throw new Error('Pi runtime model does not match the admitted worker model');
        }
        record = Object.freeze({ schemaVersion: 1, workerId, attemptId: attempt.attemptId, spawnCommandId: admitted.command.commandId, sessionId: worker.sessionId,
          workspace: workspace.root, state: 'ready', inputDigest: digest(validated), evidenceRefs: Object.freeze([]), cancellationRequested: false });
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

  /** Test/controlled-host hook; normal orchestration must use inspect/events. */
  async waitForTerminal(workerId: string): Promise<void> { await this.#runs.get(workerId); }

  private async run(workerId: string, live: LiveWorker): Promise<void> {
    let terminal: StoredWorker | undefined;
    try {
      const outcome = await live.worker.run(this.binding.prompt(live.command), this.binding.correction(live.command));
      const completed = Object.freeze({ ...live.record, state: 'terminal' as const, evidenceRefs: Object.freeze([...live.record.evidenceRefs, ...outcome.artifacts.map((item) => item.ref)]) });
      // Write a disposition before updating the query projection. A completed
      // agent may disappear between these operations; its evidence must not.
      terminal = await this.persistRecord(live.context, completed, 'terminal');
      this.#records.set(workerId, terminal);
      this.binding.host.reportAttemptStop(live.record.attemptId, 'stopped');
      this.binding.host.appendFleetEvent(event('worker.completed', terminal, live.context.runId, { result: outcome.result.status, evidenceRefs: terminal.evidenceRefs }));
    } catch {
      if (this.#stopping.has(workerId)) return;
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
    const identity = `host-worker-${phase}:${context.runId}:${record.workerId}`;
    const ref = await this.binding.host.artifactsFor(context).writeEffect(`host.worker_fleet.${phase}`, JSON.stringify(record), identity);
    return Object.freeze({ ...record, evidenceRefs: Object.freeze([...record.evidenceRefs, ref]) });
  }

  async inspect(context: HelmToolExecutionContext, workerId: string): Promise<WorkerInspect> {
    let record = this.#records.get(workerId);
    const live = this.#live.get(workerId);
    if (!record) {
      const snapshot = await this.binding.host.snapshot(context.runId);
      const command = snapshot.commands.find((entry) => (entry.command.payload as { workerId?: unknown }).workerId === workerId);
      const terminal = await this.binding.host.readFleetEffectByIdentity(context.runId, `host-worker-terminal:${context.runId}:${workerId}`)
        ?? await this.binding.host.readFleetEffectByIdentity(context.runId, `host-worker-stop:${context.runId}:${workerId}`);
      const ref = command?.observations.flatMap((entry) => entry.evidenceRefs).find((entry) => entry.includes('"kind":"effect"'));
      if (terminal || ref) {
        try { record = JSON.parse(terminal ?? await this.binding.host.readFleetEffect(context.runId, ref!)) as StoredWorker; this.#records.set(workerId, record); }
        catch { /* durable bytes unavailable => honest unknown below */ }
      }
    }
    if (!record) throw new Error('unknown worker');
    if (!live) return { ...record, live: 'unknown', state: record.state === 'terminal' ? 'terminal' : 'unknown', evidenceRefs: record.evidenceRefs };
    return { ...live.record, state: live.worker.isActive ? 'running' : live.record.state, live: 'known', activeRequests: live.worker.isActive ? 1 : 0, contextOccupancy: live.worker.contextOccupancy, evidenceRefs: live.record.evidenceRefs };
  }

  async stop(context: HelmToolExecutionContext, workerId: string): Promise<{ state: 'stopped' | 'pending' | 'unknown'; evidenceRefs: readonly string[] }> {
    const live = this.#live.get(workerId); const record = this.#records.get(workerId);
    if (!record) throw new Error('unknown worker');
    if (!live && record.state === 'terminal') return { state: 'stopped', evidenceRefs: record.evidenceRefs };
    const command = this.binding.stopCommand(record, context);
    const admitted = this.binding.host.admitOrchestrator(command, context, command.actorId);
    let disposition: 'stopped' | 'unknown' = 'unknown'; let ref: string | undefined;
    const effect: KernelEffect = {
      effectId: `host:worker-stop:${workerId}`,
      execute: async () => { if (live) this.#stopping.add(workerId); disposition = live ? await live.worker.stopLocal() : 'unknown'; },
      observe: async () => {
        const updated = await this.persistRecord(context, Object.freeze({ ...record, state: disposition === 'stopped' ? 'terminal' : 'unknown', cancellationRequested: true }), 'stop');
        this.#records.set(workerId, updated); ref = updated.evidenceRefs.at(-1)!;
        if (disposition !== 'stopped') this.binding.host.reportAttemptStop(record.attemptId, 'unknown');
        return { commandId: admitted.command.commandId, effectId: `host:worker-stop:${workerId}`, state: disposition === 'stopped' ? 'succeeded' : 'unknown', source: 'host.worker_fleet', observedAt: now(), evidenceRefs: [ref] };
      },
    };
    const observed = await this.binding.host.performAdmitted(admitted.command.commandId, this.binding.executor, this.binding.claimExpiresAt(), this.binding.readFact, effect);
    if (observed.state === 'succeeded') {
      this.#live.delete(workerId); this.#runs.delete(workerId); this.#stopping.delete(workerId);
      if (live && !live.worker.isActive) live.worker.dispose();
    }
    return { state: observed.state === 'succeeded' ? 'stopped' : 'unknown', evidenceRefs: ref ? [ref] : [] };
  }
}
