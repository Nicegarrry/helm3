import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import { type OrchestratorLease, utcTimestampSchema } from '../contracts/index.js';
import type { CommandRecord, EffectObservation, KernelHost, TrustedExecutor } from '../core/index.js';

const id = z.string().min(1).max(512);
const signalSchema = z.object({
  runId: id, mapNodeId: id, source: id, sourceEventId: id, group: id,
  observedAt: utcTimestampSchema,
  kind: z.enum(['worker.failed', 'provider.blocked', 'gate.finished', 'reconciliation.ambiguous', 'worker.completed']),
  evidenceRefs: z.array(id).max(100),
  needsJudgement: z.boolean(),
}).strict();
export type SupervisorSignal = z.infer<typeof signalSchema>;
export type Wake = Readonly<{ runId: string; epoch: number; group: string; wakeId: string; causes: readonly string[]; evidenceRefs: readonly string[] }>;
/**
 * The deliberately small trusted Log capability the supervisor needs.  It is
 * safe to hand this to deterministic supervisor code, but not to a model or
 * an external observation adapter.
 */
export type SupervisorLog = Pick<KernelHost, 'appendEvent' | 'appendOwnedEvent' | 'readEvents' | 'assertCurrentOwner'>;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const correlation = (runId: string): string => `supervisor:${runId}`;

/** Durable signals and coalesced judgement queue; this does not itself invoke a model. */
export class EventSupervisor {
  constructor(private readonly log: SupervisorLog, private readonly now: () => string) {}

  record(input: SupervisorSignal): void {
    const signal = signalSchema.parse(input);
    const key = hash([signal.runId, signal.source, signal.sourceEventId]);
    this.log.appendEvent({ eventId: key, schemaVersion: 1, kind: 'supervisor.signal',
      source: 'helm.supervisor.signal', sourceEventId: key, correlationId: correlation(signal.runId),
      occurredAt: signal.observedAt, recordedAt: signal.observedAt, payload: signal });
  }

  pending(owner: OrchestratorLease): readonly Wake[] {
    const current = this.log.assertCurrentOwner(owner);
    const events = this.log.readEvents(correlation(current.runId));
    const acknowledged = new Set<string>();
    for (const event of events) {
      if (event.kind !== 'supervisor.ack' || event.source !== 'helm.supervisor.ack') continue;
      const ack = ackSchema.parse(event.payload);
      if (ack.runId !== current.runId) throw new Error('foreign supervisor acknowledgement');
      for (const cause of ack.causes) acknowledged.add(cause);
    }
    const groups = new Map<string, { causes: string[]; refs: Set<string> }>();
    for (const event of events) {
      if (event.kind !== 'supervisor.signal' || event.source !== 'helm.supervisor.signal') continue;
      const signal = signalSchema.parse(event.payload);
      if (signal.runId !== current.runId) throw new Error('foreign supervisor signal');
      if (!signal.needsJudgement || acknowledged.has(event.eventId)) continue;
      const group = groups.get(signal.group) ?? { causes: [], refs: new Set<string>() };
      group.causes.push(event.eventId);
      signal.evidenceRefs.forEach((ref) => group.refs.add(ref));
      groups.set(signal.group, group);
    }
    return Object.freeze([...groups.entries()].map(([group, value]) => Object.freeze({
      runId: current.runId, epoch: current.epoch, group,
      wakeId: hash([current.runId, current.epoch, group, value.causes]),
      causes: Object.freeze(value.causes), evidenceRefs: Object.freeze([...value.refs]),
    })));
  }

  /**
   * Persist the current coalesced wake before returning it to a host delivery
   * adapter.  The deterministic ID makes restart delivery idempotent, while
   * the owner append fences a controller transfer at the write itself.
   */
  recordWakes(owner: OrchestratorLease): readonly Wake[] {
    const wakes = this.pending(owner);
    for (const wake of wakes) {
      const payload = { runId: wake.runId, epoch: wake.epoch, group: wake.group, wakeId: wake.wakeId, causes: [...wake.causes], evidenceRefs: [...wake.evidenceRefs] };
      const event = {
        eventId: `wake:${wake.wakeId}`, schemaVersion: 1 as const, kind: 'supervisor.wake',
        source: 'helm.supervisor.wake', sourceEventId: wake.wakeId, correlationId: correlation(wake.runId),
        // Wake identity is derived solely from durable causes, so its event
        // bytes must remain stable across restart/re-delivery.
        occurredAt: this.wakeTimestamp(wake), recordedAt: this.wakeTimestamp(wake), sessionId: owner.sessionId, payload,
      };
      this.log.appendOwnedEvent(event, owner);
    }
    return wakes;
  }

  private wakeTimestamp(wake: Wake): string {
    const event = this.log.readEvents(correlation(wake.runId)).find((candidate) => candidate.eventId === wake.causes[0]);
    if (!event) throw new Error('wake cause is absent from the durable Log');
    return event.occurredAt;
  }

  /** Acknowledge handled causes, not merely attempted model delivery. Epoch is checked again. */
  acknowledge(wake: Wake, owner: OrchestratorLease): void {
    const current = this.log.assertCurrentOwner(owner);
    if (wake.runId !== current.runId || wake.epoch !== current.epoch) throw new Error('stale supervisor wake epoch');
    const pending = this.pending(current).find((candidate) => candidate.group === wake.group);
    if (!pending || !wake.causes.length || wake.causes.some((cause) => !pending.causes.includes(cause)) || wake.wakeId !== hash([wake.runId, wake.epoch, wake.group, wake.causes])) throw new Error('wake does not identify pending causes');
    const now = utcTimestampSchema.parse(this.now());
    const payload = ackSchema.parse({ runId: wake.runId, epoch: wake.epoch, causes: [...wake.causes] });
    this.log.appendOwnedEvent({ eventId: `ack:${wake.wakeId}`, schemaVersion: 1, kind: 'supervisor.ack',
      source: 'helm.supervisor.ack', sourceEventId: wake.wakeId, correlationId: correlation(wake.runId),
      occurredAt: now, recordedAt: now, sessionId: current.sessionId, payload }, current);
  }
}
const ackSchema = z.object({ runId: id, epoch: z.number().int().positive(), causes: z.array(id).min(1).max(10000) }).strict();

const recoverySchema = z.object({
  observedAt: utcTimestampSchema,
  worker: z.enum(['alive', 'dead', 'unknown']),
  failure: z.enum(['transient', 'permanent', 'unknown']),
  effects: z.enum(['confirmed-absent', 'present', 'unknown']),
  provider: z.enum(['available', 'quota-exhausted', 'rate-limited', 'unavailable', 'unknown']),
  stopped: z.boolean(), retryAllowed: z.boolean(),
  leaseIssuedAt: utcTimestampSchema, leaseExpiresAt: utcTimestampSchema, leaseRevoked: z.boolean(),
  attemptsUsed: z.number().int().nonnegative(), maxAttempts: z.number().int().positive(),
}).strict();
export type RecoveryFacts = z.infer<typeof recoverySchema>;
export type RecoveryDecision = Readonly<{ action: 'observe' | 'block' | 'wake' | 'retry'; reason: string }>;

/** A host-owned execution capability; observation adapters never receive it. */
export type SupervisorRetryExecutor = Readonly<{
  retry(input: Readonly<{
    intent: unknown;
    executor: TrustedExecutor;
    claimExpiresAt: string;
    signal: SupervisorSignal;
  }>): Promise<Readonly<{ decision: RecoveryDecision; status: 'performed' | 'terminal' | 'reconcile'; record?: CommandRecord; observation?: EffectObservation }>>;
}>;
export type SupervisorProcessInput = Readonly<{
  signal: SupervisorSignal;
  retry?: Readonly<{
    intent: unknown;
    executor: TrustedExecutor;
    claimExpiresAt: string;
  }>;
}>;
export type SupervisorProcessResult = Readonly<{
  decision?: RecoveryDecision;
  wakes: readonly Wake[];
  retry?: Readonly<{ status: 'performed' | 'terminal' | 'reconcile'; record?: CommandRecord; observation?: EffectObservation }>;
}>;

/**
 * Serial, event-driven mechanics. It has no timer, model callback, provider
 * client, or workflow graph: an integration host explicitly feeds trusted
 * observations and optionally supplies a prebuilt retry command.
 */
export class EventDrivenSupervisor {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly events: EventSupervisor,
    private readonly retryExecutor: SupervisorRetryExecutor,
    private readonly now: () => string,
  ) {}

  process(input: SupervisorProcessInput, owner?: OrchestratorLease): Promise<SupervisorProcessResult> {
    const signal = signalSchema.parse(input.signal);
    const frozen = Object.freeze({ signal, ...(input.retry ? { retry: freezeRetry(input.retry) } : {}) });
    const result = this.tail.then(() => this.processOne(frozen, owner));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async processOne(input: SupervisorProcessInput, owner?: OrchestratorLease): Promise<SupervisorProcessResult> {
    this.events.record(input.signal);
    let decision: RecoveryDecision | undefined;
    let retry: SupervisorProcessResult['retry'];
    if (input.retry) {
      const executed = await this.retryExecutor.retry({ ...input.retry, signal: input.signal });
      decision = executed.decision;
      retry = { status: executed.status, ...(executed.record ? { record: executed.record } : {}), ...(executed.observation ? { observation: executed.observation } : {}) };
    }
    // Expired or concurrently replaced controllers retain their unhandled
    // signal in the Log, but cannot receive a newly owned wake. A later active
    // controller will coalesce the same causes under its own epoch.
    let wakes: readonly Wake[] = [];
    if (owner && input.signal.needsJudgement) {
      try { wakes = this.events.recordWakes(owner); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!/ownership lease is inactive|orchestrator ownership lease is stale/.test(message)) throw error;
      }
    }
    return Object.freeze({ ...(decision ? { decision } : {}), wakes: Object.freeze(wakes), ...(retry ? { retry } : {}) });
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot caller-owned retry bytes before serial queueing. */
function freezeRetry(input: SupervisorProcessInput['retry']): NonNullable<SupervisorProcessInput['retry']> {
  if (!input) throw new Error('retry is required');
  const copied = structuredClone({ intent: input.intent, executor: { executorId: input.executor.executorId }, claimExpiresAt: input.claimExpiresAt });
  return deepFreeze(copied);
}

/** Pure mechanical classification; a retry is only a proposal for a fresh kernel admission. */
export function planRecovery(input: RecoveryFacts, nowInput: string): RecoveryDecision {
  const f = recoverySchema.parse(input); const now = Date.parse(utcTimestampSchema.parse(nowInput));
  const age = now - Date.parse(f.observedAt);
  if (age < 0 || age > 30000) return { action: 'wake', reason: 'fresh observations required' };
  if (f.worker === 'alive') return { action: 'observe', reason: 'worker remains alive' };
  if (f.worker === 'unknown' || f.effects !== 'confirmed-absent' || !f.stopped) return { action: 'wake', reason: 'ambiguous worker or effect; no replay' };
  if (f.provider !== 'available') return { action: 'block', reason: `provider ${f.provider}; fresh availability required` };
  if (f.leaseRevoked || now < Date.parse(f.leaseIssuedAt) || now >= Date.parse(f.leaseExpiresAt) || !f.retryAllowed) return { action: 'block', reason: 'retry authority inactive' };
  if (f.failure !== 'transient' || f.attemptsUsed >= f.maxAttempts) return { action: 'wake', reason: 'retry requires judgement or attempt budget exhausted' };
  return { action: 'retry', reason: 'confirmed absent effects and stopped transient failure within authority' };
}
