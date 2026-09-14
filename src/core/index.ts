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
import { z, type ZodType } from 'zod';

type Statement = { run(...values: unknown[]): { changes?: number }; get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] };
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
type DatabaseConstructor = new (path: string, options?: { timeout?: number }) => Database;
const require = createRequire(__filename);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseConstructor };

export type TrustedCaller = { actorId: string; sessionId?: string; allowedOrigins: readonly CommandOrigin[] };
export type KernelKind = { payloadSchema: ZodType<unknown>; requiresResourceEnforcement?: boolean };
export type KernelOptions = {
  databasePath: string;
  kinds: Readonly<Record<string, KernelKind>>;
  now?: () => string;
};
export type TrustedExecutor = { executorId: string };
export type Claim = { commandId: string; executorId: string; token: string; generation: number; expiresAt: string };
export type CommandStatus = 'queued' | 'claimed' | 'effect_started' | 'observing' | 'succeeded' | 'failed' | 'refused' | 'unknown';
export type CommandRecord = { command: Command; status: CommandStatus; immutableHash: string; claim?: Claim; observations: EffectObservation[] };
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

  issueAutonomyLease(lease: AutonomyLease): void {
    this.core.storeLease(autonomyLeaseSchema.parse(lease));
  }

  revokeAutonomyLease(leaseId: string): void {
    this.core.revokeLease(leaseId);
  }

  acquireOwnership(lease: OrchestratorLease, expectedEpoch: number): OrchestratorLease {
    return this.core.acquireOwnership(orchestratorLeaseSchema.parse(lease), expectedEpoch);
  }

  recoverAfterRestart(): void { this.core.recoverInterrupted(); }
  close(): void { this.core.close(); }
  admit(intent: unknown, caller: TrustedCaller): CommandRecord { return this.core.admit(intent, caller); }
  claim(commandId: string, executor: TrustedExecutor, expiresAt: string): Claim { return this.core.claim(commandId, executor, expiresAt); }
  perform(commandId: string, claim: Claim, executor: TrustedExecutor, readFact: (precondition: Precondition) => Promise<Observation<boolean>>, effect: KernelEffect): Promise<EffectObservation> { return this.core.perform(commandId, claim, executor, readFact, effect); }
  recordObservation(commandId: string, observation: EffectObservation): void { this.core.recordObservation(commandId, observation); }
  appendEvent(event: Event): void { this.core.appendEvent(event); }
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
    `);
  }

  close(): void { this.db.close(); }

  admit(intent: unknown, caller: TrustedCaller): CommandRecord {
    const envelope = commandSchema.parse(intent);
    if (!caller.allowedOrigins.includes(envelope.origin)) throw new Error('trusted caller cannot submit this origin');
    const command = parseExecutableCommand({ ...envelope, actorId: caller.actorId }, this.registry);
    const kind = this.kinds[command.kind];
    if (!kind) throw new Error(`unsupported command kind: ${command.kind}`);
    if (kind.requiresResourceEnforcement) throw new Error(`resource enforcement is unavailable for command kind: ${command.kind}`);
    const payloadJson = JSON.stringify(command.payload);
    if (exactHash(payloadJson) !== command.payloadHash) throw new Error('payloadHash does not match exact persisted payload bytes');
    const immutableJson = JSON.stringify(command);
    const immutableHash = exactHash(immutableJson);
    return this.transaction(() => {
    this.assertAuthority(command, caller);
      const existing = parseRow(this.db.prepare(`SELECT command_id, immutable_json, immutable_hash, payload_json, payload_hash, status, claim_token, claim_executor_id, claim_generation, claim_expires_at, effect_id FROM commands WHERE run_id = ? AND repository_id = ? AND kind = ? AND idempotency_key = ?`).get(command.runId, command.scope.repositoryId, command.kind, command.idempotencyKey));
      if (existing) {
        if (existing.immutable_json !== immutableJson) throw new Error('idempotency collision has different immutable command bytes');
        return this.toRecord(existing);
      }
      this.db.prepare(`INSERT INTO commands (command_id, run_id, repository_id, kind, idempotency_key, immutable_json, immutable_hash, payload_json, payload_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`).run(
        command.commandId, command.runId, command.scope.repositoryId, command.kind, command.idempotencyKey, immutableJson, immutableHash, payloadJson, exactHash(payloadJson),
      );
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
    const row = parseRow(this.db.prepare(`SELECT command_id, immutable_json, immutable_hash, payload_json, payload_hash, status, claim_token, claim_executor_id, claim_generation, claim_expires_at, effect_id FROM commands WHERE command_id = ?`).get(commandId));
    return row ? this.toRecord(row) : undefined;
  }

  storeLease(lease: AutonomyLease): void {
    if (Date.parse(lease.issuedAt) > Date.parse(this.safeNow())) throw new Error('autonomy lease issuance cannot be in the future');
    const bytes = JSON.stringify(lease);
    this.transaction(() => {
      const existing = this.db.prepare(`SELECT bytes FROM autonomy_leases WHERE lease_id = ?`).get(lease.leaseId) as { bytes: string } | undefined;
      if (existing && existing.bytes !== bytes) throw new Error('lease issuance is immutable; renewal needs a new lease identity');
      if (!existing) this.db.prepare(`INSERT INTO autonomy_leases (lease_id, revision, bytes) VALUES (?, ?, ?)`).run(lease.leaseId, lease.revision, bytes);
    });
  }

  revokeLease(leaseId: string): void {
    const result = this.db.prepare(`UPDATE autonomy_leases SET revoked = 1 WHERE lease_id = ?`).run(leaseId);
    if (!result.changes) throw new Error('unknown autonomy lease');
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

  recoverInterrupted(): void {
    this.transaction(() => {
      const rows = this.db.prepare(`SELECT command_id, status FROM commands WHERE status IN ('claimed', 'effect_started', 'observing')`).all() as Array<{ command_id: string; status: CommandStatus }>;
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

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
