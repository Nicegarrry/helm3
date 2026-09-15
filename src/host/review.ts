import { createHash } from 'node:crypto';
import type { WorkerSpawnInput } from './worker-fleet.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import type { HostControlPlane } from './index.js';
import { PiWorkerFleet } from './worker-fleet.js';
import type { WorkspaceManager } from '../workspace/index.js';

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
export type ReviewManifest = Readonly<{ digest: string; entries: readonly Readonly<{ ref: string; hash: string }>[] }>;
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
  outcome?: ReviewOutcome; failure?: Readonly<{ commandId?: string; effectId?: string; reason: 'spawn-unknown' | 'persistence-unknown' | 'postspawn-failure' }>;
}>;
export type ReviewLaunch = DurableReviewRecord;

/**
 * Durable projection supplied by the host registry/journal, never by model
 * JSON. `prepare` is an atomic create-if-absent; `append` records a new
 * immutable version rather than overwriting prior intent/effect evidence.
 */
export interface ReviewDurabilityStore {
  reopen(idempotencyKey: string): Promise<DurableReviewRecord | undefined>;
  prepare(record: DurableReviewRecord): Promise<void>;
  append(record: DurableReviewRecord): Promise<void>;
}

export type ReviewServiceBinding = Readonly<{
  source(workerId: string): Promise<ReviewSource | undefined>;
  /** Reads immutable host artifact bytes before any model/session/worktree effect. */
  readArtifact(ref: string): Promise<string>;
  /** Re-read source checkout identity immediately before launch. */
  inspectSource(source: ReviewSource): Promise<Readonly<{ head: string; clean: boolean }>>;
  /** Host-owned policy check: role, provider/API identity, data policy, authority and cross-family floor. */
  authorize(source: ReviewSource, modelId: string): Promise<void>;
  /** Existing fleet spawn; it owns Core admission, accounting, native session and worktree. */
  spawn(input: WorkerSpawnInput): Promise<Readonly<{ workerId: string; attemptId: string; sessionId: string; spawnCommandId?: string; modelId?: string; family?: string; poolId?: string }>>;
  /** Durable registry projection. `prepare` completes before any native spawn. */
  durability: ReviewDurabilityStore;
}>;

const sha = /^[0-9a-f]{40}$/;
const ref = (value: string): string => { if (!value.trim() || value.length > 512) throw new Error('review reference is invalid'); return value; };
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const reviewKey = (source: ReviewSource, input: ReviewRequest): string => digest({ source: { workerId: source.workerId, attemptId: source.attemptId, sessionId: source.sessionId, runId: source.runId }, expectedHead: input.expectedHead, objectiveRef: input.objectiveRef, acceptanceRef: input.acceptanceRef, contextRefs: input.contextRefs, reviewerModelId: input.reviewerModelId });
function stableReviewId(key: string): string { return `review-${key.slice('sha256:'.length, 'sha256:'.length + 24)}`; }
function frozenRecord(value: DurableReviewRecord): DurableReviewRecord {
  return Object.freeze({ ...value, source: Object.freeze({ ...value.source, contextRefs: Object.freeze([...value.source.contextRefs]) }), manifest: Object.freeze({ ...value.manifest, entries: Object.freeze(value.manifest.entries.map(entry => Object.freeze({ ...entry }))) }), reviewer: Object.freeze({ ...value.reviewer }), ...(value.outcome ? { outcome: Object.freeze({ ...value.outcome, rawEventRefs: Object.freeze([...value.outcome.rawEventRefs]), readonlyObservation: Object.freeze({ ...value.outcome.readonlyObservation }) }) } : {}), ...(value.failure ? { failure: Object.freeze({ ...value.failure }) } : {}) });
}

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
    const idempotencyKey = reviewKey(source, input);
    const existing = await this.binding.durability.reopen(idempotencyKey);
    if (existing) return existing;
    const planned = frozenRecord({ schemaVersion: 1, reviewId: stableReviewId(idempotencyKey), idempotencyKey, state: 'planned', source, requestedHead: input.expectedHead, manifest, reviewer: { requestedModelId: input.reviewerModelId } });
    // This is the durable point of no blind retry.  The manifest binds the
    // immutable artifact refs/hash observations before a session is created.
    await this.binding.durability.prepare(planned);
    try {
      // These refs are the captured authorized manifest, not source-provided
      // context. The fleet re-reads hash-checked HostArtifactStore bytes when
      // constructing the actual native worker request.
      const spawned = await this.binding.spawn(Object.freeze({ objectiveRef: manifest.entries[0]!.ref, acceptanceRef: manifest.entries[1]!.ref, contextRefs: Object.freeze(manifest.entries.slice(2).map(entry => entry.ref)), modelId: input.reviewerModelId, role: 'reviewer', label: `independent-review:${planned.reviewId}:${planned.idempotencyKey}` }));
      if (!spawned.workerId || !spawned.attemptId || !spawned.sessionId || spawned.attemptId === source.attemptId || spawned.sessionId === source.sessionId) throw new Error('reviewer did not receive distinct native provenance');
      const launched = frozenRecord({ ...planned, state: 'launched', reviewer: { requestedModelId: input.reviewerModelId, workerId: spawned.workerId, attemptId: spawned.attemptId, sessionId: spawned.sessionId, ...(spawned.spawnCommandId ? { spawnCommandId: spawned.spawnCommandId } : {}), modelId: spawned.modelId ?? input.reviewerModelId, ...(spawned.family ? { family: spawned.family } : {}), ...(spawned.poolId ? { poolId: spawned.poolId } : {}) } });
      await this.binding.durability.append(launched);
      return launched;
    } catch {
      const unknown = frozenRecord({ ...planned, state: 'unknown', failure: { reason: 'spawn-unknown' } });
      try { await this.binding.durability.append(unknown); } catch { /* The planned record remains the reconciliation identity. */ }
      throw new Error(`review launch outcome is unknown; reconcile ${planned.reviewId}`);
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
  return new IndependentReviewService({ source, readArtifact: (ref) => input.host.artifactsFor(input.context).readText(ref),
    inspectSource: async (value) => { const reservation = input.workspaceManager.reservation(value.workspace); await input.workspaceManager.assertExactHead(reservation, value.head); return { head: value.head, clean: true }; },
    authorize: input.authorize, durability: input.durability, spawn: async request => input.fleet.spawn(input.context, request) });
}
