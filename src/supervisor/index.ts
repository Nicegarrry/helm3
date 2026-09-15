import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import { type OrchestratorLease, utcTimestampSchema } from '../contracts/index.js';
import type { KernelHost } from '../core/index.js';

const id = z.string().min(1).max(512);
const signalSchema = z.object({
  runId: id, source: id, sourceEventId: id, group: id,
  observedAt: utcTimestampSchema,
  kind: z.enum(['worker.failed', 'provider.blocked', 'gate.finished', 'reconciliation.ambiguous', 'worker.completed']),
  evidenceRefs: z.array(id).max(100),
  needsJudgement: z.boolean(),
}).strict();
export type SupervisorSignal = z.infer<typeof signalSchema>;
export type Wake = Readonly<{ runId: string; epoch: number; group: string; wakeId: string; causes: readonly string[]; evidenceRefs: readonly string[] }>;
type Log = Pick<KernelHost, 'appendEvent' | 'appendOwnedEvent' | 'readEvents' | 'assertCurrentOwner'>;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const correlation = (runId: string): string => `supervisor:${runId}`;

/** Durable signals and coalesced judgement queue; this does not itself invoke a model. */
export class EventSupervisor {
  constructor(private readonly log: Log, private readonly now: () => string) {}

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
