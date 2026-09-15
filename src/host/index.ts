import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attempt, AutonomyLease, Command, Observation, OrchestratorLease, Precondition, RawArtifactRef } from '../contracts/index.js';
import {
  openKernel,
  type CommandRecord,
  type EffectObservation,
  type KernelEffect,
  type HumanAuthorityGrant,
  type KernelKind,
  type KernelRunProjection,
  type TrustedExecutor,
} from '../core/index.js';
import { ArtifactJournal, type ArtifactMetadata } from '../journal/index.js';
import type {
  HelmToolExecutionContext,
  InvocationOutcome,
  OrchestratorArtifacts,
  OrchestratorRecoveryState,
  OrchestratorSessionGuard,
  RecoveryBundle,
} from '../runtime/orchestrator/index.js';
import type { PiAuthority, PiEffect, PiNativeWorker } from '../runtime/pi/index.js';

type ArtifactKind = 'text' | 'invocation' | 'recovery_bundle' | 'recovery_state' | 'effect';
type ArtifactScope = Readonly<{ runId: string; sessionId: string }>;
type StoredArtifactRef = Readonly<{ schemaVersion: 1; kind: ArtifactKind; runId: string; sessionId: string; sourceIdentity: string; raw: RawArtifactRef }>;
type StoredArtifactEnvelope = Readonly<{ schemaVersion: 1; kind: ArtifactKind; runId: string; sessionId: string; text: string }>;

function encodeRef(value: StoredArtifactRef): string { return JSON.stringify(value); }
function isArtifactKind(value: unknown): value is ArtifactKind {
  return value === 'text' || value === 'invocation' || value === 'recovery_bundle' || value === 'recovery_state' || value === 'effect';
}
function decodeRef(value: string): StoredArtifactRef {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid host artifact reference');
  const item = parsed as Partial<StoredArtifactRef>;
  if (item.schemaVersion !== 1 || !isArtifactKind(item.kind)
    || typeof item.runId !== 'string' || !item.runId || typeof item.sessionId !== 'string' || !item.sessionId || typeof item.sourceIdentity !== 'string' || !item.sourceIdentity
    || typeof item.raw !== 'object' || item.raw === null) throw new Error('invalid host artifact reference');
  const raw = item.raw as Partial<RawArtifactRef>;
  if (typeof raw.ref !== 'string' || typeof raw.hash !== 'string' || typeof raw.mediaType !== 'string') throw new Error('invalid host artifact reference');
  return { schemaVersion: 1, kind: item.kind as ArtifactKind, runId: item.runId, sessionId: item.sessionId, sourceIdentity: item.sourceIdentity, raw: { ref: raw.ref, hash: raw.hash, mediaType: raw.mediaType } };
}
function decodeEnvelope(value: unknown): StoredArtifactEnvelope {
  if (typeof value !== 'object' || value === null) throw new Error('host artifact bytes lack a trusted scope envelope');
  const envelope = value as Partial<StoredArtifactEnvelope>;
  if (envelope.schemaVersion !== 1 || !isArtifactKind(envelope.kind) || typeof envelope.runId !== 'string' || !envelope.runId
    || typeof envelope.sessionId !== 'string' || !envelope.sessionId || typeof envelope.text !== 'string') {
    throw new Error('host artifact bytes lack a trusted scope envelope');
  }
  return envelope as StoredArtifactEnvelope;
}
function validRefs(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

/** A trusted adapter supplies effects; the host never shells out or starts a provider itself. */
export interface HostRuntime {
  createEffect(input: Readonly<{ command: Command; artifacts: HostArtifactStore }>): Promise<KernelEffect> | KernelEffect;
}

/**
 * Structural seam for the existing PiNativeWorker lifecycle. Production code
 * supplies an adapter that starts/runs/cancels Pi and returns its observed
 * artifact references; this package deliberately contains no provider setup.
 */
export interface PiLifecycleBinding extends HostRuntime {}

export type PiEffectAuthorityOptions = Readonly<{
  attemptId: string;
  actorId: string;
  executorId: string;
  commandForEffect(effect: PiEffect): unknown;
  /** A trusted runtime may settle an actually observed amount; the host never invents one. */
  observedSettlement?(effect: PiEffect): { state: 'known'; amount: number } | { state: 'unknown' | 'unavailable' } | undefined;
}>;
export type PiWorkerBinding = Readonly<{
  authority(): PiAuthority;
  start(input: Readonly<{ command: Command; journal: ArtifactJournal; authority: PiAuthority }>): Promise<PiNativeWorker>;
  prompt(command: Command): string;
  correction(command: Command): string;
}>;

/** A real Pi-native host runtime; callers inject the narrow, already-authorised worker setup. */
export class PiNativeRuntime implements HostRuntime {
  constructor(private readonly binding: PiWorkerBinding) {}

  async createEffect(input: Readonly<{ command: Command; artifacts: HostArtifactStore }>): Promise<KernelEffect> {
    const effectId = `pi-native:${input.command.commandId}`;
    let evidenceRef: string | undefined;
    let terminal: 'succeeded' | 'failed' | 'unknown' = 'unknown';
    let detail: string | undefined;
    return {
      effectId,
      execute: async () => {
        const worker = await this.binding.start({ command: input.command, journal: input.artifacts.journalForTrustedPi(), authority: this.binding.authority() });
        try {
          const outcome = await worker.run(this.binding.prompt(input.command), this.binding.correction(input.command));
          evidenceRef = await input.artifacts.writeEffect('host.pi_native.completed', JSON.stringify({ sessionId: worker.sessionId, result: outcome.result, repaired: outcome.repaired, rawArtifacts: outcome.artifacts }));
          terminal = outcome.result.status === 'succeeded' ? 'succeeded' : 'failed';
          detail = outcome.result.status === 'succeeded' ? undefined : `Pi worker returned ${outcome.result.status}`;
        } finally { worker.dispose(); }
      },
      observe: async () => ({ commandId: input.command.commandId, effectId, state: evidenceRef ? terminal : 'unknown', source: 'pi-native', observedAt: new Date().toISOString(), evidenceRefs: [evidenceRef ?? 'host:pi-native-observation-missing'], ...(detail ? { detail } : {}) }),
    };
  }
}

export type HostSnapshot = Readonly<{
  runId: string;
  ownership?: OrchestratorLease;
  commands: readonly CommandRecord[];
  attempts: KernelRunProjection['attempts'];
  autonomyLeases: KernelRunProjection['autonomyLeases'];
  reservations: KernelRunProjection['reservations'];
  artifacts: readonly Readonly<{ source: string; ref: string }> [];
  recoveryRefs: readonly string[];
}>;

export type HostOptions = Readonly<{
  stateDirectory: string;
  kinds: Readonly<Record<string, KernelKind>>;
  now?: () => string;
  runtime?: HostRuntime;
}>;

export type DriverStartAuthority = Readonly<{
  runId: string;
  owner: 'fable' | 'astra';
  leaseId: string;
  expectedEpoch: number;
  issuedAt: string;
  expiresAt: string;
}>;

export class HostArtifactStore implements OrchestratorArtifacts {
  constructor(private readonly journal: ArtifactJournal, private readonly scope: () => ArtifactScope) {}

  private currentScope(): ArtifactScope { return this.scope(); }
  scopeSnapshot(): ArtifactScope { return this.currentScope(); }

  private assert(stored: StoredArtifactRef, ...kinds: ArtifactKind[]): void {
    const scope = this.currentScope();
    if (stored.runId !== scope.runId || stored.sessionId !== scope.sessionId || !kinds.includes(stored.kind)) throw new Error('host artifact reference is outside the trusted run/session or has the wrong kind');
  }
  private async write(kind: ArtifactKind, source: string, text: string, sourceIdentity?: string): Promise<string> {
    const scope = this.currentScope();
    sourceIdentity = sourceIdentity ?? `${source}:${scope.runId}:${scope.sessionId}:${randomUUID()}`;
    const envelope: StoredArtifactEnvelope = { schemaVersion: 1, kind, runId: scope.runId, sessionId: scope.sessionId, text };
    const raw = await this.journal.append({ source, sourceIdentity, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(envelope)), classification: 'sensitive' }, { permitSensitive: true });
    return encodeRef({ schemaVersion: 1, kind, runId: scope.runId, sessionId: scope.sessionId, sourceIdentity, raw });
  }
  private async read(ref: string, ...kinds: ArtifactKind[]): Promise<string> {
    const stored = decodeRef(ref); this.assert(stored, ...kinds);
    const parsed: unknown = JSON.parse((await this.journal.read(stored.raw, stored.sourceIdentity, { permitSensitive: true })).toString('utf8'));
    const envelope = decodeEnvelope(parsed);
    if (envelope.kind !== stored.kind || envelope.runId !== stored.runId || envelope.sessionId !== stored.sessionId) {
      throw new Error('host artifact reference does not match durable scoped bytes');
    }
    return envelope.text;
  }

  async writeText(source: string, text: string, sourceIdentity?: string): Promise<string> { return this.write('text', source, text, sourceIdentity); }
  async writeEffect(source: string, text: string): Promise<string> { return this.write('effect', source, text); }
  journalForTrustedPi(): ArtifactJournal { return this.journal; }

  async readText(ref: string): Promise<string> { return this.read(ref, 'text'); }

  async saveInvocation(input: { driver: 'fable' | 'astra'; sessionId: string; providerSessionId?: string; outcome: InvocationOutcome; text: string }): Promise<string> {
    if (input.sessionId !== this.currentScope().sessionId) throw new Error('invocation session does not match trusted artifact scope');
    return this.write('invocation', 'host.orchestrator.invocation', JSON.stringify(input));
  }

  async saveRecoveryBundle(bundle: RecoveryBundle): Promise<string> {
    const scope = this.currentScope();
    if (bundle.runId !== scope.runId || bundle.sessionId !== scope.sessionId) throw new Error('recovery bundle does not match trusted artifact scope');
    return this.write('recovery_bundle', 'host.orchestrator.recovery_bundle', JSON.stringify(bundle));
  }

  async loadRecoveryBundle(ref: string): Promise<RecoveryBundle> {
    const parsed: unknown = JSON.parse(await this.read(ref, 'recovery_bundle'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid durable recovery bundle');
    const bundle = parsed as Partial<RecoveryBundle>;
    if ((bundle.driver !== 'fable' && bundle.driver !== 'astra') || typeof bundle.runId !== 'string'
      || typeof bundle.sessionId !== 'string' || (bundle.mode !== 'primary' && bundle.mode !== 'consultant')
      || !validRefs(bundle.contextRefs) || !validRefs(bundle.eventRefs) || typeof bundle.recoveryStateRef !== 'string' || bundle.recoveryStateRef.length === 0) {
      throw new Error('invalid durable recovery bundle');
    }
    const scope = this.currentScope();
    if (bundle.runId !== scope.runId || bundle.sessionId !== scope.sessionId) throw new Error('recovery bundle does not match trusted artifact scope');
    await this.loadRecoveryState(bundle.recoveryStateRef);
    return bundle as RecoveryBundle;
  }

  async saveRecoveryState(snapshot: unknown): Promise<string> { return this.write('recovery_state', 'host.recovery', JSON.stringify(snapshot)); }
  async loadRecoveryState(ref: string): Promise<string> { return this.read(ref, 'recovery_state'); }
}

export class HostControlPlane {
  private constructor(
    private readonly kernel: ReturnType<typeof openKernel>,
    private readonly journal: ArtifactJournal,
    private readonly runtime?: HostRuntime,
  ) {}

  static async open(options: HostOptions): Promise<HostControlPlane> {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    const kernel = openKernel({ databasePath: join(options.stateDirectory, 'kernel.sqlite'), kinds: options.kinds, now: options.now });
    const journal = await ArtifactJournal.open({ root: join(options.stateDirectory, 'journal'), hostPolicy: { allowSensitiveWrites: true } });
    return new HostControlPlane(kernel, journal, options.runtime);
  }

  /** The caller must have already recorded the human grant and autonomy lease. */
  recordHumanAuthority(grant: HumanAuthorityGrant): void { this.kernel.host.declareHumanAuthority(grant); }
  /** Records an externally authorised autonomy lease; this method never creates or renews one. */
  recordAutonomyLease(lease: AutonomyLease): void { this.kernel.host.issueAutonomyLease(lease); }
  revokeAutonomyLease(leaseId: string): void { this.kernel.host.revokeAutonomyLease(leaseId); }
  /** Trusted runtime records immutable worker-attempt provenance before Pi begins effects. */
  recordAttempt(attempt: Attempt): void { this.kernel.host.appendAttempt(attempt); }

  piAuthority(options: PiEffectAuthorityOptions): PiAuthority {
    const binding = Object.freeze({ ...options });
    return {
      perform: async (effect, action) => {
        this.kernel.host.admit(binding.commandForEffect(effect), { actorId: binding.actorId, attemptId: binding.attemptId, allowedOrigins: ['worker'] });
        const claim = this.kernel.host.claim(effect.effectId, { executorId: binding.executorId }, new Date(Date.now() + 60_000).toISOString());
        const observation = await this.kernel.host.perform(effect.effectId, claim, { executorId: binding.executorId }, async () => { throw new Error('Pi effect has no external precondition'); }, {
          effectId: `host:${effect.effectId}`, execute: action,
          observe: () => ({ commandId: effect.effectId, effectId: `host:${effect.effectId}`, state: 'succeeded', source: 'host.pi_authority', observedAt: new Date().toISOString(), evidenceRefs: [`pi-effect:${effect.effectId}`] }),
        });
        if (observation.state !== 'succeeded') throw new Error(`Pi effect was not successfully observed: ${observation.state}`);
        const settlement = binding.observedSettlement?.(effect);
        if (settlement) this.kernel.host.settleResource(effect.effectId, settlement);
      },
      requestCancellation: async (commandId) => this.kernel.host.requestCancellation(commandId),
      reportWorkerStop: async (_commandId, observed) => this.kernel.host.reportAttemptStop(binding.attemptId, observed),
    };
  }

  acquireOwnership(lease: OrchestratorLease, expectedEpoch: number): OrchestratorLease {
    return this.kernel.host.acquireOwnership(lease, expectedEpoch);
  }

  private assertSession(context: HelmToolExecutionContext): OrchestratorLease {
    if (context.mode !== 'primary') throw new Error('consultant sessions cannot access trusted host artifacts');
    const ownership = this.kernel.host.readRun(context.runId).ownership;
    if (!ownership || ownership.sessionId !== context.sessionId) throw new Error('orchestrator session is not the current durable owner');
    return this.kernel.host.assertCurrentOwner(ownership);
  }

  artifactsFor(context: HelmToolExecutionContext): HostArtifactStore {
    const binding = Object.freeze({ runId: context.runId, sessionId: context.sessionId, mode: context.mode });
    this.assertSession(binding);
    return new HostArtifactStore(this.journal, () => { this.assertSession(binding); return { runId: binding.runId, sessionId: binding.sessionId }; });
  }

  artifactsForStart(authority: DriverStartAuthority): HostArtifactStore {
    const binding = Object.freeze({ ...authority });
    return new HostArtifactStore(this.journal, () => {
      const ownership = this.kernel.host.readRun(binding.runId).ownership;
      if (!ownership || ownership.owner !== binding.owner || ownership.leaseId !== binding.leaseId || ownership.epoch !== binding.expectedEpoch + 1) throw new Error('driver start has no current durable ownership binding');
      this.kernel.host.assertCurrentOwner(ownership);
      return { runId: binding.runId, sessionId: ownership.sessionId };
    });
  }

  /**
   * Bind the random session ID generated by Fable/Astra before its first
   * recovery capture. This is the only start path the durable host exposes.
   */
  createSessionGuard(authority: DriverStartAuthority): OrchestratorSessionGuard {
    const binding = Object.freeze({ ...authority });
    let startAuthorised = false;
    return {
      authorizeStart: async (input) => {
        if (startAuthorised || input.runId !== binding.runId || input.driver !== binding.owner || input.mode !== 'primary') {
          throw new Error('host start binding refused');
        }
        this.acquireOwnership({
          runId: binding.runId,
          leaseId: binding.leaseId,
          owner: binding.owner,
          sessionId: input.sessionId,
          epoch: binding.expectedEpoch + 1,
          issuedAt: binding.issuedAt,
          expiresAt: binding.expiresAt,
        }, binding.expectedEpoch);
        startAuthorised = true;
      },
      assertCurrent: async (input) => {
        if (input.runId !== binding.runId || input.mode !== 'primary' || input.sessionId.length === 0) {
          throw new Error('orchestrator session is not the current durable owner');
        }
        this.kernel.host.assertCurrentOwner({
          runId: binding.runId, leaseId: binding.leaseId, owner: binding.owner, sessionId: input.sessionId,
          epoch: binding.expectedEpoch + 1, issuedAt: binding.issuedAt, expiresAt: binding.expiresAt,
        });
      },
    };
  }

  /** Trusted driver/tool adapters may submit only as the fenced session owner. */
  admitOrchestrator(intent: unknown, context: HelmToolExecutionContext, actorId: string): CommandRecord {
    this.assertSession(context);
    return this.kernel.host.admit(intent, { actorId, sessionId: context.sessionId, allowedOrigins: ['orchestrator'] });
  }

  async perform(commandId: string, executor: TrustedExecutor, claimExpiresAt: string, readFact: (precondition: Precondition) => Promise<Observation<boolean>>): Promise<EffectObservation> {
    if (!this.runtime) throw new Error('host has no trusted runtime effect binding');
    const record = this.kernel.kernel.getCommand(commandId);
    if (!record) throw new Error('unknown command');
    const ownership = this.kernel.host.readRun(record.command.runId).ownership;
    if (!ownership) throw new Error('command run has no current orchestrator owner');
    const effect = await this.runtime.createEffect({ command: record.command, artifacts: new HostArtifactStore(this.journal, () => ({ runId: record.command.runId, sessionId: ownership.sessionId })) });
    const claim = this.kernel.host.claim(commandId, executor, claimExpiresAt);
    return this.kernel.host.perform(commandId, claim, executor, readFact, effect);
  }

  async snapshot(runId: string): Promise<HostSnapshot> {
    const projection = this.kernel.host.readRun(runId);
    const metadata = await this.journal.metadata();
    const protectedMetadata = metadata.filter((entry) => entry.classification === 'sensitive');
    const evidenceRefs = new Set(projection.commands.flatMap((record) => record.observations.flatMap((observation) => observation.evidenceRefs)));
    const durable = await Promise.all(protectedMetadata.map(async (entry) => {
      try {
        const value = decodeEnvelope(JSON.parse((await this.journal.read(entry.raw, entry.sourceIdentity, { permitSensitive: true })).toString('utf8')));
        return { entry, ref: { schemaVersion: 1 as const, kind: value.kind, runId: value.runId, sessionId: value.sessionId, sourceIdentity: entry.sourceIdentity, raw: entry.raw } };
      } catch { return undefined; }
    }));
    const runArtifacts = durable.filter((item): item is { entry: ArtifactMetadata; ref: StoredArtifactRef } => item !== undefined && item.ref.runId === runId);
    const encoded = (item: { entry: ArtifactMetadata; ref: StoredArtifactRef }) => encodeRef(item.ref);
    return {
      runId,
      ...(projection.ownership ? { ownership: projection.ownership } : {}),
      commands: projection.commands,
      attempts: projection.attempts,
      autonomyLeases: projection.autonomyLeases,
      reservations: projection.reservations,
      artifacts: runArtifacts.filter((item) => evidenceRefs.has(encoded(item))).map((item) => ({ source: item.entry.source, ref: encoded(item) })),
      recoveryRefs: runArtifacts.filter((item) => item.ref.kind === 'recovery_bundle' || item.ref.kind === 'recovery_state').map(encoded),
    };
  }

  /** Restart recovery is deterministic: in-flight effects become unknown and are never replayed blindly. */
  async recover(runId: string): Promise<HostSnapshot> {
    this.kernel.host.recoverAfterRestart(runId);
    return this.snapshot(runId);
  }

  recoveryStateFor(context: HelmToolExecutionContext): OrchestratorRecoveryState {
    const binding = Object.freeze({ runId: context.runId, sessionId: context.sessionId, mode: context.mode });
    const artifacts = this.artifactsFor(binding);
    return {
      capture: async (input) => {
        if (input.runId !== binding.runId || input.sessionId !== binding.sessionId) throw new Error('recovery capture does not match trusted artifact scope');
        return { recoveryStateRef: await artifacts.saveRecoveryState({ schemaVersion: 1, driver: input.driver, runId: input.runId, sessionId: input.sessionId, mode: input.mode, contextRefs: input.contextRefs ?? [], eventRefs: input.eventRefs ?? [], snapshot: await this.snapshot(input.runId) }) };
      },
      restore: async (ref) => artifacts.loadRecoveryState(ref),
    };
  }

  recoveryStateForStart(authority: DriverStartAuthority): OrchestratorRecoveryState {
    const binding = Object.freeze({ ...authority });
    const artifacts = this.artifactsForStart(binding);
    return {
      capture: async (input) => {
        const scope = artifacts.scopeSnapshot();
        if (input.runId !== scope.runId || input.sessionId !== scope.sessionId) throw new Error('recovery capture does not match durable start binding');
        return { recoveryStateRef: await artifacts.saveRecoveryState({ schemaVersion: 1, driver: input.driver, runId: input.runId, sessionId: input.sessionId, mode: input.mode, contextRefs: input.contextRefs ?? [], eventRefs: input.eventRefs ?? [], snapshot: await this.snapshot(input.runId) }) };
      },
      restore: async (ref) => artifacts.loadRecoveryState(ref),
    };
  }

  close(): void { this.journal.close(); this.kernel.host.close(); }
}

export async function openHost(options: HostOptions): Promise<HostControlPlane> { return HostControlPlane.open(options); }
