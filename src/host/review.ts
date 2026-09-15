import { createHash } from 'node:crypto';
import type { WorkerSpawnInput } from './worker-fleet.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import type { HostControlPlane } from './index.js';
import { PiWorkerFleet } from './worker-fleet.js';
import type { WorkspaceManager } from '../workspace/index.js';
import type { ReviewContextPurpose } from './review-context.js';
import { observeReviewTerminal } from './review-observer.js';

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
  repository: string; workspace: string; runId: string; head: string; clean: boolean; contextRefs: readonly string[];
}>;
export type ReviewManifest = Readonly<{ digest: string; entries: readonly Readonly<{ ref: string; hash: string; purpose: ReviewContextPurpose }>[] }>;
export type ReviewState = 'planned' | 'launched' | 'terminal' | 'unknown';
export type ReviewerProvenance = Readonly<{
  requestedModelId: string; workerId?: string; attemptId?: string; sessionId?: string; spawnCommandId?: string;
  modelId?: string; family?: string; poolId?: string;
}>;
export type ReviewReadonlyObservation = Readonly<{ beforeRef?: string; afterRef?: string }>;
export type ReviewOutcome = Readonly<{ resultRef?: string; rawEventRefs: readonly string[]; readonlyObservation: ReviewReadonlyObservation }>;
/**
 * Durable host provenance for an independent review.  This is deliberately
 * mechanical: it carries no approval bit and never represents model text as a
 * privileged receipt.
 */
export type DurableReviewRecord = Readonly<{
  schemaVersion: 1; reviewId: string; idempotencyKey: string; state: ReviewState;
  source: ReviewSource; requestedHead: string; manifest: ReviewManifest; reviewer: ReviewerProvenance;
  outcome?: ReviewOutcome; failure?: Readonly<{ commandId?: string; effectId?: string; reason: 'spawn-unknown' | 'persistence-unknown' | 'postspawn-failure' | 'preflight-refused' }>;
}>;
export type ReviewLaunch = DurableReviewRecord;
type IndependentReviewSpawnInput = WorkerSpawnInput & Readonly<{
  /** Private host constraint; it is deliberately absent from model tool JSON. */
  reviewConstraint?: Readonly<{ repository: string; expectedHead: string; mode: 'review-readonly' }>;
}>;

/**
 * Durable projection supplied by the host registry/journal, never by model
 * JSON. `prepare` is an atomic create-if-absent; `append` records a new
 * immutable version rather than overwriting prior intent/effect evidence.
 */
export interface ReviewDurabilityStore {
  reopen(idempotencyKey: string): Promise<DurableReviewRecord | undefined>;
  /**
   * Atomically creates the pre-effect claim.  Only the caller receiving
   * `created: true` owns the right to start a native reviewer; a contender
   * must return the durable record and reconcile it instead.
   */
  prepare(record: DurableReviewRecord): Promise<Readonly<{ record: DurableReviewRecord; created: boolean }>>;
  append(record: DurableReviewRecord): Promise<void>;
}

export type ReviewServiceBinding = Readonly<{
  source(workerId: string): Promise<ReviewSource | undefined>;
  /** Reads immutable host artifact bytes before any model/session/worktree effect. */
  readArtifact(ref: string): Promise<string>;
  assertReviewContext(ref: string, purpose: ReviewContextPurpose, text: string): Promise<void>;
  /** Re-read source checkout identity immediately before launch. */
  inspectSource(source: ReviewSource): Promise<Readonly<{ head: string; clean: boolean }>>;
  /** Host-owned policy check: role, provider/API identity, data policy, authority and cross-family floor. */
  authorize(source: ReviewSource, modelId: string): Promise<void>;
  /** Existing fleet spawn; it owns Core admission, accounting, native session and worktree. */
  spawn(input: IndependentReviewSpawnInput): Promise<Readonly<{ workerId: string; attemptId: string; sessionId: string; spawnCommandId?: string; modelId?: string; family?: string; poolId?: string }>>;
  /** Durable registry projection. `prepare` completes before any native spawn. */
  durability: ReviewDurabilityStore;
  observeTerminal?(review: DurableReviewRecord): Promise<ReviewOutcome | undefined>;
}>;

const sha = /^[0-9a-f]{40}$/;
const ref = (value: string): string => { if (!value.trim() || value.length > 512) throw new Error('review reference is invalid'); return value; };
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const reviewKey = (source: ReviewSource, input: ReviewRequest): string => digest({ source: { workerId: source.workerId, attemptId: source.attemptId, sessionId: source.sessionId, runId: source.runId }, expectedHead: input.expectedHead, objectiveRef: input.objectiveRef, acceptanceRef: input.acceptanceRef, contextRefs: input.contextRefs, reviewerModelId: input.reviewerModelId });
function stableReviewId(key: string): string { return `review-${key.slice('sha256:'.length, 'sha256:'.length + 24)}`; }
function frozenRecord(value: DurableReviewRecord): DurableReviewRecord {
  return Object.freeze({ ...value, source: Object.freeze({ ...value.source, contextRefs: Object.freeze([...value.source.contextRefs]) }), manifest: Object.freeze({ ...value.manifest, entries: Object.freeze(value.manifest.entries.map(entry => Object.freeze({ ...entry }))) }), reviewer: Object.freeze({ ...value.reviewer }), ...(value.outcome ? { outcome: Object.freeze({ ...value.outcome, rawEventRefs: Object.freeze([...value.outcome.rawEventRefs]), readonlyObservation: Object.freeze({ ...value.outcome.readonlyObservation }) }) } : {}), ...(value.failure ? { failure: Object.freeze({ ...value.failure }) } : {}) });
}
function frozenRequest(value: ReviewRequest): ReviewRequest {
  return Object.freeze({ ...value, contextRefs: Object.freeze([...value.contextRefs]) });
}
function frozenSource(value: ReviewSource): ReviewSource {
  return Object.freeze({ ...value, contextRefs: Object.freeze([...value.contextRefs]) });
}

/**
 * Host-only review request boundary. It accepts identities and artifact refs,
 * never paths, commands, writable roots, session reuse, receipts or approvals.
 */
export class IndependentReviewService {
  constructor(private readonly binding: ReviewServiceBinding) {}

  async request(input: ReviewRequest): Promise<ReviewLaunch> {
    const request = frozenRequest(input);
    if (!sha.test(request.expectedHead) || !request.sourceWorkerId.trim() || !request.reviewerModelId.trim() || request.contextRefs.length > 32) throw new Error('review request identity is invalid');
    const found = await this.binding.source(request.sourceWorkerId);
    if (!found || found.workerId !== request.sourceWorkerId || found.head !== request.expectedHead || !found.clean || found.runId.trim() === '') throw new Error('source worker is not a fresh clean exact-head result');
    const source = frozenSource(found);
    const fresh = await this.binding.inspectSource(source);
    if (!fresh.clean || fresh.head !== request.expectedHead) throw new Error('source checkout changed before review launch');
    await this.binding.authorize(source, request.reviewerModelId);
    const refs: ReadonlyArray<Readonly<{ ref: string; purpose: ReviewContextPurpose }>> = [{ ref: ref(request.objectiveRef), purpose: 'objective' }, { ref: ref(request.acceptanceRef), purpose: 'acceptance' }, ...request.contextRefs.map(item => ({ ref: ref(item), purpose: 'factual-context' as const }))];
    // Copy the bytes and derive the digest before the async spawn effect.
    // HostArtifactStore rejects effect and invocation refs structurally; the
    // trusted caller remains responsible for selecting text refs that do not
    // contain a builder transcript or primary conclusion.
    const entries = await Promise.all(refs.map(async (item) => { const text = await this.binding.readArtifact(item.ref); await this.binding.assertReviewContext(item.ref, item.purpose, text); return Object.freeze({ ref: item.ref, purpose: item.purpose, hash: digest(text) }); }));
    const manifest = Object.freeze({ digest: digest(entries), entries: Object.freeze(entries) });
    const idempotencyKey = reviewKey(source, request);
    const planned = frozenRecord({ schemaVersion: 1, reviewId: stableReviewId(idempotencyKey), idempotencyKey, state: 'planned', source, requestedHead: request.expectedHead, manifest, reviewer: { requestedModelId: request.reviewerModelId } });
    // This is the durable point of no blind retry.  The manifest binds the
    // immutable artifact refs/hash observations before a session is created.
    const claim = await this.binding.durability.prepare(planned);
    if (!claim.created) return claim.record;
    const atEffect = await this.binding.inspectSource(source);
    if (!atEffect.clean || atEffect.head !== request.expectedHead) {
      const refused = frozenRecord({ ...planned, state: 'unknown', failure: { reason: 'preflight-refused' } });
      await this.binding.durability.append(refused);
      throw new Error(`source checkout changed before review effect; reconcile ${planned.reviewId}`);
    }
    let launched: DurableReviewRecord | undefined;
    try {
      // These refs are the captured authorized manifest, not source-provided
      // context. The fleet re-reads hash-checked HostArtifactStore bytes when
      // constructing the actual native worker request.
      const spawned = await this.binding.spawn(Object.freeze({ objectiveRef: manifest.entries[0]!.ref, acceptanceRef: manifest.entries[1]!.ref, contextRefs: Object.freeze(manifest.entries.slice(2).map(entry => entry.ref)), modelId: request.reviewerModelId, role: 'reviewer', label: `independent-review:${planned.reviewId}:${planned.idempotencyKey}`, reviewConstraint: Object.freeze({ repository: source.repository, expectedHead: request.expectedHead, mode: 'review-readonly' }) }));
      if (!spawned.workerId || !spawned.attemptId || !spawned.sessionId || spawned.attemptId === source.attemptId || spawned.sessionId === source.sessionId) throw new Error('reviewer did not receive distinct native provenance');
      launched = frozenRecord({ ...planned, state: 'launched', reviewer: { requestedModelId: request.reviewerModelId, workerId: spawned.workerId, attemptId: spawned.attemptId, sessionId: spawned.sessionId, ...(spawned.spawnCommandId ? { spawnCommandId: spawned.spawnCommandId } : {}), modelId: spawned.modelId ?? request.reviewerModelId, ...(spawned.family ? { family: spawned.family } : {}), ...(spawned.poolId ? { poolId: spawned.poolId } : {}) } });
      await this.binding.durability.append(launched);
      if (this.binding.observeTerminal) void this.binding.observeTerminal(launched).then(async outcome => { if (outcome) await this.recordTerminal(launched!.reviewId, launched!.idempotencyKey, outcome); }).catch(() => undefined);
      return launched;
    } catch (error) {
      const unknown = frozenRecord({ ...(launched ?? planned), state: 'unknown', failure: { reason: launched ? 'persistence-unknown' : 'spawn-unknown' } });
      try { await this.binding.durability.append(unknown); } catch { /* The planned record remains the reconciliation identity. */ }
      throw new Error(`review launch outcome is unknown; reconcile ${planned.reviewId}; ${error instanceof Error ? error.message : 'unknown cause'}`);
    }
  }

  /** Trusted runtime-only completion path. Model tools cannot call this API. */
  async recordTerminal(reviewId: string, idempotencyKey: string, outcome: ReviewOutcome): Promise<DurableReviewRecord> {
    const current = await this.binding.durability.reopen(idempotencyKey);
    if (!current || current.reviewId !== reviewId || current.state !== 'launched') throw new Error('review cannot be completed from this durable state');
    const terminal = frozenRecord({ ...current, state: 'terminal', outcome: { resultRef: outcome.resultRef, rawEventRefs: outcome.rawEventRefs, readonlyObservation: outcome.readonlyObservation } });
    await this.binding.durability.append(terminal);
    return terminal;
  }
}

/**
 * Adapts the existing durable Host/Fleet/Workspace seams without widening the
 * model-facing worker inspection projection. The host supplies policy facts;
 * the adapter only reconstructs already-recorded builder provenance.
 */
export function createFleetIndependentReviewService(input: Readonly<{
  host: HostControlPlane; fleet: PiWorkerFleet; workspaceManager: WorkspaceManager; context: HelmToolExecutionContext;
  authorize(source: ReviewSource, reviewerModelId: string): Promise<void>;
  durability: ReviewDurabilityStore;
}>): IndependentReviewService {
  let cached: ReviewSource | undefined;
  const source = async (workerId: string): Promise<ReviewSource | undefined> => {
    const inspected = await input.fleet.inspect(input.context, workerId);
    if (inspected.state !== 'terminal') return undefined;
    const snapshot = await input.host.snapshot(input.context.runId);
    const attempt = snapshot.attempts.find(item => item.attemptId === inspected.attemptId);
    const command = snapshot.commands.find(item => item.command.commandId === inspected.spawnCommandId)?.command;
    const payload = command?.payload as Partial<{ modelId: string; modelProvider: string; modelApi: string }> | undefined;
    if (!attempt || !command || !payload || typeof payload.modelId !== 'string' || typeof payload.modelProvider !== 'string' || typeof payload.modelApi !== 'string') return undefined;
    const reservation = input.workspaceManager.reservation(inspected.workspace);
    const git = await input.workspaceManager.inspectGit(reservation);
    cached = Object.freeze({ workerId, attemptId: attempt.attemptId, sessionId: inspected.sessionId, modelId: payload.modelId, family: attempt.family, provider: payload.modelProvider, api: payload.modelApi, repository: reservation.repository, workspace: inspected.workspace, runId: input.context.runId, head: git.head, clean: git.clean, contextRefs: Object.freeze([]) });
    return cached;
  };
  return new IndependentReviewService({ source, readArtifact: (ref) => input.host.artifactsFor(input.context).readText(ref), assertReviewContext: (ref, purpose, text) => input.host.reviewContextFor(input.context).assertApproved(ref, purpose, text),
    inspectSource: async (value) => { const reservation = input.workspaceManager.reservation(value.workspace); await input.workspaceManager.assertExactHead(reservation, value.head); return { head: value.head, clean: true }; },
    authorize: input.authorize, durability: input.durability,
    observeTerminal: async review => { if (!review.reviewer.workerId) return undefined; await input.fleet.waitForTerminal(review.reviewer.workerId); return observeReviewTerminal({ fleet: input.fleet, workspaceManager: input.workspaceManager, journal: input.host.reviewJournalForObservation({ runId: input.context.runId, reviewerAttemptId: review.reviewer.attemptId!, spawnCommandId: review.reviewer.spawnCommandId! }), context: input.context, review }); },
    spawn: async request => {
      const spawned = await input.fleet.spawn(input.context, request);
      const inspected = await input.fleet.inspect(input.context, spawned.workerId);
      const snapshot = await input.host.snapshot(input.context.runId);
      const attempt = snapshot.attempts.find(item => item.attemptId === spawned.attemptId);
      const command = snapshot.commands.find(item => item.command.commandId === inspected.spawnCommandId)?.command;
      const payload = command?.payload as Partial<{ modelId: string }> | undefined;
      if (!attempt || !command || typeof payload?.modelId !== 'string') throw new Error('reviewer launch provenance is unavailable');
      return { ...spawned, spawnCommandId: inspected.spawnCommandId, modelId: payload.modelId, family: attempt.family, poolId: attempt.poolId };
    } });
}
