import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactJournal, ArtifactMetadata } from '../journal/index.js';
import {
  canFollowPublication,
  sameIntent,
  samePrepared,
  type PublicationRecord,
  type PublicationStore,
} from './review-publication.js';
import type { PreparedReviewPublication } from './review-publication-format.js';

const prefix = 'host.review.publication';
const id = (runId: string, key: string, suffix: string): string => `${prefix}:${runId}:${key}:${suffix}`;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const digestOf = (body: string): string => `sha256:${createHash('sha256').update(body).digest('hex')}`;

const RAW_SHA256_64 = /^raw:sha256:[0-9a-f]{64}$/;
const SHA256_64 = /^sha256:[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const KEY = /^sha256:[0-9a-f]{64}$/;

function validPrepared(prepared: PreparedReviewPublication): void {
  if (!prepared || typeof prepared !== 'object') throw new Error('publication prepared is missing');
  if (!nonempty(prepared.reviewId) || !nonempty(prepared.resultRef) || !nonempty(prepared.marker)) {
    throw new Error('publication prepared identity is incomplete');
  }
  if (!RAW_SHA256_64.test(prepared.resultRef)) throw new Error('publication resultRef is invalid');
  if (!SHA256_64.test(prepared.bodyDigest)) throw new Error('publication bodyDigest is invalid');
  if (!nonempty(prepared.body)) throw new Error('publication body is empty');
  if (digestOf(prepared.body) !== prepared.bodyDigest) throw new Error('publication body does not match bodyDigest');
  const target = prepared.target;
  if (!target || typeof target !== 'object') throw new Error('publication target is missing');
  if (!nonempty(target.repository)) throw new Error('publication repository is empty');
  if (!Number.isSafeInteger(target.pullRequest) || target.pullRequest <= 0) throw new Error('publication pullRequest is invalid');
  if (!HEX40.test(target.head)) throw new Error('publication head is invalid');
}

function valid(record: PublicationRecord): void {
  if (record.schemaVersion !== 1) throw new Error('publication schemaVersion must be 1');
  if (!KEY.test(record.key)) throw new Error('publication key is invalid');
  if (!nonempty(record.runId)) throw new Error('publication runId is empty');
  if (!['planned', 'published', 'unknown', 'denied'].includes(record.state)) throw new Error('publication state is invalid');
  validPrepared(record.prepared);
  if (record.state === 'planned' && (record.receipt || record.reason)) {
    throw new Error('planned publication carries only immutable intent');
  }
  if (record.state === 'denied' && (record.receipt || !nonempty(record.reason))) {
    throw new Error('denied publication requires a bounded reason and no receipt');
  }
  if (record.state === 'published') {
    const receipt = record.receipt;
    if (!receipt || !nonempty(receipt.commentId) || !nonempty(receipt.url) || !nonempty(receipt.author) || !HEX40.test(receipt.observedHead)) {
      throw new Error('published publication requires a complete receipt');
    }
    if (receipt.body !== record.prepared.body || digestOf(receipt.body) !== record.prepared.bodyDigest) {
      throw new Error('published receipt body is not the exact prepared publication');
    }
    if (receipt.observedHead !== record.prepared.target.head) {
      throw new Error('published receipt head does not match the prepared target');
    }
  }
  if (record.state === 'unknown' && !nonempty(record.reason)) {
    throw new Error('unknown publication requires a reason');
  }
}

function parse(bytes: Buffer, runId: string, key: string): PublicationRecord {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('publication bytes are malformed'); }
  if (typeof value !== 'object' || value === null) throw new Error('publication bytes are malformed');
  const record = value as PublicationRecord;
  valid(record);
  if (record.runId !== runId || record.key !== key) throw new Error('publication record is outside its run or key scope');
  return record;
}

type IntentClaim = Readonly<{ schemaVersion: 1; claimToken: string; record: PublicationRecord }>;
function parseIntent(bytes: Buffer, runId: string, key: string): PublicationRecord {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('publication intent bytes are malformed'); }
  if (typeof value !== 'object' || value === null) throw new Error('publication intent bytes are malformed');
  const claim = value as IntentClaim;
  if (claim.schemaVersion !== 1 || !nonempty(claim.claimToken) || !claim.record) throw new Error('publication intent claim is malformed');
  return parse(Buffer.from(JSON.stringify(claim.record)), runId, key);
}

function immutable(record: PublicationRecord): PublicationRecord {
  return Object.freeze({
    schemaVersion: 1 as const,
    key: record.key,
    runId: record.runId,
    state: record.state,
    prepared: Object.freeze({ ...record.prepared, target: Object.freeze({ ...record.prepared.target }) }),
    ...(record.receipt ? { receipt: Object.freeze({ ...record.receipt }) } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  });
}

/**
 * Append-only publication provenance built directly on ArtifactJournal
 * immutable source identities, mirroring the review durability store. The
 * journal collision check is the concurrent create/version fence; a race
 * never replaces an intent or a prior version. This store validates durable
 * shape only; it never proves host authority or that an external post
 * actually happened — that is the service binding's responsibility.
 */
export class JournalReviewPublicationStore implements PublicationStore {
  constructor(private readonly journal: ArtifactJournal, private readonly runId: string) {
    if (!runId.trim()) throw new Error('publication store requires a run id');
  }

  private async records(key: string): Promise<Array<{ version: number; metadata: ArtifactMetadata; record: PublicationRecord }>> {
    const escaped = `${prefix}:${this.runId}:${key}:`;
    const metadata = (await this.journal.metadata()).filter(entry => entry.sourceIdentity.startsWith(escaped));
    const values = await Promise.all(metadata.map(async entry => {
      const suffix = entry.sourceIdentity.slice(escaped.length);
      const version = suffix === 'intent' ? 0 : Number(suffix.slice(1));
      if (!Number.isSafeInteger(version) || version < 0) throw new Error('publication version identity is invalid');
      const bytes = await this.journal.read(entry.raw, entry.sourceIdentity, { permitSensitive: true });
      return { version, metadata: entry, record: suffix === 'intent' ? parseIntent(bytes, this.runId, key) : parse(bytes, this.runId, key) };
    }));
    return values.sort((a, b) => a.version - b.version);
  }

  async reopen(key: string): Promise<PublicationRecord | undefined> {
    const values = await this.records(key);
    if (!values.length) return undefined;
    if (values[0]!.version !== 0 || values[0]!.metadata.sourceIdentity !== id(this.runId, key, 'intent')) {
      throw new Error('publication has no immutable intent');
    }
    for (let index = 1; index < values.length; index++) {
      if (values[index]!.version !== index) throw new Error('publication history is discontinuous');
      if (!samePrepared(values[0]!.record.prepared, values[index]!.record.prepared)) {
        throw new Error('publication version contradicts the immutable intent');
      }
      if (!canFollowPublication(values[index - 1]!.record, values[index]!.record)) {
        throw new Error('publication history has an illegal transition');
      }
    }
    return immutable(values.at(-1)!.record);
  }

  async prepare(record: PublicationRecord): Promise<Readonly<{ record: PublicationRecord; created: boolean }>> {
    valid(record);
    if (record.runId !== this.runId || record.state !== 'planned') {
      throw new Error('publication intent must be planned and bound to this run');
    }
    const identity = id(this.runId, record.key, 'intent');
    const existing = await this.reopen(record.key);
    if (existing) {
      if (!sameIntent(existing, record)) throw new Error('publication intent conflicts with the durable intent');
      return Object.freeze({ record: immutable(existing), created: false });
    }
    // A random durable claimant token makes create-if-absent observable so
    // exactly one concurrent caller wins the immutable identity.
    const claim: IntentClaim = { schemaVersion: 1, claimToken: randomUUID(), record };
    try {
      await this.journal.append(
        { source: prefix, sourceIdentity: identity, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(claim)), classification: 'sensitive' },
        { permitSensitive: true },
      );
      return Object.freeze({ record: immutable(record), created: true });
    } catch (error) {
      const winner = await this.reopen(record.key);
      if (!winner || !sameIntent(winner, record)) throw error;
      return Object.freeze({ record: immutable(winner), created: false });
    }
  }

  async append(record: PublicationRecord): Promise<void> {
    valid(record);
    if (record.runId !== this.runId) throw new Error('publication record is outside this run');
    const prior = await this.reopen(record.key);
    if (!prior) throw new Error('publication append requires a durable intent');
    if (!canFollowPublication(prior, record)) throw new Error('publication state transition is not append-safe');
    const version = (await this.records(record.key)).length;
    await this.journal.append(
      { source: prefix, sourceIdentity: id(this.runId, record.key, `v${version}`), mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(record)), classification: 'sensitive' },
      { permitSensitive: true },
    );
  }
}
