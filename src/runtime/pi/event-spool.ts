import { randomUUID } from 'node:crypto';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { RawArtifactRef } from '../../contracts/index.js';
import type { ArtifactJournal } from '../../journal/index.js';

export const PI_EVENT_BATCH_SCHEMA_VERSION = 1;
export const PI_EVENT_MAX_BYTES = 1024 * 1024;
export type PiEventBatch = Readonly<{ schemaVersion: 1; commandId: string; attemptId: string; sessionId: string; firstSequence: number; events: readonly Readonly<{ sequence: number; event: unknown }>[] }>;
export type PiEventSpoolLimits = Readonly<{ maxBytes: number; maxEvents: number; maxQueuedBatches: number }>;

/** Pi's public JSON mode removes the cumulative assistant snapshot from updates. Keep a local copy: that module is not exported by the pinned package. */
export function serializePiEvent(event: AgentSessionEvent): unknown {
  if (event.type !== 'message_update') return event;
  if (event.message.role !== 'assistant') throw new Error('Pi message update did not contain an assistant message');
  const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown>;
  const { partial: _partial, ...delta } = assistantMessageEvent;
  if (event.assistantMessageEvent.type === 'toolcall_start') {
    const tool = event.message.content[event.assistantMessageEvent.contentIndex];
    if (!tool || tool.type !== 'toolCall') throw new Error('Pi tool call update did not point at a tool call');
    return { type: 'message_update', usage: event.message.usage, assistantMessageEvent: { ...delta, id: tool.id, toolName: tool.name } };
  }
  return { type: 'message_update', usage: event.message.usage, assistantMessageEvent: delta };
}

function valid(limits: PiEventSpoolLimits): PiEventSpoolLimits {
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  if (limits.maxQueuedBatches < 2) throw new Error('maxQueuedBatches must reserve space for an unknown-tail marker');
  return Object.freeze({ ...limits });
}
function boundary(event: AgentSessionEvent): boolean { return event.type === 'message_end' || event.type === 'tool_execution_end' || event.type === 'turn_end' || event.type === 'agent_end'; }

/**
 * Batches all observed Pi events in sequence. Pi subscriber callbacks cannot apply
 * backpressure, so the bounded queue fails closed and records an explicit unknown
 * tail rather than silently discarding events.
 */
export class PiEventSpool {
  private readonly limits: PiEventSpoolLimits;
  private sequence = 0;
  private batch: Array<{ sequence: number; event: unknown }> = [];
  private batchBytes = 0;
  private queued = 0;
  private tail = Promise.resolve();
  private failure: unknown;
  private overflow?: Readonly<{ firstUnpersistedSequence: number; reason: string }>;
  private readonly refs: RawArtifactRef[] = [];
  private readonly streamId = randomUUID();
  constructor(private readonly journal: Pick<ArtifactJournal, 'append'>, private readonly lineage: Readonly<{ commandId: string; attemptId: string; sessionId: string }>, limits: PiEventSpoolLimits = { maxBytes: 64 * 1024, maxEvents: 64, maxQueuedBatches: 1024 }) { this.limits = valid(limits); }
  get state(): Readonly<{ queuedBatches: number; bufferedBytes: number; nextSequence: number; overflow?: Readonly<{ firstUnpersistedSequence: number; reason: string }> }> { return { queuedBatches: this.queued, bufferedBytes: this.batchBytes, nextSequence: this.sequence + 1, ...(this.overflow ? { overflow: this.overflow } : {}) }; }
  record(event: AgentSessionEvent): void {
    const sequence = ++this.sequence;
    if (this.overflow) return;
    if (this.queued >= this.limits.maxQueuedBatches - 1) return this.failClosed(sequence, 'Pi event spool queue reached its durable batch limit');
    const observed = JSON.stringify(serializePiEvent(event));
    const entry = { sequence, event: JSON.parse(observed) as unknown };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (bytes > PI_EVENT_MAX_BYTES) return this.failClosed(sequence, 'Pi event exceeds the durable single-event byte limit');
    if ((this.batch.length > 0 && (this.batch.length >= this.limits.maxEvents || this.batchBytes + bytes > this.limits.maxBytes)) || boundary(event)) this.flush();
    if (this.queued >= this.limits.maxQueuedBatches && this.batch.length === 0) return this.failClosed(sequence, 'Pi event spool queue reached its durable batch limit');
    this.batch.push(entry); this.batchBytes += bytes;
    if (boundary(event) || this.batch.length >= this.limits.maxEvents || this.batchBytes >= this.limits.maxBytes) this.flush();
  }
  private failClosed(sequence: number, reason: string): void {
    this.flushPrefix();
    this.overflow = Object.freeze({ firstUnpersistedSequence: sequence, reason });
    this.failure = new Error(reason);
    const marker = Buffer.from(JSON.stringify({ schemaVersion: 1, ...this.lineage, state: 'unknown', firstUnpersistedSequence: sequence, reason }));
    this.enqueue('pi.event.overflow', `pi-event-overflow:${this.lineage.sessionId}:${this.streamId}:${sequence}`, marker);
  }
  private flush(): void {
    if (!this.batch.length || this.overflow) return;
    if (this.queued >= this.limits.maxQueuedBatches - 1) return this.failClosed(this.batch[0].sequence, 'Pi event spool queue reached its durable batch limit');
    this.flushPrefix();
  }
  private flushPrefix(): void {
    if (!this.batch.length) return;
    const events = this.batch; this.batch = []; this.batchBytes = 0;
    const payload: PiEventBatch = { schemaVersion: PI_EVENT_BATCH_SCHEMA_VERSION, ...this.lineage, firstSequence: events[0].sequence, events };
    this.enqueue('pi.event', `pi-event-batch:${this.lineage.sessionId}:${this.streamId}:${payload.firstSequence}-${events.at(-1)!.sequence}`, Buffer.from(JSON.stringify(payload)));
  }
  private enqueue(source: 'pi.event' | 'pi.event.overflow', sourceIdentity: string, bytes: Buffer): void {
    this.queued += 1;
    this.tail = this.tail.then(async () => { this.refs.push(await this.journal.append({ source, sourceIdentity, mediaType: 'application/json', bytes })); }).catch((error: unknown) => { this.failure ??= error; }).finally(() => { this.queued -= 1; });
  }
  async drain(): Promise<readonly RawArtifactRef[]> {
    this.flush(); await this.tail;
    const refs = this.refs.splice(0);
    if (this.failure) throw this.failure;
    return refs;
  }
}
