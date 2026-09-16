import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod/v3';
import {
  attemptSchema,
  autonomyLeaseSchema,
  commandSchema,
  orchestratorLeaseSchema,
  utcTimestampSchema,
  type OrchestratorLease,
  type Attempt,
  type AutonomyLease,
  type Command,
} from '../contracts/index.js';
import type { KernelKind, ModelFact } from '../core/index.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import type { WorkerSpawnInput } from './worker-fleet.js';

export const WORKER_SPAWN_KIND = 'worker.spawn';
const WORKER_SPAWN_ACTION = 'worker.spawn';

/**
 * Trusted planning input. This is the full, explicit public contract so callers
 * cannot drift; it is never an authority grant. The kernel and fleet re-read
 * fresh authority immediately before any effect.
 */
export type SpawnPlanInput = {
  input: WorkerSpawnInput;
  workerId: string;
  attemptId: string;
  commandId: string;
  actorId: string;
  context: HelmToolExecutionContext;
  autonomyLease: AutonomyLease;
  ownership: OrchestratorLease;
  plannedAt: string;
  notAfter: string;
  repositoryId: string;
  mapNodeId: string;
  mapNodeRevision: string;
  objectiveVersion: string;
  acceptanceVersion: string;
  model: { fact: ModelFact; api: string; family: string };
  requiredCapabilities: readonly string[];
  dataClassification: 'public' | 'restricted';
  workspace: {
    repository: string;
    destination: string;
    branch: string;
    baseSha: string;
    owner: { attemptId: string; generation: number; expiresAt: string };
    policy: {
      writableRoots: readonly string[];
      readableRoots?: readonly string[];
      protectedRoots?: readonly string[];
    };
  };
};

export type WorkerSpawnPayload = {
  workerId: string;
  attemptId: string;
  modelId: string;
  modelProvider: string;
  modelApi: string;
  role: string;
  inputDigest: string;
  baseSha: string;
  modelFactVersion: number;
  dataPolicy: 'public-only' | 'restricted-ok';
  mode: 'review-readonly' | 'worker';
  requiredCapabilities: readonly string[];
  dataClassification: 'public' | 'restricted';
  objectiveRef: string;
  acceptanceRef: string;
  contextRefs: readonly string[];
  label?: string;
};

/** Canonical worker.spawn payload schema; strict so callers cannot smuggle fields. */
export const workerSpawnPayloadSchema = z.object({
  workerId: z.string().min(1),
  attemptId: z.string().min(1),
  modelId: z.string().min(1),
  modelProvider: z.string().min(1),
  modelApi: z.string().min(1),
  role: z.string().min(1),
  inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  modelFactVersion: z.number().int().positive(),
  dataPolicy: z.enum(['public-only', 'restricted-ok']),
  mode: z.enum(['review-readonly', 'worker']),
  requiredCapabilities: z.array(z.string().min(1)).min(1),
  dataClassification: z.enum(['public', 'restricted']),
  objectiveRef: z.string().min(1),
  acceptanceRef: z.string().min(1),
  contextRefs: z.array(z.string().min(1)),
  label: z.string().min(1).optional(),
}).strict();

type ValidatedPayload = z.infer<typeof workerSpawnPayloadSchema>;

/**
 * The kernel registration for worker.spawn. Only modelSelection is meaningful
 * for planning; resource enforcement and effects remain with the fleet/kernel.
 */
export const workerSpawnKind: KernelKind = Object.freeze({
  payloadSchema: workerSpawnPayloadSchema,
  modelSelection: (payload: unknown) => {
    const parsed = workerSpawnPayloadSchema.parse(payload);
    return Object.freeze({
      modelId: parsed.modelId,
      provider: parsed.modelProvider,
      factVersion: parsed.modelFactVersion,
      role: parsed.role,
      requiredCapabilities: Object.freeze([...parsed.requiredCapabilities]),
      dataClassification: parsed.dataClassification,
    });
  },
});

const nonEmpty = (value: string, message: string): void => {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(message);
  }
};

const stringList = (values: readonly string[], message: string): readonly string[] => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(message);
  }
  for (const value of values) nonEmpty(value, `${message}: every element must be a non-empty string`);
  return Object.freeze(values.map((value) => String(value)));
};

const isoMs = (value: string): number => {
  utcTimestampSchema.parse(value);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('invalid UTC timestamp');
  return ms;
};

const digestInput = (input: WorkerSpawnInput): string => {
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new Error('input must be JSON serializable');
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
};

const computeNotAfter = (candidates: readonly string[]): string => {
  let winner = candidates[0];
  let winnerMs = isoMs(winner);
  for (const candidate of candidates.slice(1)) {
    const ms = isoMs(candidate);
    if (ms < winnerMs) {
      winner = candidate;
      winnerMs = ms;
    }
  }
  return winner;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

const samePath = (a: string, b: string): boolean => isAbsolute(a) && isAbsolute(b) && resolve(a) === resolve(b);

function validateWorkspace(workspace: SpawnPlanInput['workspace'], attemptId: string): void {
  nonEmpty(workspace.repository, 'workspace.repository must be non-empty');
  nonEmpty(workspace.destination, 'workspace.destination must be non-empty');
  nonEmpty(workspace.branch, 'workspace.branch must be non-empty');
  if (!isAbsolute(workspace.repository)) throw new Error('workspace.repository must be absolute');
  if (!isAbsolute(workspace.destination)) throw new Error('workspace.destination must be absolute');
  if (!/^[0-9a-f]{40}$/.test(workspace.baseSha)) throw new Error('workspace.baseSha must be lowercase hex');
  if (workspace.owner.attemptId !== attemptId) throw new Error('workspace owner attempt mismatch');
  if (!Number.isSafeInteger(workspace.owner.generation) || workspace.owner.generation <= 0) {
    throw new Error('workspace owner generation must be a positive safe integer');
  }
  isoMs(workspace.owner.expiresAt);
  if (!Array.isArray(workspace.policy.writableRoots)) throw new Error('workspace.policy.writableRoots must be an array');
  for (const root of workspace.policy.writableRoots) nonEmpty(root, 'workspace writable root must be non-empty');
}

function validateModel(
  model: SpawnPlanInput['model'],
  input: WorkerSpawnInput,
  requiredCapabilities: readonly string[],
  dataClassification: 'public' | 'restricted',
  plannedAt: string,
): 'public-only' | 'restricted-ok' {
  const fact = model.fact;
  if (fact.modelId !== input.modelId) throw new Error('model request id does not match fact');
  if (!fact.enabled) throw new Error('model is not enabled');
  if (fact.availability !== 'known_available') throw new Error('model availability is not known_available');
  if (!fact.roles.includes(input.role)) throw new Error('model role is not admitted');
  if (!Number.isSafeInteger(fact.factVersion) || fact.factVersion <= 0) throw new Error('model factVersion must be a positive integer');
  const observedAt = isoMs(fact.observedAt);
  if (observedAt > isoMs(plannedAt)) throw new Error('model fact observedAt is after plannedAt');
  nonEmpty(model.api, 'model.api must be non-empty');
  nonEmpty(model.family, 'model.family must be non-empty');
  if (fact.dataPolicy === undefined) throw new Error('model dataPolicy is unknown');
  if (dataClassification === 'restricted' && fact.dataPolicy !== 'restricted-ok') {
    throw new Error('restricted data requires a restricted-ok model policy');
  }
  const available = fact.capabilitiesByRole
    ? (Object.hasOwn(fact.capabilitiesByRole, input.role) ? fact.capabilitiesByRole[input.role] : [])
    : fact.capabilities;
  if (!requiredCapabilities.every(capability => available.includes(capability))) {
    throw new Error('model does not meet required role capabilities');
  }
  return fact.dataPolicy;
}

function validateReview(input: WorkerSpawnInput, workspace: SpawnPlanInput['workspace'], mode: 'review-readonly' | 'worker'): void {
  if (input.reviewConstraint === undefined) return;
  if (input.reviewConstraint.mode !== 'review-readonly' || mode !== 'review-readonly') throw new Error('internal: review mode mismatch');
  if (!samePath(workspace.repository, input.reviewConstraint.repository)) {
    throw new Error('review constraint repository does not match workspace repository');
  }
  if (input.reviewConstraint.expectedHead !== workspace.baseSha) {
    throw new Error('review constraint head does not match workspace baseSha');
  }
  if (workspace.policy.writableRoots.length !== 0) {
    throw new Error('review workspace must have zero writable roots');
  }
}

function validateLeases(
  arg: SpawnPlanInput,
): { autonomy: AutonomyLease; ownership: OrchestratorLease } {
  const autonomy = autonomyLeaseSchema.parse(arg.autonomyLease);
  const ownership = orchestratorLeaseSchema.parse(arg.ownership);
  if (arg.context.mode !== 'primary') throw new Error('context must be primary');
  if (ownership.sessionId !== arg.context.sessionId) throw new Error('ownership session does not match context');
  if (ownership.runId !== arg.context.runId) throw new Error('ownership run does not match context');
  if (autonomy.scope.repositoryId !== arg.repositoryId) throw new Error('lease repository mismatch');
  if (!autonomy.scope.mapNodeIds.includes(arg.mapNodeId)) throw new Error('lease does not cover map node');
  if (!autonomy.allowedActions.includes(WORKER_SPAWN_ACTION)) throw new Error('lease does not allow worker.spawn');
  return { autonomy, ownership };
}

export type WorkerSpawnPlan = {
  command: Command;
  attempt: Attempt;
  workspace: SpawnPlanInput['workspace'];
};

/**
 * Pure, deterministic command planning. It performs no I/O and grants no
 * authority: the kernel/fleet re-read fresh state before applying any effect.
 */
export function planWorkerSpawn(arg: SpawnPlanInput): WorkerSpawnPlan {
  nonEmpty(arg.workerId, 'workerId must be non-empty');
  nonEmpty(arg.attemptId, 'attemptId must be non-empty');
  nonEmpty(arg.commandId, 'commandId must be non-empty');
  nonEmpty(arg.actorId, 'actorId must be non-empty');
  nonEmpty(arg.repositoryId, 'repositoryId must be non-empty');
  nonEmpty(arg.mapNodeId, 'mapNodeId must be non-empty');
  nonEmpty(arg.mapNodeRevision, 'mapNodeRevision must be non-empty');
  nonEmpty(arg.objectiveVersion, 'objectiveVersion must be non-empty');
  nonEmpty(arg.acceptanceVersion, 'acceptanceVersion must be non-empty');
  if (typeof arg.dataClassification !== 'string'
    || (arg.dataClassification !== 'public' && arg.dataClassification !== 'restricted')) {
    throw new Error('dataClassification must be public or restricted');
  }

  const input = arg.input;
  nonEmpty(input.objectiveRef, 'input.objectiveRef must be non-empty');
  nonEmpty(input.acceptanceRef, 'input.acceptanceRef must be non-empty');
  nonEmpty(input.modelId, 'input.modelId must be non-empty');
  nonEmpty(input.role, 'input.role must be non-empty');
  if (!Array.isArray(input.contextRefs)) throw new Error('contextRefs must be an array');
  for (const ref of input.contextRefs) nonEmpty(ref, 'contextRefs must contain nonempty refs');

  const requiredCapabilities = stringList(arg.requiredCapabilities, 'requiredCapabilities must be non-empty');
  validateWorkspace(arg.workspace, arg.attemptId);
  const { autonomy, ownership } = validateLeases(arg);
  const dataPolicy = validateModel(arg.model, arg.input, requiredCapabilities, arg.dataClassification, arg.plannedAt);

  const mode: 'review-readonly' | 'worker' = arg.input.reviewConstraint ? 'review-readonly' : 'worker';
  validateReview(arg.input, arg.workspace, mode);

  const plannedAtMs = isoMs(arg.plannedAt);
  const notAfterMs = isoMs(arg.notAfter);
  if (notAfterMs < plannedAtMs) throw new Error('requested notAfter precedes plannedAt');
  const issuedAtMs = isoMs(autonomy.issuedAt);
  const autonomyExpiryMs = isoMs(autonomy.expiresAt);
  const ownershipExpiryMs = isoMs(ownership.expiresAt);
  const ownerExpiryMs = isoMs(arg.workspace.owner.expiresAt);
  if (plannedAtMs < isoMs(ownership.issuedAt)) throw new Error('plannedAt precedes ownership issue');
  if (plannedAtMs < issuedAtMs) throw new Error('plannedAt precedes lease issue');
  if (plannedAtMs >= autonomyExpiryMs) throw new Error('autonomy lease is not active at plannedAt');
  if (plannedAtMs >= ownershipExpiryMs) throw new Error('ownership lease is not active at plannedAt');
  if (plannedAtMs >= ownerExpiryMs) throw new Error('workspace owner lease is not active at plannedAt');

  const effectiveNotAfter = computeNotAfter([arg.notAfter, autonomy.expiresAt, ownership.expiresAt, arg.workspace.owner.expiresAt]);
  if (isoMs(effectiveNotAfter) <= plannedAtMs) throw new Error('no positive remaining planning window');

  const inputDigest = digestInput(arg.input);

  const payload: WorkerSpawnPayload = {
    workerId: arg.workerId,
    attemptId: arg.attemptId,
    modelId: arg.input.modelId,
    modelProvider: arg.model.fact.provider,
    modelApi: arg.model.api,
    role: arg.input.role,
    inputDigest,
    baseSha: arg.workspace.baseSha,
    modelFactVersion: arg.model.fact.factVersion,
    dataPolicy,
    mode,
    requiredCapabilities: [...requiredCapabilities],
    dataClassification: arg.dataClassification,
    objectiveRef: arg.input.objectiveRef,
    acceptanceRef: arg.input.acceptanceRef,
    contextRefs: [...arg.input.contextRefs],
    ...(arg.input.label !== undefined ? { label: arg.input.label } : {}),
  };

  const validatedPayload: ValidatedPayload = workerSpawnPayloadSchema.parse(payload);
  const payloadHash = `sha256:${createHash('sha256').update(JSON.stringify(validatedPayload), 'utf8').digest('hex')}`;

  const command: Command = commandSchema.parse({
    schemaVersion: 1,
    commandId: arg.commandId,
    kind: WORKER_SPAWN_KIND,
    idempotencyKey: arg.commandId,
    payloadHash,
    scope: { repositoryId: arg.repositoryId, mapNodeId: arg.mapNodeId },
    actorId: arg.actorId,
    runId: arg.context.runId,
    leaseId: autonomy.leaseId,
    leaseRevision: autonomy.revision,
    plannedAt: arg.plannedAt,
    notAfter: effectiveNotAfter,
    expected: [],
    payload: validatedPayload,
    requiredEvidence: [],
    origin: 'orchestrator',
    orchestratorLeaseId: ownership.leaseId,
    orchestratorEpoch: ownership.epoch,
  });

  const attempt: Attempt = attemptSchema.parse({
    attemptId: arg.attemptId,
    mapNodeId: arg.mapNodeId,
    mapNodeRevision: arg.mapNodeRevision,
    objectiveVersion: arg.objectiveVersion,
    acceptanceVersion: arg.acceptanceVersion,
    role: arg.input.role,
    model: arg.input.modelId,
    family: arg.model.family,
    provider: arg.model.fact.provider,
    capability: requiredCapabilities.join(','),
    poolId: arg.model.fact.poolId,
    workspace: arg.workspace.destination,
    baseSha: arg.workspace.baseSha,
    contextManifestHash: inputDigest,
    leaseId: autonomy.leaseId,
    sessionIds: [],
    commandIds: [],
    startedAt: arg.plannedAt,
    evidenceRefs: [],
    usageRefs: [],
    findingRefs: [],
  });

  const clonedWorkspace = deepFreeze(JSON.parse(JSON.stringify(arg.workspace)) as SpawnPlanInput['workspace']);

  return Object.freeze({
    command: deepFreeze(command),
    attempt: deepFreeze(attempt),
    workspace: clonedWorkspace,
  });
}
