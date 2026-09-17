import { createHash } from 'node:crypto';
import {
  matchesReviewPublication,
  prepareReviewPublication,
  type PreparedReviewPublication,
  type PublicationTarget,
} from './review-publication-format.js';
import type { DurableReviewRecord } from './review.js';

export type { PreparedReviewPublication, PublicationTarget } from './review-publication-format.js';

export type PublicationReceipt = Readonly<{
  commentId: string;
  url: string;
  body: string;
  author: string;
  observedHead: string;
}>;

export type PublicationState = 'planned' | 'published' | 'unknown' | 'denied';

export type PublicationRecord = Readonly<{
  schemaVersion: 1;
  key: string;
  runId: string;
  state: PublicationState;
  prepared: PreparedReviewPublication;
  receipt?: PublicationReceipt;
  reason?: string;
}>;

export interface PublicationStore {
  reopen(key: string): Promise<PublicationRecord | undefined>;
  prepare(record: PublicationRecord): Promise<Readonly<{ record: PublicationRecord; created: boolean }>>;
  append(record: PublicationRecord): Promise<void>;
}

/**
 * Trusted host bindings. These are never model tools and never accept
 * user-request supplied implementations. `post` must be implemented by later
 * integration as exactly one authorized Core effect; this module never spawns
 * `gh` itself. `readVerifiedVerdict` must enforce executable verification
 * evidence in the later adapter.
 */
export type PublicationBinding = Readonly<{
  store: PublicationStore;
  loadReview(reviewId: string): Promise<DurableReviewRecord>;
  readVerifiedVerdict(review: DurableReviewRecord): Promise<string>;
  authorize(review: DurableReviewRecord, target: PublicationTarget): Promise<void>;
  inspectHead(target: PublicationTarget): Promise<string>;
  expectedPublisher(): Promise<string>;
  post(prepared: PreparedReviewPublication): Promise<void>;
  readback(prepared: PreparedReviewPublication): Promise<PublicationReceipt | undefined>;
}>;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Publication identity. It intentionally excludes the verdict: two different
 * bodies claiming the same review/source/target identity MUST refuse rather
 * than post a second time.
 */
export function publicationIdentity(
  review: DurableReviewRecord,
  prepared: PreparedReviewPublication,
): Readonly<{ key: string; runId: string }> {
  const runId = review.source.runId;
  const key = `sha256:${sha256Hex(JSON.stringify([
    runId,
    prepared.reviewId,
    prepared.target.repository,
    prepared.target.pullRequest,
    prepared.target.head,
  ]))}`;
  return Object.freeze({ key, runId });
}

export function samePrepared(left: PreparedReviewPublication, right: PreparedReviewPublication): boolean {
  return left.reviewId === right.reviewId
    && left.resultRef === right.resultRef
    && left.body === right.body
    && left.bodyDigest === right.bodyDigest
    && left.marker === right.marker
    && left.target.repository === right.target.repository
    && left.target.pullRequest === right.target.pullRequest
    && left.target.head === right.target.head;
}

/** Durable publication identity: same schema/key/runId and same immutable body. */
export function sameIntent(left: PublicationRecord, right: PublicationRecord): boolean {
  return left.schemaVersion === right.schemaVersion && left.key === right.key && left.runId === right.runId
    && samePrepared(left.prepared, right.prepared);
}

export function canFollowPublication(previous: PublicationRecord, next: PublicationRecord): boolean {
  if (!samePrepared(previous.prepared, next.prepared)) return false;
  if (previous.state === 'planned') return next.state === 'published' || next.state === 'unknown' || next.state === 'denied';
  if (previous.state === 'unknown') return next.state === 'published';
  return false;
}

export function cloneRecord(record: PublicationRecord): PublicationRecord {
  return Object.freeze({
    schemaVersion: 1 as const,
    key: record.key,
    runId: record.runId,
    state: record.state,
    prepared: Object.freeze({
      ...record.prepared,
      target: Object.freeze({ ...record.prepared.target }),
    }),
    ...(record.receipt ? { receipt: Object.freeze({ ...record.receipt }) } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  });
}

/** A memory PublicationStore with the same atomic create-if-absent semantics. */
export class MemoryPublicationStore implements PublicationStore {
  private readonly intents = new Map<string, PublicationRecord>();
  private readonly latest = new Map<string, PublicationRecord>();

  async reopen(key: string): Promise<PublicationRecord | undefined> {
    const current = this.latest.get(key);
    return current ? cloneRecord(current) : undefined;
  }

  async prepare(record: PublicationRecord): Promise<Readonly<{ record: PublicationRecord; created: boolean }>> {
    if (record.state !== 'planned') throw new Error('publication intent must be planned');
    const existing = this.intents.get(record.key);
    if (existing) {
      if (!sameIntent(existing, record)) throw new Error('publication intent conflicts with durable intent');
      return Object.freeze({ record: cloneRecord(this.latest.get(record.key)!), created: false });
    }
    const frozen = cloneRecord(record);
    this.intents.set(record.key, frozen);
    this.latest.set(record.key, frozen);
    return Object.freeze({ record: cloneRecord(frozen), created: true });
  }

  async append(record: PublicationRecord): Promise<void> {
    const prior = this.latest.get(record.key);
    if (!prior) throw new Error('publication append requires a durable intent');
    if (!samePrepared(prior.prepared, record.prepared) || prior.runId !== record.runId) {
      throw new Error('publication append conflicts with durable intent');
    }
    if (canFollowPublication(prior, record)) {
      this.latest.set(record.key, cloneRecord(record));
      return;
    }
    // Repeated reconciliation that agrees with the current state is a no-op;
    // every other case is an illegal transition.
    if (prior.state === record.state && prior.reason === record.reason
      && JSON.stringify(prior.receipt ?? null) === JSON.stringify(record.receipt ?? null)) return;
    throw new Error('publication state transition is not append-safe');
  }
}

/**
 * Staging implementation of the coordinator publication algorithm. It performs
 * at most one authorized effect per durable intent, never blindly retries, and
 * only reports success through the published state established by readback.
 */
export class ReviewPublicationService {
  private readonly reconciling = new Map<string, Promise<PublicationRecord>>();

  constructor(private readonly binding: PublicationBinding) {}

  async publish(reviewId: string, target: PublicationTarget): Promise<PublicationRecord> {
    const review = await this.binding.loadReview(reviewId);
    if (!review || review.reviewId !== reviewId) throw new Error('durable review identity does not match request');
    const verdict = await this.binding.readVerifiedVerdict(review);
    // Format first: a nonterminal review or an invalid body never creates intent.
    const prepared = prepareReviewPublication(review, target, verdict);
    const { key, runId } = publicationIdentity(review, prepared);
    const planned: PublicationRecord = Object.freeze({ schemaVersion: 1, key, runId, state: 'planned' as const, prepared });

    const claim = await this.binding.store.prepare(planned);
    if (!claim.created) {
      const durable = claim.record;
      if (durable.key !== key || durable.runId !== runId || !samePrepared(durable.prepared, prepared)) {
        throw new Error('durable publication intent contradicts this request');
      }
      return this.reconcile(key);
    }

    // Pre-effect failures are durable denials and never reach post.
    try {
      await this.binding.authorize(review, prepared.target);
      const head = await this.binding.inspectHead(prepared.target);
      if (head !== prepared.target.head) throw new Error('verified PR head no longer matches the prepared target');
      const publisher = await this.binding.expectedPublisher();
      if (!publisher.trim()) throw new Error('expected publisher identity is unavailable');
    } catch (error) {
      const denied: PublicationRecord = Object.freeze({ schemaVersion: 1, key, runId, state: 'denied' as const, prepared, reason: 'publication preflight refused' });
      try {
        await this.binding.store.append(denied);
      } catch {
        /* A planned intent stays recoverable; persistence failure is never proof of post failure. */
      }
      return denied;
    }

    try {
      await this.binding.post(prepared);
    } catch (error) {
      void error;
      const unknown: PublicationRecord = Object.freeze({ schemaVersion: 1, key, runId, state: 'unknown' as const, prepared, reason: 'post outcome unknown' });
      try {
        await this.binding.store.append(unknown);
      } catch {
        /* Keep the planned intent recoverable; reconcile reads durable truth. */
      }
      return this.reconcile(key);
    }
    return this.reconcile(key);
  }

  async reconcile(key: string): Promise<PublicationRecord> {
    const active = this.reconciling.get(key);
    if (active) return active;
    const run = this.reconcileExclusive(key).finally(() => this.reconciling.delete(key));
    this.reconciling.set(key, run);
    return run;
  }

  private async reconcileExclusive(key: string): Promise<PublicationRecord> {
    const current = await this.binding.store.reopen(key);
    if (!current) throw new Error('publication cannot be reconciled from this durable identity');
    if (current.state === 'published' || current.state === 'denied') return current;

    const prepared = current.prepared;
    let observed: PublicationReceipt | undefined;
    let freshHead = '';
    let publisher = '';
    let failure: unknown;
    try {
      observed = await this.binding.readback(prepared);
      freshHead = await this.binding.inspectHead(prepared.target);
      publisher = await this.binding.expectedPublisher();
    } catch (error) {
      failure = error;
    }

    const matched = !failure && !!observed
      && matchesReviewPublication(prepared, observed.body)
      && !!observed.commentId.trim() && !!observed.url.trim()
      && !!publisher.trim() && observed.author === publisher
      && observed.observedHead === prepared.target.head
      && freshHead === prepared.target.head;

    if (matched) {
      const published: PublicationRecord = Object.freeze({
        schemaVersion: 1 as const, key: current.key, runId: current.runId, state: 'published' as const,
        prepared, receipt: Object.freeze({ ...observed! }),
      });
      try {
        await this.binding.store.append(published);
      } catch {
        /* Durable published state may already exist; the read below is authoritative. */
      }
      const durable = await this.binding.store.reopen(key);
      if (!durable) throw new Error('publication result is not durable');
      return durable;
    }

    const unknown: PublicationRecord = Object.freeze({
      schemaVersion: 1 as const, key: current.key, runId: current.runId, state: 'unknown' as const, prepared,
      reason: failure ? 'publication readback unavailable' : 'publication readback could not be verified',
    });
    if (current.state === 'planned') {
      try {
        await this.binding.store.append(unknown);
      } catch {
        /* Never treat a store failure as proof the external post failed or succeeded. */
      }
    }
    // An existing unknown state is never rewritten, and reconcile never posts.
    return cloneRecord(unknown);
  }
}
