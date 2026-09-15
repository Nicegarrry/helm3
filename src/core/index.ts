import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  attemptSchema,
  autonomyLeaseSchema,
  commandSchema,
  eventSchema,
  orchestratorLeaseSchema,
  parseExecutableCommand,
  type Attempt,
  type AutonomyLease,
  type Command,
  type CommandOrigin,
  type Event,
  type Observation,
  type OrchestratorLease,
  type Precondition,
} from '../contracts/index.js';
import { z, type ZodType } from 'zod/v3';

type Statement = { run(...values: unknown[]): { changes?: number }; get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] };
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
type DatabaseConstructor = new (path: string, options?: { timeout?: number }) => Database;
const require = createRequire(__filename);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseConstructor };

/** Attempt identity comes from the authenticated runtime, never command payload. */
export type TrustedCaller = { actorId: string; sessionId?: string; attemptId?: string; allowedOrigins: readonly CommandOrigin[] };
export type ResourceRequest = {
  poolId: string;
  unit: string;
  upperBound: number;
  consumer: 'worker' | 'orchestrator' | 'consultant';
  /** Only a separately authenticated human ruling may cross a protected reserve. */
  humanOverrideId?: string;
};
const resourceRequestSchema = z.object({
  poolId: z.string().min(1), unit: z.string().min(1), upperBound: z.number().finite().nonnegative(),
  consumer: z.enum(['worker', 'orchestrator', 'consultant']), humanOverrideId: z.string().min(1).optional(),
}).strict();
export type ModelFact = {
  modelId: string; provider: string; poolId: string; enabled: boolean;
  capabilities: readonly string[]; roles: readonly string[];
  /** Optional role floors preserve compatibility with pre-economy facts. */
  capabilitiesByRole?: Readonly<Record<string, readonly string[]>>;
  dataPolicy?: 'public-only' | 'restricted-ok';
  availability: 'known_available' | 'known_unavailable' | 'unknown';
  /** Monotonic per-model host observation version. Older snapshots remain durable. */
  factVersion: number;
  observedAt: string;
};
export type HumanAuthorityGrant = {
  authorityId: string; repositoryId: string; mapNodeIds: readonly string[]; allowedActions: readonly string[];
  expiresAt: string; maxConcurrency: number; maxAttemptsPerNode: number;
  poolLimits: readonly { poolId: string; unit: string; limit: number }[];
  protectedReserves: readonly { poolId: string; unit: string; amount: number }[];
};
export type HumanReserveException = {
  exceptionId: string; authorityId: string; repositoryId: string; leaseId: string;
  poolId: string; unit: string; maxAmount: number; expiresAt: string;
};
const resourceBoundSchema = z.object({ poolId: z.string().min(1), unit: z.string().min(1), limit: z.number().finite().nonnegative() }).strict();
const protectedReserveBoundSchema = z.object({ poolId: z.string().min(1), unit: z.string().min(1), amount: z.number().finite().nonnegative() }).strict();
const humanAuthorityGrantSchema = z.object({
  authorityId: z.string().min(1), repositoryId: z.string().min(1), mapNodeIds: z.array(z.string().min(1)), allowedActions: z.array(z.string().min(1)),
  expiresAt: z.string().datetime({ offset: false }), maxConcurrency: z.number().int().nonnegative(), maxAttemptsPerNode: z.number().int().nonnegative(),
  poolLimits: z.array(resourceBoundSchema), protectedReserves: z.array(protectedReserveBoundSchema),
}).strict();
const humanReserveExceptionSchema = z.object({
  exceptionId: z.string().min(1), authorityId: z.string().min(1), repositoryId: z.string().min(1), leaseId: z.string().min(1),
  poolId: z.string().min(1), unit: z.string().min(1), maxAmount: z.number().finite().positive(), expiresAt: z.string().datetime({ offset: false }),
}).strict();
const modelFactSchema = z.object({
  modelId: z.string().min(1), provider: z.string().min(1), poolId: z.string().min(1), enabled: z.boolean(),
  capabilities: z.array(z.string().min(1)), roles: z.array(z.string().min(1)), availability: z.enum(['known_available', 'known_unavailable', 'unknown']),
  capabilitiesByRole: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
  dataPolicy: z.enum(['public-only', 'restricted-ok']).optional(),
  factVersion: z.number().int().positive(), observedAt: z.string().datetime({ offset: false }),
}).strict();
export type KernelKind = {
  payloadSchema: ZodType<unknown>;
  /** Legacy fail-closed marker: it remains invalid until a resolver is supplied. */
  requiresResourceEnforcement?: boolean;
  resourceRequest?: (payload: unknown) => ResourceRequest;
  modelSelection?: (payload: unknown) => { modelId: string; requiredCapabilities: readonly string[]; role: string; dataClassification?: 'public' | 'restricted' };
};
export type KernelOptions = {
  databasePath: string;
  kinds: Readonly<Record<string, KernelKind>>;
  now?: () => string;
};
export type TrustedExecutor = { executorId: string };
export type Claim = { commandId: string; executorId: string; token: string; generation: number; expiresAt: string };
export type CommandStatus = 'queued' | 'claimed' | 'effect_started' | 'observing' | 'succeeded' | 'failed' | 'refused' | 'unknown';
export type CommandRecord = { command: Command; status: CommandStatus; immutableHash: string; claim?: Claim; observations: EffectObservation[] };
/**
 * Trusted host read model for one run. This is deliberately a projection: it
 * exposes parsed durable records without exposing SQLite or authority writes.
 */
export type KernelRunProjection = Readonly<{
  ownership?: OrchestratorLease;
  commands: readonly CommandRecord[];
  attempts: readonly Attempt[];
  attemptLifecycles: readonly Readonly<{ attemptId: string; state: string }>[];
  autonomyLeases: readonly AutonomyLeaseProjection[];
  reservations: readonly ResourceReservationProjection[];
}>;
export type ResourceReservationProjection = Readonly<{
  commandId: string;
  leaseId: string;
  poolId: string;
  unit: string;
  reserved: number;
  settledActual?: number;
  state: string;
  repositoryId?: string;
  mapNodeId?: string;
}>;
export type AutonomyLeaseProjection = Readonly<{ lease: AutonomyLease; revoked: boolean }>;
export const effectObservationSchema = z.object({
  commandId: z.string().min(1),
  effectId: z.string().min(1),
  state: z.enum(['succeeded', 'failed', 'unknown']),
  source: z.string().min(1),
  observedAt: z.string().datetime({ offset: false }),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  detail: z.string().optional(),
}).strict();
export type EffectObservation = z.infer<typeof effectObservationSchema>;
export type KernelEffect = {
  effectId: string;
  execute(command: Command): Promise<void> | void;
  observe(command: Command): Promise<EffectObservation> | EffectObservation;
};

type CommandRow = {
  command_id: string; immutable_json: string; immutable_hash: string; status: CommandStatus;
  payload_json: string; payload_hash: string;
  claim_token: string | null; claim_executor_id: string | null; claim_generation: number; claim_expires_at: string | null; effect_id: string | null;
  lease_id?: string | null; parent_authority_id?: string | null; attempt_id?: string | null; map_node_id?: string | null;
};

function exactHash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function parseRow(row: unknown): CommandRow | undefined {
  return row as CommandRow | undefined;
}

function isExpired(at: string, now: string): boolean {
  return Date.parse(at) <= Date.parse(now);
}

/**
 * Opens a single-host SQLite kernel. `host` is a privileged embedding seam;
 * callers exposed to models receive only `kernel` and cannot issue authority.
 */
export type KernelClient = Pick<Kernel, 'getCommand'>;

export function openKernel(options: KernelOptions): { kernel: KernelClient; host: KernelHost } {
  const database = new DatabaseSync(options.databasePath, { timeout: 5_000 });
  const core = new Kernel(database, options.kinds, options.now ?? (() => new Date().toISOString()));
  core.initialize();
  return {
    kernel: {
      getCommand: core.getCommand.bind(core),
    },
    host: new KernelHost(core),
  };
}

export class KernelHost {
  constructor(private readonly core: Kernel) {}

  declareHumanAuthority(grant: HumanAuthorityGrant): void { this.core.declareHumanAuthority(grant); }
  issueHumanReserveException(exception: HumanReserveException): void { this.core.issueHumanReserveException(exception); }

  issueAutonomyLease(lease: AutonomyLease): void {
    this.core.storeLease(autonomyLeaseSchema.parse(lease));
  }

  revokeAutonomyLease(leaseId: string): void {
    this.core.revokeLease(leaseId);
  }

  putModelFact(fact: ModelFact): void { this.core.putModelFact(fact); }
  requestCancellation(commandId: string): void { this.core.requestCancellation(commandId); }
  /** A pending/unknown stop quarantines the command and keeps any reservation. */
  reportWorkerStop(commandId: string, observed: 'stopped' | 'pending' | 'unknown'): void { this.core.reportWorkerStop(commandId, observed); }
  /** Releases worker capacity only after the trusted runtime confirms its whole attempt stopped. */
  reportAttemptStop(attemptId: string, observed: 'stopped' | 'pending' | 'unknown'): void { this.core.reportAttemptStop(attemptId, observed); }
  /** Known actual consumption releases only the unused upper bound; unknown stays reserved. */
  settleResource(commandId: string, actual: { state: 'known'; amount: number } | { state: 'unknown' | 'unavailable' }): void { this.core.settleResource(commandId, actual); }

  acquireOwnership(lease: OrchestratorLease, expectedEpoch: number): OrchestratorLease {
    return this.core.acquireOwnership(orchestratorLeaseSchema.parse(lease), expectedEpoch);
  }

  assertCurrentOwner(lease: OrchestratorLease): OrchestratorLease {
    return this.core.assertCurrentOwner(orchestratorLeaseSchema.parse(lease));
  }

  readRun(runId: string): KernelRunProjection { return this.core.readRun(runId); }

  /** Pass a run ID for scoped host recovery; the no-argument legacy kernel operation remains global. */
  recoverAfterRestart(runId?: string): void { this.core.recoverInterrupted(runId); }
  close(): void { this.core.close(); }
  admit(intent: unknown, caller: TrustedCaller): CommandRecord { return this.core.admit(intent, caller); }
  claim(commandId: string, executor: TrustedExecutor, expiresAt: string): Claim { return this.core.claim(commandId, executor, expiresAt); }
  perform(commandId: string, claim: Claim, executor: TrustedExecutor, readFact: (precondition: Precondition) => Promise<Observation<boolean>>, effect: KernelEffect): Promise<EffectObservation> { return this.core.perform(commandId, claim, executor, readFact, effect); }
  recordObservation(commandId: string, observation: EffectObservation): void { this.core.recordObservation(commandId, observation); }
  appendEvent(event: Event): void { this.core.appendEvent(event); }
  readEvents(correlationId: string): Event[] { return this.core.readEvents(correlationId); }
  appendOwnedEvent(event: Event, owner: OrchestratorLease): void { this.core.appendOwnedEvent(event, owner); }
  appendAttempt(attempt: Attempt): void { this.core.appendAttempt(attempt); }
}

class Kernel {
  private readonly registry: Record<string, ZodType<unknown>>;

  constructor(
    private readonly db: Database,
    private readonly kinds: Readonly<Record<string, KernelKind>>,
    private readonly now: () => string,
  ) {
    this.registry = Object.fromEntries(Object.entries(kinds).map(([kind, registered]) => [kind, registered.payloadSchema]));
  }

  initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS autonomy_leases (lease_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, bytes TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS human_authorities (authority_id TEXT PRIMARY KEY, bytes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS human_reserve_exceptions (exception_id TEXT PRIMARY KEY, bytes TEXT NOT NULL, consumed_by_command_id TEXT);
      CREATE TABLE IF NOT EXISTS model_facts (model_id TEXT PRIMARY KEY, bytes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_fact_versions (model_id TEXT NOT NULL, fact_version INTEGER NOT NULL, bytes TEXT NOT NULL, PRIMARY KEY (model_id, fact_version));
      CREATE TABLE IF NOT EXISTS ownership (run_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, owner TEXT NOT NULL, session_id TEXT NOT NULL, epoch INTEGER NOT NULL, bytes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, repository_id TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        immutable_json TEXT NOT NULL, immutable_hash TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
        status TEXT NOT NULL, claim_token TEXT, claim_executor_id TEXT, claim_generation INTEGER NOT NULL DEFAULT 0, claim_expires_at TEXT, effect_id TEXT,
        UNIQUE(run_id, repository_id, kind, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, source TEXT NOT NULL, source_event_id TEXT NOT NULL, bytes TEXT NOT NULL, UNIQUE(source, source_event_id));
      CREATE TABLE IF NOT EXISTS attempts (attempt_id TEXT PRIMARY KEY, bytes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effect_observations (observation_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, bytes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clock_highwater (name TEXT PRIMARY KEY, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_reservations (command_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, parent_authority_id TEXT NOT NULL, pool_id TEXT NOT NULL, unit TEXT NOT NULL, reserved REAL NOT NULL, settled_actual REAL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt_lifecycle (attempt_id TEXT PRIMARY KEY, parent_authority_id TEXT NOT NULL, repository_id TEXT NOT NULL, map_node_id TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt_leases (attempt_id TEXT NOT NULL, lease_id TEXT NOT NULL, PRIMARY KEY (attempt_id, lease_id));
      CREATE TABLE IF NOT EXISTS resource_usage_observations (observation_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, state TEXT NOT NULL, amount REAL, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_lifecycle (command_id TEXT PRIMARY KEY, cancel_requested INTEGER NOT NULL DEFAULT 0, stop_observed TEXT);
    `);
    this.addColumn('commands', 'lease_id TEXT');
    this.addColumn('commands', 'parent_authority_id TEXT');
    this.addColumn('commands', 'attempt_id TEXT');
    this.addColumn('commands', 'map_node_id TEXT');
    this.addColumn('resource_reservations', 'attempt_id TEXT');
    this.addColumn('resource_reservations', 'repository_id TEXT');
    this.addColumn('resource_reservations', 'map_node_id TEXT');
  }

  close(): void { this.db.close(); }

  admit(intent: unknown, caller: TrustedCaller): CommandRecord {
    const envelope = commandSchema.parse(intent);
    if (!caller.allowedOrigins.includes(envelope.origin)) throw new Error('trusted caller cannot submit this origin');
    const command = parseExecutableCommand({ ...envelope, actorId: caller.actorId }, this.registry);
    const kind = this.kinds[command.kind];
    if (!kind) throw new Error(`unsupported command kind: ${command.kind}`);
    const payloadJson = JSON.stringify(command.payload);
    if (exactHash(payloadJson) !== command.payloadHash) throw new Error('payloadHash does not match exact persisted payload bytes');
    const immutableJson = JSON.stringify(command);
    const immutableHash = exactHash(immutableJson);
    return this.transaction(() => {
      this.assertAuthority(command, caller);
      const lease = this.loadLease(command.leaseId);
      const attemptId = this.attemptIdFor(command, caller);
      const resourceRequest = kind.resourceRequest?.(command.payload);
      if (kind.requiresResourceEnforcement && !resourceRequest) throw new Error(`resource enforcement is unavailable for command kind: ${command.kind}`);
      if (kind.modelSelection) this.assertLegalModel(kind.modelSelection(command.payload), resourceRequest);
      const existing = parseRow(this.db.prepare(`SELECT command_id, immutable_json, immutable_hash, payload_json, payload_hash, status, claim_token, claim_executor_id, claim_generation, claim_expires_at, effect_id, lease_id, parent_authority_id, attempt_id, map_node_id FROM commands WHERE run_id = ? AND repository_id = ? AND kind = ? AND idempotency_key = ?`).get(command.runId, command.scope.repositoryId, command.kind, command.idempotencyKey));
      if (existing) {
        if (existing.immutable_json !== immutableJson) throw new Error('idempotency collision has different immutable command bytes');
        if (existing.attempt_id !== attemptId) throw new Error('idempotent command attempt identity does not match its original trusted caller');
        return this.toRecord(existing);
      }
      if (attemptId) this.bindAttempt(command, lease, attemptId);
      this.db.prepare(`INSERT INTO commands (command_id, run_id, repository_id, kind, idempotency_key, immutable_json, immutable_hash, payload_json, payload_hash, status, lease_id, parent_authority_id, attempt_id, map_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(
        command.commandId, command.runId, command.scope.repositoryId, command.kind, command.idempotencyKey, immutableJson, immutableHash, payloadJson, exactHash(payloadJson), command.leaseId, lease.parentAuthorityId, attemptId ?? null, command.scope.mapNodeId ?? null,
      );
      this.db.prepare(`INSERT INTO command_lifecycle (command_id) VALUES (?)`).run(command.commandId);
      if (resourceRequest) this.reserve(command, resourceRequest, attemptId);
      this.appendGeneratedEvent('command.queued', command.commandId, { immutableHash });
      return { command, status: 'queued', immutableHash, observations: [] };
    });
  }

  claim(commandId: string, executor: TrustedExecutor, expiresAt: string): Claim {
    z.string().min(1).parse(executor.executorId);
    z.string().datetime({ offset: false }).parse(expiresAt);
    return this.transaction(() => {
      const row = this.requireCommand(commandId);
      const now = this.safeNow();
      if (row.status === 'claimed' && row.claim_expires_at && isExpired(row.claim_expires_at, now)) {
        this.db.prepare(`UPDATE commands SET status = 'queued', claim_token = NULL, claim_expires_at = NULL WHERE command_id = ?`).run(commandId);
      } else if (row.status !== 'queued') {
        throw new Error(`command is not claimable: ${row.status}`);
      }
      const refreshed = this.requireCommand(commandId);
      const command = this.parseCommand(refreshed);
      this.assertAuthority(command);
      this.assertNotCancelled(commandId);
      this.assertConcurrency(command);
      this.activateAttempt(commandId);
      if (isExpired(expiresAt, now)) throw new Error('claim expiry must be in the future');
      const claim: Claim = { commandId, executorId: executor.executorId, token: randomUUID(), generation: refreshed.claim_generation + 1, expiresAt };
      this.db.prepare(`UPDATE commands SET status = 'claimed', claim_token = ?, claim_executor_id = ?, claim_generation = ?, claim_expires_at = ? WHERE command_id = ?`).run(claim.token, claim.executorId, claim.generation, claim.expiresAt, commandId);
      this.appendGeneratedEvent('command.claimed', commandId, { executorId: executor.executorId, generation: claim.generation });
      return claim;
    });
  }

  async perform(commandId: string, claim: Claim, executor: TrustedExecutor, readFact: (precondition: Precondition) => Promise<Observation<boolean>>, effect: KernelEffect): Promise<EffectObservation> {
    z.string().min(1).parse(effect.effectId);
    const row = this.requireCommand(commandId);
    this.assertCurrentClaim(row, claim, executor);
    const command = this.parseCommand(row);
    const observations: Array<Pick<Observation<boolean>, 'source' | 'observedAt' | 'subjectVersion'>> = [];
    try {
      for (const precondition of command.expected) {
        const observation = await readFact(precondition);
        if (observation.state !== 'known' || observation.value !== true || (precondition.version && observation.subjectVersion !== precondition.version)) {
          throw new Error(`precondition is not freshly known: ${precondition.subject}`);
        }
        observations.push({ source: observation.source, observedAt: observation.observedAt, subjectVersion: observation.subjectVersion });
      }
      this.transaction(() => {
        const current = this.requireCommand(commandId);
        this.assertCurrentClaim(current, claim, executor);
        this.assertAuthority(command);
        this.assertNotCancelled(commandId);
        const kind = this.kinds[command.kind];
        if (!kind) throw new Error(`unsupported command kind: ${command.kind}`);
        this.assertLegalModelSelection(kind, command.payload);
        this.db.prepare(`UPDATE commands SET status = 'effect_started', effect_id = ? WHERE command_id = ?`).run(effect.effectId, commandId);
        this.appendGeneratedEvent('command.effect_started', commandId, { claimGeneration: claim.generation, executorId: executor.executorId, effectId: effect.effectId, observations });
      });
    } catch (error) {
      this.refuseIfCurrent(commandId, claim, executor, error instanceof Error ? error.message : 'authority or precondition refusal');
      throw error;
    }
    try {
      await effect.execute(command);
      this.transaction(() => {
        const current = this.requireCommand(commandId);
        if (current.status === 'effect_started' && current.effect_id === effect.effectId) {
          this.db.prepare(`UPDATE commands SET status = 'observing' WHERE command_id = ?`).run(commandId);
          this.appendGeneratedEvent('command.observing', commandId, { effectId: effect.effectId });
        }
      });
      const observation = await effect.observe(command);
      return this.setTerminal(commandId, observation);
    } catch (error) {
      return this.setTerminal(commandId, { commandId, effectId: effect.effectId, state: 'unknown', source: 'kernel-effect', observedAt: this.now(), evidenceRefs: ['kernel:effect-error'], detail: error instanceof Error ? error.message : 'effect failed before observed result' });
    }
  }

  recordObservation(commandId: string, observation: EffectObservation): void {
    this.requireCommand(commandId);
    this.setTerminal(commandId, observation);
  }

  /** Atomic owner fence and Log append for judgement acknowledgements. */
  appendOwnedEvent(event: Event, owner: OrchestratorLease): void {
    const parsed = eventSchema.parse(event);
    const lease = orchestratorLeaseSchema.parse(owner);
    if (parsed.sessionId !== lease.sessionId) throw new Error('event session does not match owner');
    this.transaction(() => {
      this.assertCurrentOwner(lease);
      this.insertEvent(parsed, JSON.stringify(parsed));
    });
  }

  /** Bounded trusted Log query; overflow refuses rather than silently losing wake causes. */
  readEvents(correlationId: string): Event[] {
    z.string().min(1).max(1024).parse(correlationId);
    const rows = this.db.prepare(`SELECT bytes FROM events WHERE json_extract(bytes, '$.correlationId') = ? ORDER BY rowid LIMIT 10001`).all(correlationId) as Array<{ bytes: string }>;
    if (rows.length > 10000) throw new Error('event query exceeds bounded supervisor history');
    return rows.map((row) => eventSchema.parse(JSON.parse(row.bytes)));
  }

  appendEvent(event: Event): void {
    const parsed = eventSchema.parse(event);
    const bytes = JSON.stringify(parsed);
    this.transaction(() => {
      this.insertEvent(parsed, bytes);
    });
  }

  appendAttempt(attempt: Attempt): void {
    const parsed = attemptSchema.parse(attempt);
    const bytes = JSON.stringify(parsed);
    this.transaction(() => {
      const existing = this.db.prepare(`SELECT bytes FROM attempts WHERE attempt_id = ?`).get(parsed.attemptId) as { bytes: string } | undefined;
      if (existing && existing.bytes !== bytes) throw new Error('attempt history is immutable');
      if (!existing) this.db.prepare(`INSERT INTO attempts (attempt_id, bytes) VALUES (?, ?)`).run(parsed.attemptId, bytes);
    });
  }

  getCommand(commandId: string): CommandRecord | undefined {
    const row = parseRow(this.db.prepare(`SELECT command_id, immutable_json, immutable_hash, payload_json, payload_hash, status, claim_token, claim_executor_id, claim_generation, claim_expires_at, effect_id, lease_id, parent_authority_id, attempt_id, map_node_id FROM commands WHERE command_id = ?`).get(commandId));
    return row ? this.toRecord(row) : undefined;
  }

  readRun(runId: string): KernelRunProjection {
    z.string().min(1).parse(runId);
    const ownershipRow = this.db.prepare(`SELECT bytes FROM ownership WHERE run_id = ?`).get(runId) as { bytes: string } | undefined;
    const ownership = ownershipRow ? orchestratorLeaseSchema.parse(JSON.parse(ownershipRow.bytes)) : undefined;
    const rows = this.db.prepare(`SELECT command_id, immutable_json, immutable_hash, payload_json, payload_hash, status, claim_token, claim_executor_id, claim_generation, claim_expires_at, effect_id, lease_id, parent_authority_id, attempt_id, map_node_id FROM commands WHERE run_id = ? ORDER BY command_id`).all(runId);
    const parsedRows = rows.map((row) => parseRow(row)!);
    const commands = parsedRows.map((row) => this.toRecord(row));
    const attemptIds = [...new Set(parsedRows.map((row) => row.attempt_id ?? undefined).filter((id): id is string => Boolean(id)))];
    const attempts = attemptIds.flatMap((attemptId) => {
      const row = this.db.prepare(`SELECT bytes FROM attempts WHERE attempt_id = ?`).get(attemptId) as { bytes: string } | undefined;
      return row ? [attemptSchema.parse(JSON.parse(row.bytes))] : [];
    });
    const attemptLifecycles = attemptIds.flatMap((attemptId) => {
      const row = this.db.prepare(`SELECT state FROM attempt_lifecycle WHERE attempt_id = ?`).get(attemptId) as { state: string } | undefined;
      return row ? [{ attemptId, state: row.state }] : [];
    });
    const leaseIds = [...new Set(parsedRows.map((row) => row.lease_id ?? undefined).filter((id): id is string => Boolean(id)))];
    const autonomyLeases = leaseIds.flatMap((leaseId) => {
      const row = this.db.prepare(`SELECT bytes, revoked FROM autonomy_leases WHERE lease_id = ?`).get(leaseId) as { bytes: string; revoked: number } | undefined;
      return row ? [{ lease: autonomyLeaseSchema.parse(JSON.parse(row.bytes)), revoked: row.revoked === 1 }] : [];
    });
    const reservationRows = this.db.prepare(`SELECT command_id, lease_id, pool_id, unit, reserved, settled_actual, state, repository_id, map_node_id FROM resource_reservations WHERE command_id IN (SELECT command_id FROM commands WHERE run_id = ?) ORDER BY command_id`).all(runId) as Array<{
      command_id: string; lease_id: string; pool_id: string; unit: string; reserved: number; settled_actual: number | null; state: string; repository_id: string | null; map_node_id: string | null;
    }>;
    const reservations = reservationRows.map((row) => ({
      commandId: row.command_id, leaseId: row.lease_id, poolId: row.pool_id, unit: row.unit, reserved: row.reserved,
      ...(row.settled_actual === null ? {} : { settledActual: row.settled_actual }), state: row.state,
      ...(row.repository_id ? { repositoryId: row.repository_id } : {}), ...(row.map_node_id ? { mapNodeId: row.map_node_id } : {}),
    }));
    return { ...(ownership ? { ownership } : {}), commands, attempts, attemptLifecycles, autonomyLeases, reservations };
  }

  storeLease(lease: AutonomyLease): void {
    if (Date.parse(lease.issuedAt) > Date.parse(this.safeNow())) throw new Error('autonomy lease issuance cannot be in the future');
    const bytes = JSON.stringify(lease);
    this.transaction(() => {
      this.assertWithinHumanGrant(lease);
      const existing = this.db.prepare(`SELECT bytes FROM autonomy_leases WHERE lease_id = ?`).get(lease.leaseId) as { bytes: string } | undefined;
      if (existing && existing.bytes !== bytes) throw new Error('lease issuance is immutable; renewal needs a new lease identity');
      if (!existing) this.db.prepare(`INSERT INTO autonomy_leases (lease_id, revision, bytes) VALUES (?, ?, ?)`).run(lease.leaseId, lease.revision, bytes);
    });
  }

  revokeLease(leaseId: string): void {
    const result = this.db.prepare(`UPDATE autonomy_leases SET revoked = 1 WHERE lease_id = ?`).run(leaseId);
    if (!result.changes) throw new Error('unknown autonomy lease');
  }

  declareHumanAuthority(input: HumanAuthorityGrant): void {
    const grant = humanAuthorityGrantSchema.parse(input);
    this.transaction(() => {
      const bytes = JSON.stringify(grant);
      const existing = this.db.prepare(`SELECT bytes FROM human_authorities WHERE authority_id = ?`).get(grant.authorityId) as { bytes: string } | undefined;
      if (existing && existing.bytes !== bytes) throw new Error('human authority grants are immutable');
      if (!existing) this.db.prepare(`INSERT INTO human_authorities (authority_id, bytes) VALUES (?, ?)`).run(grant.authorityId, bytes);
    });
  }

  issueHumanReserveException(input: HumanReserveException): void {
    const exception = humanReserveExceptionSchema.parse(input);
    this.transaction(() => {
      if (!this.db.prepare(`SELECT authority_id FROM human_authorities WHERE authority_id = ?`).get(exception.authorityId)) throw new Error('reserve exception parent authority is absent');
      const bytes = JSON.stringify(exception);
      const existing = this.db.prepare(`SELECT bytes FROM human_reserve_exceptions WHERE exception_id = ?`).get(exception.exceptionId) as { bytes: string } | undefined;
      if (existing && existing.bytes !== bytes) throw new Error('human reserve exception is immutable');
      if (!existing) this.db.prepare(`INSERT INTO human_reserve_exceptions (exception_id, bytes) VALUES (?, ?)`).run(exception.exceptionId, bytes);
    });
  }

  putModelFact(input: ModelFact): void {
    const fact = modelFactSchema.parse(input);
    this.transaction(() => {
      const bytes = JSON.stringify(fact);
      const current = this.db.prepare(`SELECT bytes FROM model_facts WHERE model_id = ?`).get(fact.modelId) as { bytes: string } | undefined;
      const versioned = this.db.prepare(`SELECT MAX(fact_version) AS fact_version FROM model_fact_versions WHERE model_id = ?`).get(fact.modelId) as { fact_version: number | null };
      if (current && versioned.fact_version === null) {
        // Preserve a pre-versioned Wave 2 fact as a historical, unusable v0 row.
        this.db.prepare(`INSERT INTO model_fact_versions (model_id, fact_version, bytes) VALUES (?, 0, ?)`).run(fact.modelId, current.bytes);
      }
      const currentVersion = versioned.fact_version ?? 0;
      const existing = this.db.prepare(`SELECT bytes FROM model_fact_versions WHERE model_id = ? AND fact_version = ?`).get(fact.modelId, fact.factVersion) as { bytes: string } | undefined;
      if (existing && existing.bytes !== bytes) throw new Error('model fact snapshot version is immutable');
      if (fact.factVersion !== currentVersion + 1 && !existing) throw new Error('model fact version must advance by one from the current fact');
      if (!existing) this.db.prepare(`INSERT INTO model_fact_versions (model_id, fact_version, bytes) VALUES (?, ?, ?)`).run(fact.modelId, fact.factVersion, bytes);
      if (!current) this.db.prepare(`INSERT INTO model_facts (model_id, bytes) VALUES (?, ?)`).run(fact.modelId, bytes);
      else if (fact.factVersion > currentVersion) this.db.prepare(`UPDATE model_facts SET bytes = ? WHERE model_id = ?`).run(bytes, fact.modelId);
    });
  }

  requestCancellation(commandId: string): void {
    this.transaction(() => {
      this.requireCommand(commandId);
      this.db.prepare(`UPDATE command_lifecycle SET cancel_requested = 1 WHERE command_id = ?`).run(commandId);
      this.appendGeneratedEvent('command.cancel_requested', commandId, {});
    });
  }

  reportWorkerStop(commandId: string, observed: 'stopped' | 'pending' | 'unknown'): void {
    this.transaction(() => {
      const row = this.requireCommand(commandId);
      this.db.prepare(`UPDATE command_lifecycle SET stop_observed = ? WHERE command_id = ?`).run(observed, commandId);
      if (observed === 'stopped' && row.status === 'claimed') {
        this.db.prepare(`UPDATE commands SET status = 'refused', claim_token = NULL, claim_executor_id = NULL, claim_expires_at = NULL WHERE command_id = ?`).run(commandId);
        this.settleReservation(commandId, { state: 'known', amount: 0 });
      } else if ((observed === 'stopped' || observed === 'pending' || observed === 'unknown') && (row.status === 'claimed' || row.status === 'effect_started' || row.status === 'observing')) {
        this.db.prepare(`UPDATE commands SET status = 'unknown', claim_token = NULL, claim_executor_id = NULL, claim_expires_at = NULL WHERE command_id = ?`).run(commandId);
      }
      if (observed === 'pending' || observed === 'unknown') this.quarantineAttempt(commandId);
      this.appendGeneratedEvent(`worker.stop_${observed}`, commandId, {});
    });
  }

  reportAttemptStop(attemptId: string, observed: 'stopped' | 'pending' | 'unknown'): void {
    z.string().min(1).parse(attemptId);
    this.transaction(() => {
      const attempt = this.db.prepare(`SELECT state FROM attempt_lifecycle WHERE attempt_id = ?`).get(attemptId) as { state: string } | undefined;
      if (!attempt) throw new Error('unknown worker attempt');
      if (observed === 'stopped') {
        const unsettled = this.db.prepare(`SELECT COUNT(*) AS count FROM commands WHERE attempt_id = ? AND status IN ('claimed', 'effect_started', 'observing', 'unknown')`).get(attemptId) as { count: number };
        if (unsettled.count) throw new Error('worker attempt cannot finish before its commands are observed');
        // A host's explicit terminal observation may resolve a previously quarantined
        // attempt, but never substitutes for observing the commands it could have spent.
        this.db.prepare(`UPDATE attempt_lifecycle SET state = 'finished' WHERE attempt_id = ? AND state IN ('ready', 'active', 'unknown')`).run(attemptId);
      } else {
        this.db.prepare(`UPDATE attempt_lifecycle SET state = 'unknown' WHERE attempt_id = ? AND state IN ('ready', 'active')`).run(attemptId);
      }
    });
  }

  settleResource(commandId: string, actual: { state: 'known'; amount: number } | { state: 'unknown' | 'unavailable' }): void {
    this.transaction(() => this.settleReservation(commandId, actual));
  }

  acquireOwnership(lease: OrchestratorLease, expectedEpoch: number): OrchestratorLease {
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT epoch FROM ownership WHERE run_id = ?`).get(lease.runId) as { epoch: number } | undefined;
      const currentEpoch = current?.epoch ?? 0;
      if (currentEpoch !== expectedEpoch || lease.epoch !== expectedEpoch + 1) throw new Error('ownership epoch compare-and-swap refused');
      const bytes = JSON.stringify(lease);
      if (current) this.db.prepare(`UPDATE ownership SET lease_id = ?, owner = ?, session_id = ?, epoch = ?, bytes = ? WHERE run_id = ? AND epoch = ?`).run(lease.leaseId, lease.owner, lease.sessionId, lease.epoch, bytes, lease.runId, expectedEpoch);
      else this.db.prepare(`INSERT INTO ownership (run_id, lease_id, owner, session_id, epoch, bytes) VALUES (?, ?, ?, ?, ?, ?)`).run(lease.runId, lease.leaseId, lease.owner, lease.sessionId, lease.epoch, bytes);
      return lease;
    });
  }

  assertCurrentOwner(input: OrchestratorLease): OrchestratorLease {
    const stored = this.db.prepare(`SELECT bytes FROM ownership WHERE run_id = ?`).get(input.runId) as { bytes: string } | undefined;
    if (!stored) throw new Error('orchestrator ownership is absent');
    const current = orchestratorLeaseSchema.parse(JSON.parse(stored.bytes));
    if (current.leaseId !== input.leaseId || current.owner !== input.owner || current.sessionId !== input.sessionId || current.epoch !== input.epoch) throw new Error('orchestrator ownership is stale');
    const now = this.safeNow();
    if (Date.parse(current.issuedAt) > Date.parse(now) || isExpired(current.expiresAt, now)) throw new Error('orchestrator ownership lease is inactive');
    return current;
  }

  recoverInterrupted(runId?: string): void {
    if (runId !== undefined) z.string().min(1).parse(runId);
    this.transaction(() => {
      const rows = (runId === undefined
        ? this.db.prepare(`SELECT command_id, status FROM commands WHERE status IN ('claimed', 'effect_started', 'observing')`).all()
        : this.db.prepare(`SELECT command_id, status FROM commands WHERE run_id = ? AND status IN ('claimed', 'effect_started', 'observing')`).all(runId)) as Array<{ command_id: string; status: CommandStatus }>;
      for (const row of rows) {
        const next = row.status === 'claimed' ? 'queued' : 'unknown';
        this.db.prepare(`UPDATE commands SET status = ?, claim_token = NULL, claim_expires_at = NULL WHERE command_id = ?`).run(next, row.command_id);
        this.appendGeneratedEvent(`command.recovered_${next}`, row.command_id, {});
      }
    });
  }

  private assertAuthority(command: Command, caller?: TrustedCaller): void {
    const stored = this.db.prepare(`SELECT revision, bytes, revoked FROM autonomy_leases WHERE lease_id = ?`).get(command.leaseId) as { revision: number; bytes: string; revoked: number } | undefined;
    if (!stored || stored.revoked) throw new Error('autonomy lease is absent or revoked');
    const lease = autonomyLeaseSchema.parse(JSON.parse(stored.bytes));
    if (lease.revision !== command.leaseRevision || stored.revision !== command.leaseRevision) throw new Error('autonomy lease revision mismatch');
    const currentTime = this.safeNow();
    if (isExpired(command.notAfter, currentTime)) throw new Error('command is expired');
    if (isExpired(lease.expiresAt, currentTime)) throw new Error('autonomy lease is expired');
    if (lease.scope.repositoryId !== command.scope.repositoryId
      || (lease.scope.mapNodeIds.length > 0 && !command.scope.mapNodeId)
      || (command.scope.mapNodeId && !lease.scope.mapNodeIds.includes(command.scope.mapNodeId))) throw new Error('autonomy lease scope refuses command');
    if (!lease.allowedActions.includes(command.kind)) throw new Error('autonomy lease action refuses command');
    if (command.origin === 'orchestrator') {
      const owner = this.db.prepare(`SELECT lease_id, epoch, session_id, bytes FROM ownership WHERE run_id = ?`).get(command.runId) as { lease_id: string; epoch: number; session_id: string; bytes: string } | undefined;
      if (!owner || owner.lease_id !== command.orchestratorLeaseId || owner.epoch !== command.orchestratorEpoch) throw new Error('orchestrator ownership epoch is stale');
      const ownershipLease = orchestratorLeaseSchema.parse(JSON.parse(owner.bytes));
      if (Date.parse(ownershipLease.issuedAt) > Date.parse(currentTime) || isExpired(ownershipLease.expiresAt, currentTime)) throw new Error('orchestrator ownership lease is inactive');
      if (caller && caller.sessionId !== owner.session_id) throw new Error('authenticated caller session does not own orchestrator lease');
    }
  }

  private attemptIdFor(command: Command, caller: TrustedCaller): string | undefined {
    if (command.origin !== 'worker') return undefined;
    if (!caller.attemptId || !z.string().min(1).safeParse(caller.attemptId).success) throw new Error('worker commands require a trusted stable attempt identity');
    return caller.attemptId;
  }

  private loadLease(leaseId: string): AutonomyLease {
    const row = this.db.prepare(`SELECT bytes FROM autonomy_leases WHERE lease_id = ?`).get(leaseId) as { bytes: string } | undefined;
    if (!row) throw new Error('autonomy lease is absent');
    return autonomyLeaseSchema.parse(JSON.parse(row.bytes));
  }

  private loadGrant(authorityId: string): HumanAuthorityGrant {
    const row = this.db.prepare(`SELECT bytes FROM human_authorities WHERE authority_id = ?`).get(authorityId) as { bytes: string } | undefined;
    if (!row) throw new Error('autonomy lease parent authority is absent or not human-delegated');
    return humanAuthorityGrantSchema.parse(JSON.parse(row.bytes));
  }

  private bindAttempt(command: Command, lease: AutonomyLease, attemptId: string): void {
    if (!command.scope.mapNodeId) throw new Error('worker commands require a map node scope for their attempt');
    const current = this.db.prepare(`SELECT parent_authority_id, repository_id, map_node_id, state FROM attempt_lifecycle WHERE attempt_id = ?`).get(attemptId) as { parent_authority_id: string; repository_id: string; map_node_id: string; state: string } | undefined;
    if (current && (current.parent_authority_id !== lease.parentAuthorityId || current.repository_id !== command.scope.repositoryId || current.map_node_id !== command.scope.mapNodeId)) throw new Error('trusted attempt identity is already bound to another authority scope');
    if (current && current.state !== 'ready' && current.state !== 'active') throw new Error('worker attempt is no longer active');
    if (!current) {
      const grant = this.loadGrant(lease.parentAuthorityId);
      const parentCount = this.attemptCount(`parent_authority_id = ? AND repository_id = ? AND map_node_id = ?`, [lease.parentAuthorityId, command.scope.repositoryId, command.scope.mapNodeId]);
      if (parentCount >= grant.maxAttemptsPerNode) throw new Error('human attempt cap refuses command');
      this.db.prepare(`INSERT INTO attempt_lifecycle (attempt_id, parent_authority_id, repository_id, map_node_id, state) VALUES (?, ?, ?, ?, 'ready')`).run(attemptId, lease.parentAuthorityId, command.scope.repositoryId, command.scope.mapNodeId);
    }
    const membership = this.db.prepare(`SELECT 1 FROM attempt_leases WHERE attempt_id = ? AND lease_id = ?`).get(attemptId, lease.leaseId);
    if (!membership) {
      const leaseCount = this.attemptCount(
        `attempt_id IN (
          SELECT al.attempt_id FROM attempt_lifecycle al
          JOIN attempt_leases memberships ON memberships.attempt_id = al.attempt_id
          WHERE memberships.lease_id = ? AND al.parent_authority_id = ? AND al.repository_id = ? AND al.map_node_id = ?
        )`,
        [lease.leaseId, lease.parentAuthorityId, command.scope.repositoryId, command.scope.mapNodeId],
      );
      if (leaseCount >= lease.maxAttemptsPerNode) throw new Error('autonomy lease attempt cap refuses command');
      this.db.prepare(`INSERT INTO attempt_leases (attempt_id, lease_id) VALUES (?, ?)`).run(attemptId, lease.leaseId);
    }
  }

  private attemptCount(where: string, values: unknown[]): number {
    const row = this.db.prepare(`SELECT COUNT(DISTINCT attempt_id) AS count FROM attempt_lifecycle WHERE ${where}`).get(...values) as { count: number };
    return row.count;
  }

  private attemptStateForCommand(commandId: string): { attempt_id: string; state: string } | undefined {
    return this.db.prepare(`SELECT c.attempt_id, al.state FROM commands c JOIN attempt_lifecycle al ON al.attempt_id = c.attempt_id WHERE c.command_id = ?`).get(commandId) as { attempt_id: string; state: string } | undefined;
  }

  private activeAttemptCount(where: string, values: unknown[]): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM attempt_lifecycle al WHERE ${where} AND al.state IN ('active', 'unknown')`).get(...values) as { count: number };
    return row.count;
  }

  private activateAttempt(commandId: string): void {
    const attempt = this.attemptStateForCommand(commandId);
    if (!attempt) return;
    if (attempt.state !== 'ready' && attempt.state !== 'active') throw new Error('worker attempt is no longer active');
    if (attempt.state === 'ready') this.db.prepare(`UPDATE attempt_lifecycle SET state = 'active' WHERE attempt_id = ? AND state = 'ready'`).run(attempt.attempt_id);
  }

  private quarantineAttempt(commandId: string): void {
    const attempt = this.attemptStateForCommand(commandId);
    if (attempt) this.db.prepare(`UPDATE attempt_lifecycle SET state = 'unknown' WHERE attempt_id = ? AND state IN ('ready', 'active')`).run(attempt.attempt_id);
  }

  private assertWithinHumanGrant(lease: AutonomyLease): void {
    const row = this.db.prepare(`SELECT bytes FROM human_authorities WHERE authority_id = ?`).get(lease.parentAuthorityId) as { bytes: string } | undefined;
    if (!row) throw new Error('autonomy lease parent authority is absent or not human-delegated');
    const grant = humanAuthorityGrantSchema.parse(JSON.parse(row.bytes));
    if (grant.repositoryId !== lease.scope.repositoryId || Date.parse(lease.expiresAt) > Date.parse(grant.expiresAt)) throw new Error('autonomy lease exceeds human authority scope or expiry');
    if (grant.mapNodeIds.length && (lease.scope.mapNodeIds.length === 0 || lease.scope.mapNodeIds.some((node) => !grant.mapNodeIds.includes(node)))) throw new Error('autonomy lease exceeds human map scope');
    if (lease.allowedActions.some((action) => !grant.allowedActions.includes(action))) throw new Error('autonomy lease exceeds human action authority');
    if (lease.maxConcurrency > grant.maxConcurrency || lease.maxAttemptsPerNode > grant.maxAttemptsPerNode) throw new Error('autonomy lease exceeds human execution limits');
    for (const limit of lease.poolLimits) {
      const parent = grant.poolLimits.find((item) => item.poolId === limit.poolId && item.unit === limit.unit);
      if (!parent || limit.limit > parent.limit) throw new Error('autonomy lease exceeds human resource pool limit');
    }
    for (const reserve of grant.protectedReserves) {
      const delegated = lease.protectedReserves.find((item) => item.poolId === reserve.poolId && item.unit === reserve.unit);
      if (!delegated || delegated.amount < reserve.amount) throw new Error('autonomy lease weakens a human protected reserve');
    }
  }

  private assertLegalModelSelection(kind: KernelKind, payload: unknown): void {
    const selection = kind.modelSelection?.(payload);
    if (!selection) return;
    this.assertLegalModel(selection, kind.resourceRequest?.(payload));
  }

  private assertLegalModel(selection: { modelId: string; requiredCapabilities: readonly string[]; role: string; dataClassification?: 'public' | 'restricted' }, request?: ResourceRequest): void {
    const row = this.db.prepare(`SELECT bytes FROM model_facts WHERE model_id = ?`).get(selection.modelId) as { bytes: string } | undefined;
    if (!row) throw new Error('model selection has no registered facts');
    const fact = modelFactSchema.parse(JSON.parse(row.bytes));
    if (!fact.enabled) throw new Error('model selection is disabled');
    if (fact.availability !== 'known_available') throw new Error('model selection availability is not known available');
    if (!fact.roles.includes(selection.role)) throw new Error('model selection lacks required role');
    const capabilities = fact.capabilitiesByRole ? fact.capabilitiesByRole[selection.role] ?? [] : fact.capabilities;
    if (fact.dataPolicy && !selection.dataClassification) throw new Error('model selection data classification is unknown');
    if (selection.dataClassification === 'restricted' && fact.dataPolicy !== 'restricted-ok') throw new Error('model selection data policy refuses restricted context');
    if (selection.requiredCapabilities.some((capability) => !capabilities.includes(capability))) throw new Error('model selection lacks required capability');
    if (request && fact.poolId !== request.poolId) throw new Error('model selection pool does not match the requested resource pool');
  }

  private assertNotCancelled(commandId: string): void {
    const lifecycle = this.db.prepare(`SELECT cancel_requested FROM command_lifecycle WHERE command_id = ?`).get(commandId) as { cancel_requested: number } | undefined;
    if (lifecycle?.cancel_requested) throw new Error('command cancellation was requested');
  }

  private assertConcurrency(command: Command): void {
    const lease = this.loadLease(command.leaseId);
    const grant = this.loadGrant(lease.parentAuthorityId);
    const attempt = this.attemptStateForCommand(command.commandId);
    if (attempt?.state === 'unknown' || attempt?.state === 'finished') throw new Error('worker attempt is no longer active');
    const activeForLease = this.activeAttemptCount('al.attempt_id IN (SELECT attempt_id FROM attempt_leases WHERE lease_id = ?)', [command.leaseId]);
    // A continuing active attempt consumes one slot in every lease it joins. It
    // may reuse its own existing slot, but cannot enlarge a narrower lease.
    if (activeForLease > lease.maxConcurrency || (attempt?.state !== 'active' && activeForLease >= lease.maxConcurrency)) throw new Error('autonomy lease concurrency cap refuses command');
    const activeForAuthority = this.activeAttemptCount('al.parent_authority_id = ?', [lease.parentAuthorityId]);
    if (attempt?.state !== 'active' && activeForAuthority >= grant.maxConcurrency) throw new Error('human authority concurrency cap refuses command');
  }

  private reserve(command: Command, input: ResourceRequest, attemptId: string | undefined): void {
    const request = resourceRequestSchema.parse(input);
    if (command.origin === 'worker' && !attemptId) throw new Error('resource requests require a trusted stable attempt identity');
    const lease = this.loadLease(command.leaseId);
    const grant = this.loadGrant(lease.parentAuthorityId);
    const pool = lease.poolLimits.find((limit) => limit.poolId === request.poolId && limit.unit === request.unit);
    const parentPool = grant.poolLimits.find((limit) => limit.poolId === request.poolId && limit.unit === request.unit);
    if (!pool || !parentPool) throw new Error('resource pool is outside autonomy authority');
    const used = this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN settled_actual ELSE reserved END), 0) AS total FROM resource_reservations WHERE parent_authority_id = ? AND pool_id = ? AND unit = ?`).get(lease.parentAuthorityId, request.poolId, request.unit) as { total: number };
    const reserve = Math.max(
      grant.protectedReserves.find((item) => item.poolId === request.poolId && item.unit === request.unit)?.amount ?? 0,
      lease.protectedReserves.find((item) => item.poolId === request.poolId && item.unit === request.unit)?.amount ?? 0,
    );
    const effectivePoolLimit = Math.min(pool.limit, parentPool.limit);
    if (used.total + request.upperBound > effectivePoolLimit) throw new Error('resource pool cap refuses reservation');
    if (request.consumer !== 'orchestrator' && reserve > 0 && used.total + request.upperBound > effectivePoolLimit - reserve) this.consumeReserveException(request, command, lease, grant);
    this.db.prepare(`INSERT INTO resource_reservations (command_id, lease_id, parent_authority_id, pool_id, unit, reserved, state, attempt_id, repository_id, map_node_id) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`).run(command.commandId, command.leaseId, lease.parentAuthorityId, request.poolId, request.unit, request.upperBound, attemptId ?? null, command.scope.repositoryId, command.scope.mapNodeId ?? null);
    this.appendGeneratedEvent('resource.reserved', command.commandId, { poolId: request.poolId, unit: request.unit, upperBound: request.upperBound, consumer: request.consumer });
  }

  private consumeReserveException(request: ResourceRequest, command: Command, lease: AutonomyLease, grant: HumanAuthorityGrant): void {
    if (!request.humanOverrideId) throw new Error('protected orchestrator reserve requires a human reserve exception');
    const row = this.db.prepare(`SELECT bytes, consumed_by_command_id FROM human_reserve_exceptions WHERE exception_id = ?`).get(request.humanOverrideId) as { bytes: string; consumed_by_command_id: string | null } | undefined;
    if (!row || row.consumed_by_command_id) throw new Error('human reserve exception is absent or already consumed');
    const exception = humanReserveExceptionSchema.parse(JSON.parse(row.bytes));
    if (exception.authorityId !== grant.authorityId || exception.repositoryId !== command.scope.repositoryId || exception.leaseId !== lease.leaseId || exception.poolId !== request.poolId || exception.unit !== request.unit || request.upperBound > exception.maxAmount || isExpired(exception.expiresAt, this.safeNow())) throw new Error('human reserve exception does not authorise this reservation');
    this.db.prepare(`UPDATE human_reserve_exceptions SET consumed_by_command_id = ? WHERE exception_id = ? AND consumed_by_command_id IS NULL`).run(command.commandId, exception.exceptionId);
  }

  private settleReservation(commandId: string, actual: { state: 'known'; amount: number } | { state: 'unknown' | 'unavailable' }): void {
    const reservation = this.db.prepare(`SELECT r.reserved, r.state, c.status, c.effect_id FROM resource_reservations r JOIN commands c ON c.command_id = r.command_id WHERE r.command_id = ?`).get(commandId) as { reserved: number; state: string; status: CommandStatus; effect_id: string | null } | undefined;
    if (!reservation || reservation.state !== 'reserved') return;
    const observedAt = this.now();
    if (actual.state !== 'known') {
      this.db.prepare(`INSERT INTO resource_usage_observations (observation_id, command_id, state, amount, observed_at) VALUES (?, ?, ?, NULL, ?)`).run(randomUUID(), commandId, actual.state, observedAt);
      this.appendGeneratedEvent('resource.usage_unknown', commandId, { state: actual.state });
      return;
    }
    if (!Number.isFinite(actual.amount) || actual.amount < 0 || actual.amount > reservation.reserved) throw new Error('observed resource actual is invalid or exceeds reserved upper bound');
    if (reservation.status === 'queued' || reservation.status === 'claimed' || reservation.status === 'effect_started' || reservation.status === 'observing' || reservation.status === 'unknown') throw new Error('resource usage may still spend until a final effect observation is recorded');
    if (reservation.status === 'refused' && reservation.effect_id !== null) throw new Error('resource usage may still spend until a final effect observation is recorded');
    this.db.prepare(`INSERT INTO resource_usage_observations (observation_id, command_id, state, amount, observed_at) VALUES (?, ?, 'known', ?, ?)`).run(randomUUID(), commandId, actual.amount, observedAt);
    this.db.prepare(`UPDATE resource_reservations SET settled_actual = ?, state = 'settled' WHERE command_id = ?`).run(actual.amount, commandId);
    this.appendGeneratedEvent('resource.settled', commandId, { actual: actual.amount, released: reservation.reserved - actual.amount });
  }

  private setTerminal(commandId: string, input: EffectObservation): EffectObservation {
    const observation = effectObservationSchema.parse(input);
    this.transaction(() => {
      const current = this.requireCommand(commandId);
      if (observation.commandId !== commandId || current.effect_id !== observation.effectId) throw new Error('observation does not match the expected command effect identity');
      if (current.status !== 'effect_started' && current.status !== 'observing' && current.status !== 'unknown') return;
      this.db.prepare(`UPDATE commands SET status = ?, claim_token = NULL, claim_executor_id = NULL, claim_expires_at = NULL WHERE command_id = ? AND status IN ('effect_started', 'observing', 'unknown')`).run(observation.state, commandId);
      this.db.prepare(`INSERT INTO effect_observations (observation_id, command_id, bytes) VALUES (?, ?, ?)`).run(randomUUID(), commandId, JSON.stringify(observation));
      this.appendGeneratedEvent(`command.${observation.state}`, commandId, { effectId: observation.effectId, source: observation.source, observedAt: observation.observedAt, evidenceRefs: observation.evidenceRefs });
    });
    const current = this.requireCommand(commandId);
    return current.status === 'succeeded' || current.status === 'failed' || current.status === 'unknown' ? observation : { ...observation, state: 'unknown' };
  }

  private assertCurrentClaim(row: CommandRow, claim: Claim, executor: TrustedExecutor): void {
    if (row.status !== 'claimed' || row.claim_token !== claim.token || row.claim_executor_id !== claim.executorId || claim.executorId !== executor.executorId || row.claim_generation !== claim.generation || row.claim_expires_at !== claim.expiresAt) throw new Error('claim is stale');
    if (isExpired(claim.expiresAt, this.safeNow())) throw new Error('claim is expired');
  }

  private refuseIfCurrent(commandId: string, claim: Claim, executor: TrustedExecutor, reason: string): void {
    try {
      this.transaction(() => {
        const current = this.requireCommand(commandId);
        if (current.status !== 'claimed' || current.claim_token !== claim.token || current.claim_executor_id !== executor.executorId || current.claim_generation !== claim.generation) return;
        this.db.prepare(`UPDATE commands SET status = 'refused', claim_token = NULL, claim_executor_id = NULL, claim_expires_at = NULL WHERE command_id = ? AND status = 'claimed' AND claim_token = ? AND claim_generation = ?`).run(commandId, claim.token, claim.generation);
        this.appendGeneratedEvent('command.refused', commandId, { reason, executorId: executor.executorId, claimGeneration: claim.generation });
      });
    } catch {
      // A refusal record must never overwrite a newer claimant or terminal result.
    }
  }

  private requireCommand(commandId: string): CommandRow {
    const row = parseRow(this.db.prepare(`SELECT command_id, immutable_json, immutable_hash, payload_json, payload_hash, status, claim_token, claim_executor_id, claim_generation, claim_expires_at, effect_id FROM commands WHERE command_id = ?`).get(commandId));
    if (!row) throw new Error('unknown command');
    return row;
  }

  private parseCommand(row: CommandRow): Command {
    if (exactHash(row.immutable_json) !== row.immutable_hash || exactHash(row.payload_json) !== row.payload_hash) {
      throw new Error('persisted command bytes fail integrity verification');
    }
    const command = commandSchema.parse(JSON.parse(row.immutable_json));
    if (JSON.stringify(command.payload) !== row.payload_json || command.payloadHash !== row.payload_hash) {
      throw new Error('persisted payload does not match immutable command');
    }
    return command;
  }

  private toRecord(row: CommandRow): CommandRecord {
    const command = this.parseCommand(row);
    const claim = row.claim_token && row.claim_expires_at && row.claim_executor_id ? { commandId: row.command_id, executorId: row.claim_executor_id, token: row.claim_token, generation: row.claim_generation, expiresAt: row.claim_expires_at } : undefined;
    const observations = this.db.prepare(`SELECT bytes FROM effect_observations WHERE command_id = ? ORDER BY rowid`).all(row.command_id)
      .map((item) => effectObservationSchema.parse(JSON.parse((item as { bytes: string }).bytes)));
    return { command, status: row.status, immutableHash: row.immutable_hash, claim, observations };
  }

  private appendGeneratedEvent(kind: string, commandId: string, payload: unknown): void {
    const now = this.now();
    const event = eventSchema.parse({ eventId: randomUUID(), schemaVersion: 1, kind, source: 'kernel', sourceEventId: randomUUID(), occurredAt: now, recordedAt: now, commandId, correlationId: commandId, payload });
    this.insertEvent(event, JSON.stringify(event));
  }

  private insertEvent(event: Event, bytes: string): void {
    const existing = this.db.prepare(`SELECT bytes FROM events WHERE source = ? AND source_event_id = ?`).get(event.source, event.sourceEventId) as { bytes: string } | undefined;
    if (existing) {
      if (existing.bytes !== bytes) throw new Error('event source identity collision has different bytes');
      return;
    }
    this.db.prepare(`INSERT INTO events (event_id, source, source_event_id, bytes) VALUES (?, ?, ?, ?)`).run(event.eventId, event.source, event.sourceEventId, bytes);
  }

  private safeNow(): string {
    const current = this.now();
    const highwater = this.db.prepare(`SELECT observed_at FROM clock_highwater WHERE name = 'kernel'`).get() as { observed_at: string } | undefined;
    if (highwater && Date.parse(current) < Date.parse(highwater.observed_at)) throw new Error('wall clock moved backwards; effect authority is refused');
    if (!highwater) this.db.prepare(`INSERT INTO clock_highwater (name, observed_at) VALUES ('kernel', ?)`).run(current);
    else if (Date.parse(current) > Date.parse(highwater.observed_at)) this.db.prepare(`UPDATE clock_highwater SET observed_at = ? WHERE name = 'kernel'`).run(current);
    return current;
  }

  /** Older Wave 2 databases can be opened without losing their durable rows. */
  private addColumn(table: 'commands' | 'resource_reservations', definition: string): void {
    const name = definition.split(' ', 1)[0];
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === name)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
