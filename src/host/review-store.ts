import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactJournal, ArtifactMetadata } from '../journal/index.js';
import type { DurableReviewRecord, ReviewDurabilityStore } from './review.js';

const prefix = 'host.review.durability';
const hash = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const id = (runId: string, key: string, suffix: string): string => `${prefix}:${runId}:${key}:${suffix}`;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function valid(record: DurableReviewRecord): void {
  if (record.schemaVersion !== 1 || !record.reviewId.startsWith('review-') || !record.idempotencyKey.startsWith('sha256:')
    || !record.source.runId || !record.requestedHead.match(/^[0-9a-f]{40}$/) || record.source.head !== record.requestedHead
    || !record.manifest.digest.startsWith('sha256:') || record.manifest.entries.length < 2
    || !record.manifest.entries.every(entry => entry.ref.length > 0 && entry.hash.startsWith('sha256:') && ['objective', 'acceptance', 'factual-context'].includes(entry.purpose))
    || !record.reviewer.requestedModelId) throw new Error('invalid durable review record');
  const reviewerLaunched = nonempty(record.reviewer.workerId) && nonempty(record.reviewer.attemptId) && nonempty(record.reviewer.sessionId);
  const terminalEvidence = nonempty(record.outcome?.resultRef) && record.outcome.rawEventRefs.length > 0
    && record.outcome.rawEventRefs.every(nonempty)
    && nonempty(record.outcome.readonlyObservation.beforeRef) && nonempty(record.outcome.readonlyObservation.afterRef);
  if (record.state === 'planned' && (record.outcome || record.failure || reviewerLaunched)) throw new Error('planned review must contain only immutable intent');
  if (record.state === 'launched' && (!reviewerLaunched || record.outcome || record.failure)) throw new Error('launched review requires native provenance and no outcome');
  if (record.state === 'terminal' && (!reviewerLaunched || !terminalEvidence || record.failure)) throw new Error('terminal review requires native result, raw events, and readonly observation evidence');
  if (record.state === 'unknown' && (!record.failure || record.outcome || !['spawn-unknown', 'persistence-unknown', 'postspawn-failure', 'preflight-refused'].includes(record.failure.reason))) throw new Error('unknown review requires durable failure provenance');
}

function sameIntent(left: DurableReviewRecord, right: DurableReviewRecord): boolean {
  return left.reviewId === right.reviewId && left.idempotencyKey === right.idempotencyKey
    && JSON.stringify(left.source) === JSON.stringify(right.source) && left.requestedHead === right.requestedHead
    && JSON.stringify(left.manifest) === JSON.stringify(right.manifest) && left.reviewer.requestedModelId === right.reviewer.requestedModelId;
}
function canFollow(previous: DurableReviewRecord, next: DurableReviewRecord): boolean {
  if (!sameIntent(previous, next)) return false;
  return (previous.state === 'planned' && (next.state === 'launched' || next.state === 'unknown'))
    || (previous.state === 'launched' && (next.state === 'terminal' || next.state === 'unknown'));
}
function parse(bytes: Buffer, runId: string, key: string): DurableReviewRecord {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('durable review bytes are malformed'); }
  if (typeof value !== 'object' || value === null) throw new Error('durable review bytes are malformed');
  const record = value as DurableReviewRecord; valid(record);
  if (record.source.runId !== runId || record.idempotencyKey !== key) throw new Error('durable review record is outside its run or idempotency scope');
  return record;
}

type IntentClaim = Readonly<{ schemaVersion: 1; claimToken: string; record: DurableReviewRecord }>;
function parseIntent(bytes: Buffer, runId: string, key: string): DurableReviewRecord {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('durable review intent bytes are malformed'); }
  if (typeof value !== 'object' || value === null) throw new Error('durable review intent bytes are malformed');
  const claim = value as IntentClaim;
  if (claim.schemaVersion !== 1 || typeof claim.claimToken !== 'string' || !claim.claimToken || !claim.record) throw new Error('durable review intent claim is malformed');
  return parse(Buffer.from(JSON.stringify(claim.record)), runId, key);
}

/**
 * Append-only review provenance built directly on ArtifactJournal immutable
 * source identities. The journal's collision check is the concurrent
 * create/version fence; a race never replaces an intent or a prior version.
 */
export class JournalReviewDurabilityStore implements ReviewDurabilityStore {
  constructor(private readonly journal: ArtifactJournal, private readonly runId: string) {
    if (!runId.trim()) throw new Error('review durability store requires a run id');
  }

  private async records(key: string): Promise<Array<{ version: number; metadata: ArtifactMetadata; record: DurableReviewRecord }>> {
    const escaped = `${prefix}:${this.runId}:${key}:`;
    const metadata = (await this.journal.metadata()).filter(entry => entry.sourceIdentity.startsWith(escaped));
    const values = await Promise.all(metadata.map(async entry => {
      const suffix = entry.sourceIdentity.slice(escaped.length);
      const version = suffix === 'intent' ? 0 : Number(suffix.slice(1));
      if (!Number.isSafeInteger(version) || version < 0) throw new Error('durable review version identity is invalid');
      const bytes = await this.journal.read(entry.raw, entry.sourceIdentity, { permitSensitive: true });
      return { version, metadata: entry, record: suffix === 'intent' ? parseIntent(bytes, this.runId, key) : parse(bytes, this.runId, key) };
    }));
    return values.sort((a, b) => a.version - b.version);
  }

  async reopen(key: string): Promise<DurableReviewRecord | undefined> {
    const values = await this.records(key);
    if (!values.length) return undefined;
    if (values[0]!.version !== 0 || values[0]!.metadata.sourceIdentity !== id(this.runId, key, 'intent')) throw new Error('durable review has no immutable intent');
    for (let index = 1; index < values.length; index++) {
      if (values[index]!.version !== index || !canFollow(values[index - 1]!.record, values[index]!.record)) throw new Error('durable review history is discontinuous or invalid');
    }
    return values.at(-1)!.record;
  }

  async prepare(record: DurableReviewRecord): Promise<Readonly<{ record: DurableReviewRecord; created: boolean }>> {
    valid(record);
    if (record.source.runId !== this.runId || record.state !== 'planned') throw new Error('review intent must be planned and bound to this run');
    const identity = id(this.runId, record.idempotencyKey, 'intent');
    const existing = await this.reopen(record.idempotencyKey);
    if (existing) {
      if (!sameIntent(existing, record)) throw new Error('review intent claim conflicts with existing intent');
      return Object.freeze({ record: existing, created: false });
    }
    // ArtifactJournal intentionally treats identical immutable appends as
    // idempotent. A random durable claimant token makes this create-if-absent
    // observable: exactly one concurrent caller wins the immutable identity.
    const claim: IntentClaim = { schemaVersion: 1, claimToken: randomUUID(), record };
    try {
      await this.journal.append({ source: prefix, sourceIdentity: identity, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(claim)), classification: 'sensitive' }, { permitSensitive: true });
      return Object.freeze({ record, created: true });
    } catch (error) {
      const winner = await this.reopen(record.idempotencyKey);
      if (!winner || !sameIntent(winner, record)) throw error;
      return Object.freeze({ record: winner, created: false });
    }
  }

  async append(record: DurableReviewRecord): Promise<void> {
    valid(record);
    if (record.source.runId !== this.runId) throw new Error('review record is outside this run');
    const prior = await this.reopen(record.idempotencyKey);
    if (!prior) throw new Error('review append requires a durable intent');
    if (!canFollow(prior, record)) throw new Error('review state transition is not append-safe');
    const version = (await this.records(record.idempotencyKey)).length;
    await this.journal.append({ source: prefix, sourceIdentity: id(this.runId, record.idempotencyKey, `v${version}`), mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(record)), classification: 'sensitive' }, { permitSensitive: true });
  }
}

/** A stable content digest for callers that need an immutable manifest binding. */
export function reviewRecordDigest(record: DurableReviewRecord): string { valid(record); return hash(record); }
