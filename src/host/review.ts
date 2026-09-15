import { createHash, randomUUID } from 'node:crypto';
import type { WorkerSpawnInput } from './worker-fleet.js';

export type ReviewRequest = Readonly<{
  sourceWorkerId: string;
  expectedHead: string;
  objectiveRef: string;
  acceptanceRef: string;
  contextRefs: readonly string[];
  reviewerModelId: string;
}>;
export type ReviewSource = Readonly<{
  workerId: string; attemptId: string; sessionId: string; modelId: string; family: string; provider: string; api: string;
  repository: string; runId: string; head: string; clean: boolean; contextRefs: readonly string[];
}>;
export type ReviewManifest = Readonly<{ digest: string; entries: readonly Readonly<{ ref: string; hash: string }>[] }>;
export type ReviewLaunch = Readonly<{ reviewId: string; source: ReviewSource; manifest: ReviewManifest; workerId: string; attemptId: string; sessionId: string }>;

export type ReviewServiceBinding = Readonly<{
  source(workerId: string): Promise<ReviewSource | undefined>;
  /** Reads immutable host artifact bytes before any model/session/worktree effect. */
  readArtifact(ref: string): Promise<string>;
  /** Re-read source checkout identity immediately before launch. */
  inspectSource(source: ReviewSource): Promise<Readonly<{ head: string; clean: boolean }>>;
  /** Host-owned policy check: role, provider/API identity, data policy, authority and cross-family floor. */
  authorize(source: ReviewSource, modelId: string): Promise<void>;
  /** Existing fleet spawn; it owns Core admission, accounting, native session and worktree. */
  spawn(input: WorkerSpawnInput): Promise<Readonly<{ workerId: string; attemptId: string; sessionId: string }>>;
}>;

const sha = /^[0-9a-f]{40}$/;
const ref = (value: string): string => { if (!value.trim() || value.length > 512) throw new Error('review reference is invalid'); return value; };
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/**
 * Host-only review request boundary. It accepts identities and artifact refs,
 * never paths, commands, writable roots, session reuse, receipts or approvals.
 */
export class IndependentReviewService {
  constructor(private readonly binding: ReviewServiceBinding) {}

  async request(input: ReviewRequest): Promise<ReviewLaunch> {
    if (!sha.test(input.expectedHead) || !input.sourceWorkerId.trim() || !input.reviewerModelId.trim() || input.contextRefs.length > 32) throw new Error('review request identity is invalid');
    const source = await this.binding.source(input.sourceWorkerId);
    if (!source || source.workerId !== input.sourceWorkerId || source.head !== input.expectedHead || !source.clean || source.runId.trim() === '') throw new Error('source worker is not a fresh clean exact-head result');
    const fresh = await this.binding.inspectSource(source);
    if (!fresh.clean || fresh.head !== input.expectedHead) throw new Error('source checkout changed before review launch');
    await this.binding.authorize(source, input.reviewerModelId);
    const refs = [ref(input.objectiveRef), ref(input.acceptanceRef), ...input.contextRefs.map(ref)];
    // Copy the bytes and derive the digest before the async spawn effect. The
    // builder transcript and conclusions are never selected by this interface.
    const entries = await Promise.all(refs.map(async (item) => Object.freeze({ ref: item, hash: digest(await this.binding.readArtifact(item)) })));
    const manifest = Object.freeze({ digest: digest(entries), entries: Object.freeze(entries) });
    const spawned = await this.binding.spawn(Object.freeze({ objectiveRef: input.objectiveRef, acceptanceRef: input.acceptanceRef, contextRefs: Object.freeze([...input.contextRefs]), modelId: input.reviewerModelId, role: 'reviewer', label: `independent-review:${manifest.digest}` }));
    if (!spawned.workerId || !spawned.attemptId || !spawned.sessionId || spawned.attemptId === source.attemptId || spawned.sessionId === source.sessionId) throw new Error('reviewer did not receive distinct native provenance');
    return Object.freeze({ reviewId: `review-${randomUUID()}`, source: Object.freeze({ ...source, contextRefs: Object.freeze([...source.contextRefs]) }), manifest, ...spawned });
  }
}
