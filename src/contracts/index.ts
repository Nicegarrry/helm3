import { z, type ZodType } from 'zod';

/** UTC RFC3339 timestamps are strings at the domain boundary. */
export const utcTimestampSchema = z.string().datetime({ offset: false });
const nonEmptyString = z.string().min(1).refine(
  (value) => value.trim() === value && value.trim().length > 0,
  'must be nonempty and must not have surrounding whitespace',
);
const nonNegativeFiniteNumber = z.number().finite().nonnegative();
const nonNegativeSafeInteger = z.number().int().safe().nonnegative();
const positiveInteger = z.number().int().safe().positive();

export const rawArtifactRefSchema = z.object({
  ref: nonEmptyString,
  hash: nonEmptyString,
  mediaType: nonEmptyString,
}).strict();
export type RawArtifactRef = z.infer<typeof rawArtifactRefSchema>;

export const preconditionSchema = z.object({
  authority: z.enum(['brief', 'github', 'git', 'ci', 'pi', 'helm']),
  subject: nonEmptyString,
  version: nonEmptyString.optional(),
  predicate: nonEmptyString,
}).strict();
export type Precondition = z.infer<typeof preconditionSchema>;

export const commandScopeSchema = z.object({
  repositoryId: nonEmptyString,
  mapNodeId: nonEmptyString.optional(),
}).strict();
export type CommandScope = z.infer<typeof commandScopeSchema>;

const commandBaseSchema = z.object({
  schemaVersion: z.literal(1),
  commandId: nonEmptyString,
  kind: nonEmptyString,
  idempotencyKey: nonEmptyString,
  payloadHash: nonEmptyString,
  scope: commandScopeSchema,
  actorId: nonEmptyString,
  runId: nonEmptyString,
  leaseId: nonEmptyString,
  leaseRevision: positiveInteger,
  plannedAt: utcTimestampSchema,
  notAfter: utcTimestampSchema,
  expected: z.array(preconditionSchema),
  payload: z.unknown(),
  requiredEvidence: z.array(nonEmptyString),
});

const commandOrigins = z.enum(['orchestrator', 'supervisor', 'worker', 'human']);
export type CommandOrigin = z.infer<typeof commandOrigins>;

/**
 * Envelope validation only. Payload validity is established by
 * parseExecutableCommand with a kind registry at the trusted execution boundary.
 */
export const commandSchema = z.discriminatedUnion('origin', [
  commandBaseSchema.extend({
    origin: z.literal('orchestrator'),
    orchestratorLeaseId: nonEmptyString,
    orchestratorEpoch: positiveInteger,
  }).strict(),
  commandBaseSchema.extend({
    origin: z.enum(['supervisor', 'worker', 'human']),
    orchestratorLeaseId: z.undefined().optional(),
    orchestratorEpoch: z.undefined().optional(),
  }).strict(),
]).superRefine((command, context) => {
  if (Date.parse(command.notAfter) < Date.parse(command.plannedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['notAfter'], message: 'notAfter must not precede plannedAt' });
  }
});
export type Command = z.infer<typeof commandSchema>;

export type CommandPayloadRegistry = Readonly<Record<string, ZodType<unknown>>>;

function preservesJsonSemantics(input: unknown, validated: unknown): boolean {
  if (input === null || validated === null) return input === validated;
  if (typeof input === 'string' || typeof input === 'boolean') return input === validated;
  if (typeof input === 'number') return Number.isFinite(input) && input === validated;
  if (Array.isArray(input)) {
    return Array.isArray(validated)
      && input.length === validated.length
      && input.every((value, index) => preservesJsonSemantics(value, validated[index]));
  }
  if (typeof input !== 'object' || typeof validated !== 'object' || validated === null || Array.isArray(validated)) {
    return false;
  }
  const inputPrototype = Object.getPrototypeOf(input);
  const validatedPrototype = Object.getPrototypeOf(validated);
  if ((inputPrototype !== Object.prototype && inputPrototype !== null)
    || (validatedPrototype !== Object.prototype && validatedPrototype !== null)) return false;
  const inputRecord = input as Record<string, unknown>;
  const validatedRecord = validated as Record<string, unknown>;
  const inputKeys = Object.keys(inputRecord);
  const validatedKeys = Object.keys(validatedRecord);
  return inputKeys.length === validatedKeys.length
    && inputKeys.every((key) => Object.hasOwn(validatedRecord, key)
      && preservesJsonSemantics(inputRecord[key], validatedRecord[key]));
}

/** Rejects unknown kinds: a generic envelope is never executable authority. */
export function parseExecutableCommand(
  input: unknown,
  payloadRegistry: CommandPayloadRegistry,
): Command {
  const command = commandSchema.parse(input);
  if (!Object.hasOwn(payloadRegistry, command.kind)) {
    throw new Error(`No payload schema is registered for command kind: ${command.kind}`);
  }
  const validatedPayload = payloadRegistry[command.kind].parse(command.payload);
  if (!preservesJsonSemantics(command.payload, validatedPayload)) {
    throw new Error(`Payload schema for command kind ${command.kind} must preserve exact JSON semantics`);
  }
  return command;
}

export function createObservationSchema<T>(valueSchema: ZodType<T>) {
  return z.object({
    value: valueSchema.nullable(),
    state: z.enum(['known', 'unknown', 'unavailable']),
    source: nonEmptyString,
    observedAt: utcTimestampSchema,
    subjectVersion: nonEmptyString.optional(),
    reason: nonEmptyString.optional(),
  }).strict();
}
export type Observation<T> = {
  value: T | null;
  state: 'known' | 'unknown' | 'unavailable';
  source: string;
  observedAt: string;
  subjectVersion?: string;
  reason?: string;
};

const resourceLimitSchema = z.object({
  poolId: nonEmptyString,
  unit: nonEmptyString,
  limit: nonNegativeFiniteNumber,
}).strict();
const protectedReserveSchema = z.object({
  poolId: nonEmptyString,
  unit: nonEmptyString,
  amount: nonNegativeFiniteNumber,
}).strict();

const knownIntegerTelemetrySchema = z.object({
  state: z.literal('known'),
  value: nonNegativeSafeInteger,
}).strict();
const unavailableIntegerTelemetrySchema = z.object({
  state: z.enum(['unknown', 'unavailable']),
  value: z.null(),
  reason: nonEmptyString.optional(),
}).strict();
export const integerTelemetrySchema = z.union([knownIntegerTelemetrySchema, unavailableIntegerTelemetrySchema]);
export type IntegerTelemetry = z.infer<typeof integerTelemetrySchema>;

export const contextOccupancySchema = z.object({
  contextTokens: integerTelemetrySchema,
  contextWindow: integerTelemetrySchema,
  compactionCount: integerTelemetrySchema,
}).strict();
export type ContextOccupancy = z.infer<typeof contextOccupancySchema>;

const knownCostTelemetrySchema = z.object({
  state: z.literal('known'),
  amount: nonNegativeFiniteNumber,
  unit: nonEmptyString,
}).strict();
const unavailableCostTelemetrySchema = z.object({
  state: z.enum(['unknown', 'unavailable']),
  amount: z.null(),
  unit: nonEmptyString.optional(),
  reason: nonEmptyString.optional(),
}).strict();
export const costTelemetrySchema = z.union([knownCostTelemetrySchema, unavailableCostTelemetrySchema]);
export type CostTelemetry = z.infer<typeof costTelemetrySchema>;

export const usageRecordSchema = z.object({
  usageId: nonEmptyString,
  schemaVersion: z.literal(1),
  attemptId: nonEmptyString,
  sessionId: nonEmptyString,
  model: nonEmptyString,
  provider: nonEmptyString,
  poolId: nonEmptyString,
  consumer: nonEmptyString,
  observedAt: utcTimestampSchema,
  contextOccupancy: contextOccupancySchema,
  consumedTokens: integerTelemetrySchema,
  cachedTokens: integerTelemetrySchema,
  cost: costTelemetrySchema,
}).strict();
export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const autonomyLeaseSchema = z.object({
  leaseId: nonEmptyString,
  revision: positiveInteger,
  issuedBy: nonEmptyString,
  parentAuthorityId: nonEmptyString,
  scope: z.object({
    repositoryId: nonEmptyString,
    mapNodeIds: z.array(nonEmptyString),
  }).strict(),
  allowedActions: z.array(nonEmptyString),
  issuedAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
  maxConcurrency: nonNegativeSafeInteger,
  maxAttemptsPerNode: nonNegativeSafeInteger,
  poolLimits: z.array(resourceLimitSchema),
  protectedReserves: z.array(protectedReserveSchema),
}).strict().superRefine((lease, context) => {
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiresAt must follow issuedAt' });
  }
});
export type AutonomyLease = z.infer<typeof autonomyLeaseSchema>;

export const orchestratorLeaseSchema = z.object({
  runId: nonEmptyString,
  leaseId: nonEmptyString,
  owner: z.enum(['fable', 'astra']),
  sessionId: nonEmptyString,
  epoch: positiveInteger,
  issuedAt: utcTimestampSchema,
  expiresAt: utcTimestampSchema,
}).strict().superRefine((lease, context) => {
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiresAt must follow issuedAt' });
  }
});
export type OrchestratorLease = z.infer<typeof orchestratorLeaseSchema>;

export const eventSchema = z.object({
  eventId: nonEmptyString,
  schemaVersion: z.literal(1),
  kind: nonEmptyString,
  source: nonEmptyString,
  sourceEventId: nonEmptyString,
  occurredAt: utcTimestampSchema,
  recordedAt: utcTimestampSchema,
  commandId: nonEmptyString.optional(),
  attemptId: nonEmptyString.optional(),
  sessionId: nonEmptyString.optional(),
  correlationId: nonEmptyString,
  causationId: nonEmptyString.optional(),
  payload: z.unknown(),
}).strict();
export type Event = z.infer<typeof eventSchema>;

export const attemptSchema = z.object({
  attemptId: nonEmptyString,
  mapNodeId: nonEmptyString,
  mapNodeRevision: nonEmptyString,
  objectiveVersion: nonEmptyString,
  acceptanceVersion: nonEmptyString,
  role: nonEmptyString,
  model: nonEmptyString,
  family: nonEmptyString,
  provider: nonEmptyString,
  capability: nonEmptyString,
  poolId: nonEmptyString,
  workspace: nonEmptyString,
  baseSha: nonEmptyString,
  contextManifestHash: nonEmptyString,
  leaseId: nonEmptyString,
  sessionIds: z.array(nonEmptyString),
  commandIds: z.array(nonEmptyString),
  startedAt: utcTimestampSchema,
  endedAt: utcTimestampSchema.optional(),
  outcome: z.enum(['succeeded', 'partial', 'failed', 'cancelled', 'unknown']).optional(),
  evidenceRefs: z.array(nonEmptyString),
  usageRefs: z.array(nonEmptyString),
  findingRefs: z.array(nonEmptyString),
  handoffId: nonEmptyString.optional(),
}).strict();
export type Attempt = z.infer<typeof attemptSchema>;

export const workerResultSchema = z.object({
  status: z.enum(['succeeded', 'partial', 'failed', 'cancelled']),
  summary: nonEmptyString,
  changed_files: z.array(nonEmptyString),
  commits: z.array(nonEmptyString),
  decisions: z.array(nonEmptyString),
  discoveries: z.array(nonEmptyString),
  tests_claimed: z.array(nonEmptyString),
  acceptance_claims: z.array(z.object({
    criterionId: nonEmptyString,
    claim: nonEmptyString,
    evidenceRefs: z.array(nonEmptyString),
  }).strict()),
  risks: z.array(nonEmptyString),
  unresolved: z.array(nonEmptyString),
  artifacts: z.array(rawArtifactRefSchema),
  recommended_next_action: nonEmptyString,
}).strict();
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const gateResultSchema = z.object({
  gateId: nonEmptyString,
  trustedDefinitionRef: nonEmptyString,
  definitionHash: nonEmptyString,
  command: z.array(nonEmptyString).min(1),
  repositoryId: nonEmptyString,
  headSha: nonEmptyString,
  baseSha: nonEmptyString.optional(),
  exitStatus: z.number().int().nullable(),
  checks: z.array(z.object({
    name: nonEmptyString,
    result: z.enum(['pass', 'fail', 'unknown']),
    evidenceRefs: z.array(nonEmptyString),
  }).strict()),
  artifactRefs: z.array(nonEmptyString),
  observedAt: utcTimestampSchema,
}).strict();
export type GateResult = z.infer<typeof gateResultSchema>;

export type OrchestratorDriver = {
  start(input: { runId: string; contextRefs: string[]; mode: 'primary' | 'consultant' }): Promise<{ sessionId: string }>;
  resume(input: { sessionId?: string; recoveryBundleRef: string }): Promise<{ sessionId: string }>;
  send_event(input: { sessionId: string; eventRef: string }): Promise<void>;
  invoke(input: { sessionId: string; objectiveRef: string; contextRefs: string[] }): Promise<{ resultRef: string }>;
  interrupt(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }>;
  checkpoint(input: { sessionId: string }): Promise<{ bundleRef: string }>;
  handoff(input: { sessionId: string }): Promise<{ bundleRef: string; outgoingSummaryRef?: string }>;
  stop(input: { sessionId: string }): Promise<{ observed: 'stopped' | 'pending' | 'unknown' }>;
};
