import { createHash } from 'node:crypto';
import type { DurableReviewRecord } from './review.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PublicationTarget = Readonly<{
  repository: string;
  pullRequest: number;
  head: string;
}>;

export type PreparedReviewPublication = Readonly<{
  reviewId: string;
  target: PublicationTarget;
  resultRef: string;
  body: string;
  bodyDigest: string;
  marker: string;
}>;

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/;
const RAW_SHA256_64 = /^raw:sha256:[0-9a-f]{64}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireNonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
}

function validRepository(repo: string): boolean {
  if (!REPO_PATTERN.test(repo)) return false;
  const [owner, name] = repo.split('/');
  if (owner === '.' || owner === '..') return false;
  if (name === '.' || name === '..') return false;
  return true;
}

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// ---------------------------------------------------------------------------
// Core: prepareReviewPublication
// ---------------------------------------------------------------------------

/**
 * Prepares a deterministic, canonical publication body for an independent
 * review verdict.
 *
 * IMPORTANT LIMITATION: The structural checks performed here are validations
 * of a trusted host record's shape.  They do NOT constitute proof of
 * executable verification, permission, current PR head, or an independent
 * review policy decision.  The host publication service is responsible for
 * performing fresh reads, authority checks, gate evidence collection,
 * durable command issuance, and readback verification before and after
 * actual publication.  This module is a pure formatting/validation layer
 * with no I/O side effects.
 */
export function prepareReviewPublication(
  review: DurableReviewRecord,
  target: PublicationTarget,
  verdict: string,
): PreparedReviewPublication {
  // --- State ---
  if (review.state !== 'terminal') {
    throw new Error('review.state must be terminal');
  }

  // --- Identifiers ---
  requireNonempty(review.reviewId, 'reviewId');
  requireNonempty(review.manifest.digest, 'manifest.digest');

  // --- Outcome / resultRef ---
  if (!review.outcome) {
    throw new Error('review.outcome must be present for terminal review');
  }
  requireNonempty(review.outcome.resultRef, 'outcome.resultRef');
  if (!RAW_SHA256_64.test(review.outcome.resultRef)) {
    throw new Error('outcome.resultRef must match raw:sha256:<64-lowercase-hex>');
  }

  // --- Readonly observation ---
  requireNonempty(review.outcome.readonlyObservation.beforeRef, 'beforeRef');
  requireNonempty(review.outcome.readonlyObservation.afterRef, 'afterRef');

  // --- Reviewer provenance ---
  requireNonempty(review.reviewer.workerId ?? '', 'reviewer.workerId');
  requireNonempty(review.reviewer.attemptId ?? '', 'reviewer.attemptId');
  requireNonempty(review.reviewer.sessionId ?? '', 'reviewer.sessionId');
  requireNonempty(review.reviewer.modelId ?? '', 'reviewer.modelId');

  // --- Reviewer distinctness from source ---
  if (review.reviewer.attemptId === review.source.attemptId) {
    throw new Error('reviewer.attemptId must differ from source.attemptId');
  }
  if (review.reviewer.sessionId === review.source.sessionId) {
    throw new Error('reviewer.sessionId must differ from source.sessionId');
  }

  // --- Source provenance ---
  requireNonempty(review.source.runId, 'source.runId');
  requireNonempty(review.source.attemptId, 'source.attemptId');
  requireNonempty(review.source.sessionId, 'source.sessionId');

  // --- Target repository ---
  requireNonempty(target.repository, 'target.repository');
  if (!validRepository(target.repository)) {
    throw new Error('target.repository must match conservative owner/repo pattern');
  }
  if (target.repository !== review.source.repository) {
    throw new Error('target.repository must equal source.repository');
  }

  // --- Target pull request ---
  if (!Number.isSafeInteger(target.pullRequest) || target.pullRequest <= 0) {
    throw new Error('target.pullRequest must be a positive safe integer');
  }

  // --- Target head ---
  requireNonempty(target.head, 'target.head');
  if (!HEX40.test(target.head)) {
    throw new Error('target.head must be 40 lowercase hex characters');
  }
  if (target.head !== review.requestedHead) {
    throw new Error('target.head must equal requestedHead');
  }
  if (target.head !== review.source.head) {
    throw new Error('target.head must equal source.head');
  }

  // --- Verdict ---
  if (typeof verdict !== 'string' || verdict.trim().length === 0) {
    throw new Error('verdict must be nonempty and not whitespace-only');
  }
  if (utf8ByteLength(verdict) > 8192) {
    throw new Error('verdict must not exceed 8192 UTF-8 bytes');
  }

  // --- Canonical metadata (fixed field order) ---
  const metadata = {
    schemaVersion: 1,
    repository: target.repository,
    pullRequest: target.pullRequest,
    head: target.head,
    reviewId: review.reviewId,
    resultRef: review.outcome.resultRef,
    manifestDigest: review.manifest.digest,
    sourceAttemptId: review.source.attemptId,
    sourceSessionId: review.source.sessionId,
    reviewerAttemptId: review.reviewer.attemptId!,
    reviewerSessionId: review.reviewer.sessionId!,
    reviewerModelId: review.reviewer.modelId!,
    verdict,
  } as const;

  // --- Digest the canonical JSON (no pretty-print) ---
  const metadataJson = JSON.stringify(metadata);
  const digest = createHash('sha256').update(metadataJson).digest('hex');

  // --- Marker and body ---
  const marker = `<!-- helm-review-publication:${digest} -->`;
  const body = marker + '\n' + JSON.stringify(metadata, null, 2) + '\n';
  const bodyDigest = 'sha256:' + createHash('sha256').update(body).digest('hex');

  // --- Frozen output ---
  const frozenTarget: PublicationTarget = Object.freeze({
    repository: target.repository,
    pullRequest: target.pullRequest,
    head: target.head,
  });

  return Object.freeze({
    reviewId: review.reviewId,
    target: frozenTarget,
    resultRef: review.outcome.resultRef,
    body,
    bodyDigest,
    marker,
  });
}

// ---------------------------------------------------------------------------
// Core: matchesReviewPublication
// ---------------------------------------------------------------------------

/**
 * Exact-match verification.  Returns true only when `observedBody` is
 * byte-identical to `prepared.body` AND its SHA-256 digest equals
 * `prepared.bodyDigest`.  No trimming, substring matching, or fuzzy
 * acceptance is performed.
 */
export function matchesReviewPublication(
  prepared: PreparedReviewPublication,
  observedBody: string,
): boolean {
  if (observedBody !== prepared.body) {
    return false;
  }
  const observedDigest = 'sha256:' + createHash('sha256').update(observedBody).digest('hex');
  return observedDigest === prepared.bodyDigest;
}
