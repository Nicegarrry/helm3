import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { commandSchema, type Attempt, type AutonomyLease, type Command, type Event, type Observation, type OrchestratorLease, type Precondition, type RawArtifactRef, type WorkerResult } from '../contracts/index.js';
import {
  openKernel,
  type CommandRecord,
  type CommandAttemptBinding,
  type EffectObservation,
  type KernelEffect,
  type EventMetadata,
  type HumanAuthorityGrant,
  type KernelKind,
  type KernelRunProjection,
  type ModelFact,
  type TrustedExecutor,
} from '../core/index.js';
import { ArtifactJournal, type ArtifactMetadata } from '../journal/index.js';
import { JournalReviewContextStore } from './review-context.js';
import {
  EventDrivenSupervisor,
  EventSupervisor,
  planRecovery,
  type RecoveryFacts,
  type SupervisorLog,
  type SupervisorProcessInput,
  type SupervisorProcessResult,
} from '../supervisor/index.js';
import type {
  HelmToolExecutionContext,
  InvocationOutcome,
  OrchestratorArtifacts,
  OrchestratorRecoveryState,
  OrchestratorSessionGuard,
  RecoveryBundle,
} from '../runtime/orchestrator/index.js';
import type { PiAuthority, PiCompactEffect, PiEffect, PiNativeWorker } from '../runtime/pi/index.js';
import { parsePiModelDeliveryFailureReceipt, piStoppedReceiptSchema, type PiModelDeliveryFailureProof, type PiStoppedReceipt } from '../runtime/pi/delivery.js';
import { selectTrustedEnvelopeLineage } from './envelope-lineage.js';

type ArtifactKind = 'text' | 'invocation' | 'recovery_bundle' | 'recovery_state' | 'effect';
type ArtifactScope = Readonly<{ runId: string; sessionId: string }>;
type StoredArtifactRef = Readonly<{ schemaVersion: 1; kind: ArtifactKind; runId: string; sessionId: string; sourceIdentity: string; raw: RawArtifactRef }>;
type StoredArtifactEnvelope = Readonly<{ schemaVersion: 1; kind: ArtifactKind; runId: string; sessionId: string; text: string }>;
/** Historical, reviewer-bound evidence access. It cannot admit or execute any command. */
export type HistoricalReviewObservationJournal = Readonly<{
  metadata(): Promise<readonly ArtifactMetadata[]>;
  read(raw: RawArtifactRef, sourceIdentity: string): Promise<Buffer>;
  appendAfter(bytes: Uint8Array): Promise<RawArtifactRef>;
}>;

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
 * Host-owned recovery observation capability. External event submitters never
 * supply these reads, so they cannot turn a callback into retry authority.
 */
export type SupervisorObservationRuntime = Readonly<{
  observeRecovery(command: Command): Promise<RecoveryFacts>;
  readFact(precondition: Precondition): Promise<Observation<boolean>>;
}>;

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
  /** Required only by the host API that exposes manual compaction. */
  compactCommandForEffect?(effect: PiCompactEffect): unknown;
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
        let locallyStopped = false;
        try {
          const outcome = await worker.run(this.binding.prompt(input.command), this.binding.correction(input.command));
          evidenceRef = await input.artifacts.writeEffect('host.pi_native.completed', JSON.stringify({ sessionId: worker.sessionId, result: outcome.result, repaired: outcome.repaired, rawArtifacts: outcome.artifacts }));
          terminal = outcome.result.status === 'succeeded' ? 'succeeded' : 'failed';
          detail = outcome.result.status === 'succeeded' ? undefined : `Pi worker returned ${outcome.result.status}`;
        } catch (error) {
          // The outer effect has not yet been observed. Quarantine it after
          // local abort rather than leaving an active worker after a stream error.
          locallyStopped = (await worker.abortAfterFailure()) === 'stopped';
          // Provider/session errors can contain request material. The kernel
          // records effect failures, so only a stable public disposition crosses
          // this boundary.
          throw new Error('Pi worker invocation failed');
        } finally {
          if (locallyStopped || !worker.isActive) worker.dispose();
        }
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
  attemptLifecycles: KernelRunProjection['attemptLifecycles'];
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
  supervisorRuntime?: SupervisorObservationRuntime;
}>;

export type DriverStartAuthority = Readonly<{
  runId: string;
  owner: 'fable' | 'astra';
  leaseId: string;
  expectedEpoch: number;
  issuedAt: string;
  expiresAt: string;
}>;

/** Provider-free host entry point for explicit trusted supervisor observations. */
export type HostSupervisor = Readonly<{
  /** Narrow Log capability for status projections and trusted delivery adapters. */
  log(): SupervisorLog;
  /** Serially records an observation, persists current wakes, and may run one bounded retry. */
  process(input: SupervisorProcessInput): Promise<SupervisorProcessResult>;
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
  async writeEffect(source: string, text: string, sourceIdentity?: string): Promise<string> { return this.write('effect', source, text, sourceIdentity); }
  journalForTrustedPi(): ArtifactJournal { return this.journal; }

  async readText(ref: string): Promise<string> { return this.read(ref, 'text'); }
  /** Trusted host-only consumers may read an effect envelope after a restart. */
  async readEffect(ref: string): Promise<string> { return this.read(ref, 'effect'); }

  async saveInvocation(input: { driver: 'fable' | 'astra'; sessionId: string; providerSessionId?: string; outcome: InvocationOutcome; text: string }): Promise<string> {
    if (input.sessionId !== this.currentScope().sessionId) throw new Error('invocation session does not match trusted artifact scope');
    return this.write('invocation', 'host.orchestrator.invocation', JSON.stringify(input));
  }

  /** Read the durable invocation outcome, never infer success from a model's text. */
  async readInvocation(ref: string): Promise<Readonly<Parameters<OrchestratorArtifacts['saveInvocation']>[0]>> {
    const parsed: unknown = JSON.parse(await this.read(ref, 'invocation'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid durable invocation');
    const value = parsed as Partial<Parameters<OrchestratorArtifacts['saveInvocation']>[0]>;
    if ((value.driver !== 'fable' && value.driver !== 'astra')
      || value.sessionId !== this.currentScope().sessionId
      || (value.outcome !== 'succeeded' && value.outcome !== 'failed' && value.outcome !== 'unknown')
      || typeof value.text !== 'string'
      || (value.providerSessionId !== undefined && (typeof value.providerSessionId !== 'string' || !value.providerSessionId))) {
      throw new Error('invalid durable invocation');
    }
    return Object.freeze({ driver: value.driver, sessionId: value.sessionId, outcome: value.outcome, text: value.text,
      ...(value.providerSessionId !== undefined ? { providerSessionId: value.providerSessionId } : {}) });
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
  private supervisorService?: HostSupervisor;
  private constructor(
    private readonly kernel: ReturnType<typeof openKernel>,
    private readonly journal: ArtifactJournal,
  private readonly runtime?: HostRuntime,
    private readonly supervisorRuntime?: SupervisorObservationRuntime,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  static async open(options: HostOptions): Promise<HostControlPlane> {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    const now = options.now ?? (() => new Date().toISOString());
    const kernel = openKernel({ databasePath: join(options.stateDirectory, 'kernel.sqlite'), kinds: options.kinds, now });
    const journal = await ArtifactJournal.open({ root: join(options.stateDirectory, 'journal'), hostPolicy: { allowSensitiveWrites: true } });
    return new HostControlPlane(kernel, journal, options.runtime, options.supervisorRuntime, now);
  }

  /** The caller must have already recorded the human grant and autonomy lease. */
  recordHumanAuthority(grant: HumanAuthorityGrant): void { this.kernel.host.declareHumanAuthority(grant); }
  /** Records an externally authorised autonomy lease; this method never creates or renews one. */
  recordAutonomyLease(lease: AutonomyLease): void { this.kernel.host.issueAutonomyLease(lease); }
  /** Trusted model-registry ingestion; orchestration JSON only selects an existing fact. */
  recordModelFact(fact: ModelFact): void { this.kernel.host.putModelFact(fact); }
  readExecutionCapacity(authorityId: string) { return this.kernel.host.readExecutionCapacity(authorityId); }
  readModelFact(modelId: string): ModelFact | undefined { return this.kernel.host.readModelFact(modelId); }
  /** Read a current, nonrevoked autonomy lease before a command references it. */
  readAutonomyLease(leaseId: string, revision: number): AutonomyLease | undefined { return this.kernel.host.readAutonomyLease(leaseId, revision); }
  assertModelProvenance(modelId: string, provider: string, factVersion: number): void { this.kernel.host.assertModelProvenance(modelId, provider, factVersion); }
  revokeAutonomyLease(leaseId: string): void { this.kernel.host.revokeAutonomyLease(leaseId); }
  /** Trusted runtime records immutable worker-attempt provenance before Pi begins effects. */
  recordAttempt(attempt: Attempt): void { this.kernel.host.appendAttempt(attempt); }
  reviewContextFor(context: HelmToolExecutionContext): JournalReviewContextStore { this.assertSession(context); return new JournalReviewContextStore(this.journal, context.runId, ref => this.artifactsFor(context).readText(ref)); }

  piAuthority(options: PiEffectAuthorityOptions): PiAuthority {
    const binding = Object.freeze({ ...options });
    return {
      perform: async (effect, action) => {
        const command = commandSchema.parse(binding.commandForEffect(effect));
        if (command.commandId !== effect.effectId) throw new Error('Pi effect command identity must equal its effect identity');
        this.kernel.host.admit(command, { actorId: binding.actorId, attemptId: binding.attemptId, allowedOrigins: ['worker'] });
        // Core evaluates authority against its injected monotonic-safe clock.
        // A native Pi effect must derive its claim expiry from that same clock;
        // using the process clock can make a valid host-owned review appear
        // expired in a recovered or deterministically tested control plane.
        const claim = this.kernel.host.claim(effect.effectId, { executorId: binding.executorId }, new Date(Date.parse(this.now()) + 60_000).toISOString());
        const observation = await this.kernel.host.perform(effect.effectId, claim, { executorId: binding.executorId }, async () => { throw new Error('Pi effect has no external precondition'); }, {
          effectId: `host:${effect.effectId}`, execute: action,
          observe: () => ({ commandId: effect.effectId, effectId: `host:${effect.effectId}`, state: 'succeeded', source: 'host.pi_authority', observedAt: new Date().toISOString(), evidenceRefs: [`pi-effect:${effect.effectId}`] }),
        });
        if (observation.state !== 'succeeded') throw new Error(`Pi effect was not successfully observed: ${observation.state}`);
        const settlement = binding.observedSettlement?.(effect);
        if (settlement) this.kernel.host.settleResource(effect.effectId, settlement);
      },
      performCompact: binding.compactCommandForEffect ? async (effect, action) => {
        this.kernel.host.admit(binding.compactCommandForEffect!(effect), { actorId: binding.actorId, attemptId: binding.attemptId, allowedOrigins: ['worker'] });
        const claim = this.kernel.host.claim(effect.effectId, { executorId: binding.executorId }, new Date(Date.parse(this.now()) + 60_000).toISOString());
        let evidenceRefs: readonly string[] | undefined;
        const observation = await this.kernel.host.perform(effect.effectId, claim, { executorId: binding.executorId }, async () => { throw new Error('Pi compact effect has no external precondition'); }, {
          effectId: `host:${effect.effectId}`,
          execute: async () => { evidenceRefs = (await action()).map((ref) => ref.ref); },
          observe: () => {
            if (!evidenceRefs || evidenceRefs.length === 0) throw new Error('Pi compaction completed without durable evidence references');
            return { commandId: effect.effectId, effectId: `host:${effect.effectId}`, state: 'succeeded' as const, source: 'host.pi_compaction', observedAt: new Date().toISOString(), evidenceRefs: [...evidenceRefs] };
          },
        });
        if (observation.state !== 'succeeded') throw new Error(`Pi compaction was not successfully observed: ${observation.state}`);
      } : undefined,
      requestCancellation: async (commandId) => this.kernel.host.requestCancellation(commandId),
      reportWorkerStop: async (_commandId, observed) => this.kernel.host.reportAttemptStop(binding.attemptId, observed),
      reconcileModelDeliveryFailure: async (proof) => this.reconcilePiModelDeliveryFailure(proof),
    };
  }

  /**
   * Convert one exact, redacted native provider error receipt into a failed
   * model command after Kernel has conservatively recorded that command as
   * unknown.  The receipt never settles its resource reservation.
   */
  async reconcilePiModelDeliveryFailure(proof: PiModelDeliveryFailureProof): Promise<void> {
    const receipt = parsePiModelDeliveryFailureReceipt(proof.receipt);
    const expectedSourceIdentity = `pi-model-delivery-failure:${receipt.attemptId}:${receipt.effectId}`;
    const metadata = await this.journal.metadataFor(expectedSourceIdentity);
    if (metadata && (metadata.source !== 'pi.model.delivery.failure'
      || metadata.raw.ref !== proof.receiptRef.ref || metadata.raw.hash !== proof.receiptRef.hash || metadata.raw.mediaType !== proof.receiptRef.mediaType)) throw new Error('native delivery receipt metadata is not bound to its deterministic identity');
    if (!metadata) throw new Error('native delivery receipt metadata is not bound to its deterministic identity');
    const bytes = await this.journal.read(metadata.raw, metadata.sourceIdentity);
    if (bytes.toString('utf8') !== JSON.stringify(receipt)) throw new Error('native delivery receipt bytes changed after validation');

    const modelRecord = this.kernel.kernel.getCommand(receipt.modelCommandId);
    const modelBinding = this.kernel.host.commandAttempt(receipt.modelCommandId);
    const parentRecord = this.kernel.kernel.getCommand(receipt.parentCommandId);
    const parentBinding = this.kernel.host.commandAttempt(receipt.parentCommandId);
    if (!modelRecord || !modelBinding || !parentRecord || !parentBinding
      || modelRecord.command.kind !== 'pi.model'
      || modelBinding.attemptId !== receipt.attemptId || parentBinding.attemptId !== receipt.attemptId
      || modelBinding.runId !== parentRecord.command.runId || parentRecord.command.runId !== modelRecord.command.runId
      || modelBinding.repositoryId !== parentRecord.command.scope.repositoryId
      || modelBinding.mapNodeId !== parentRecord.command.scope.mapNodeId
      || parentRecord.command.kind !== 'worker.spawn' && parentRecord.command.kind !== 'worker.steer'
      || parentRecord.status !== 'succeeded'
      || !['effect_started', 'observing', 'unknown', 'failed'].includes(modelRecord.status)) {
      throw new Error('native delivery receipt command and attempt binding is invalid');
    }
    const launch = await this.launchRecord(parentRecord, receipt.attemptId);
    if (!launch || launch.sessionId !== receipt.sessionId || launch.attemptId !== receipt.attemptId
      || launch.spawnCommandId !== receipt.parentCommandId
      || launch.modelId !== receipt.model || launch.modelProvider !== receipt.provider || launch.modelApi !== receipt.api
      || launch.modelFactVersion === undefined) throw new Error('native delivery receipt session or model provenance is invalid');
    const parentPayload = parentRecord.command.payload as { attemptId?: unknown; modelId?: unknown; modelProvider?: unknown; modelApi?: unknown; modelFactVersion?: unknown };
    if (parentPayload.attemptId !== receipt.attemptId || parentPayload.modelId !== receipt.model
      || parentPayload.modelProvider !== receipt.provider || parentPayload.modelApi !== receipt.api
      || parentPayload.modelFactVersion !== launch.modelFactVersion) throw new Error('native delivery receipt does not match immutable launch payload');
    if (receipt.modelCommandId !== receipt.effectId) throw new Error('native delivery receipt model command and effect differ');
    const expectedEffectId = `host:${receipt.effectId}`;
    if (modelRecord.observations.some((item) => item.effectId === expectedEffectId && item.state === 'failed' && item.source === 'pi.model.delivery.failure' && item.evidenceRefs.includes(proof.receiptRef.ref))) return;
    if (modelRecord.status === 'failed') throw new Error('native delivery receipt conflicts with the existing terminal outcome');
    // A crash can follow the durable receipt but precede Kernel's catch. Keep
    // that unobserved interval explicit; never fabricate an absent provider
    // effect or settle its reservation. Core also checks the real effect ID.
    if (!modelRecord.observations.some((item) => item.effectId === expectedEffectId && item.state === 'unknown')) {
      this.kernel.host.recordObservation(receipt.modelCommandId, { commandId: receipt.modelCommandId, effectId: expectedEffectId, state: 'unknown', source: 'pi.model.delivery.recovery', observedAt: receipt.observedAt, evidenceRefs: [proof.receiptRef.ref], detail: 'effect outcome was unobserved before durable receipt reconciliation' });
    }
    this.kernel.host.recordObservation(receipt.modelCommandId, { commandId: receipt.modelCommandId, effectId: expectedEffectId, state: 'failed', source: 'pi.model.delivery.failure', observedAt: receipt.observedAt, evidenceRefs: [proof.receiptRef.ref], detail: 'native provider error terminal' });
  }

  /** Replay all valid native failure receipts for a run without starting or retrying anything. */
  async reconcilePiModelDeliveryFailures(runId: string, attemptId?: string): Promise<number> {
    const projection = this.kernel.host.readRun(runId);
    let reconciled = 0;
    const candidates = projection.commands.filter((record) => record.command.kind === 'pi.model'
      && (!attemptId || this.kernel.host.commandAttempt(record.command.commandId)?.attemptId === attemptId));
    for (const candidate of candidates) {
      try {
        const binding = this.kernel.host.commandAttempt(candidate.command.commandId);
        if (!binding) continue;
        const sourceIdentity = `pi-model-delivery-failure:${binding.attemptId}:${candidate.command.commandId}`;
        const entry = await this.journal.metadataFor(sourceIdentity);
        if (!entry || entry.source !== 'pi.model.delivery.failure') continue;
        const receipt = parsePiModelDeliveryFailureReceipt(JSON.parse((await this.journal.read(entry.raw, sourceIdentity)).toString('utf8')));
        const parent = projection.commands.find((item) => item.command.commandId === receipt.parentCommandId);
        if (!parent || parent.command.runId !== runId || receipt.modelCommandId !== candidate.command.commandId) continue;
        await this.reconcilePiModelDeliveryFailure({ receipt, receiptRef: entry.raw });
        reconciled++;
      } catch { /* Foreign, incomplete or corrupt receipts remain unknown. */ }
    }
    return reconciled;
  }

  /** Release proven-stopped local execution independently of unresolved model billing. */
  async reconcilePiStoppedReceipt(input: Readonly<{ receipt: PiStoppedReceipt; receiptRef: RawArtifactRef }>): Promise<void> {
    const receipt = piStoppedReceiptSchema.parse(input.receipt);
    const expectedSourceIdentity = `pi-worker-stop:${receipt.attemptId}:${receipt.commandId}:${receipt.sessionId}`;
    const metadata = await this.journal.metadataFor(expectedSourceIdentity);
    if (metadata && (metadata.source !== 'pi.worker.stop'
      || metadata.raw.ref !== input.receiptRef.ref || metadata.raw.hash !== input.receiptRef.hash || metadata.raw.mediaType !== input.receiptRef.mediaType)) throw new Error('native stop receipt metadata is not bound to its deterministic identity');
    if (!metadata) throw new Error('native stop receipt metadata is not bound to its deterministic identity');
    const bytes = await this.journal.read(metadata.raw, metadata.sourceIdentity);
    if (bytes.toString('utf8') !== JSON.stringify(receipt)) throw new Error('native stop receipt bytes changed after validation');
    const parent = this.kernel.kernel.getCommand(receipt.commandId);
    const binding = this.kernel.host.commandAttempt(receipt.commandId);
    if (!parent || !binding || (parent.command.kind !== 'worker.spawn' && parent.command.kind !== 'worker.steer')
      || parent.status !== 'succeeded' || binding.attemptId !== receipt.attemptId) throw new Error('native stop receipt command and attempt binding is invalid');
    const launch = await this.launchRecord(parent, receipt.attemptId);
    if (!launch || launch.sessionId !== receipt.sessionId) throw new Error('native stop receipt session is not bound to the succeeded launch');
    const parentPayload = parent.command.payload as { attemptId?: unknown; modelId?: unknown; modelProvider?: unknown; modelApi?: unknown; modelFactVersion?: unknown };
    if (parentPayload.attemptId !== receipt.attemptId || parentPayload.modelId !== launch.modelId
      || parentPayload.modelProvider !== launch.modelProvider || parentPayload.modelApi !== launch.modelApi
      || parentPayload.modelFactVersion !== launch.modelFactVersion) throw new Error('native stop receipt does not match immutable launch payload');
    const commands = this.kernel.host.readRun(parent.command.runId).commands.filter((record) => this.kernel.host.commandAttempt(record.command.commandId)?.attemptId === receipt.attemptId);
    const terminal = (record: CommandRecord) => ['succeeded', 'failed', 'refused'].includes(record.status);
    if (commands.length === 0 || !commands.every(record => terminal(record) || (record.status === 'unknown' && record.command.kind === 'pi.model'))) throw new Error('native stop proof cannot release unobserved non-model commands');
    this.kernel.host.releaseAttemptExecution(receipt.attemptId, metadata.raw.ref);
    if (commands.every(terminal)) this.kernel.host.reportAttemptStop(receipt.attemptId, 'stopped');
  }

  /** Restart hook for stop proofs; it never infers process death or starts an effect. */
  async reconcilePiStoppedReceipts(runId: string, attemptId?: string): Promise<number> {
    const projection = this.kernel.host.readRun(runId);
    const candidates = projection.commands.filter((record) => (record.command.kind === 'worker.spawn' || record.command.kind === 'worker.steer')
      && (!attemptId || this.kernel.host.commandAttempt(record.command.commandId)?.attemptId === attemptId));
    let reconciled = 0;
    for (const candidate of candidates) {
      try {
        const binding = this.kernel.host.commandAttempt(candidate.command.commandId);
        if (!binding) continue;
        const launch = await this.launchRecord(candidate, binding.attemptId);
        if (!launch) continue;
        const sourceIdentity = `pi-worker-stop:${binding.attemptId}:${candidate.command.commandId}:${launch.sessionId}`;
        const entry = await this.journal.metadataFor(sourceIdentity);
        if (!entry || entry.source !== 'pi.worker.stop') continue;
        const receipt = piStoppedReceiptSchema.parse(JSON.parse((await this.journal.read(entry.raw, sourceIdentity)).toString('utf8')));
        if (receipt.commandId !== candidate.command.commandId || receipt.attemptId !== binding.attemptId) continue;
        await this.reconcilePiStoppedReceipt({ receipt, receiptRef: entry.raw });
        reconciled++;
      } catch { /* Foreign, missing, corrupt or incomplete stop proofs remain held. */ }
    }
    return reconciled;
  }

  private async launchRecord(parent: CommandRecord, attemptId: string): Promise<Readonly<{ attemptId: string; spawnCommandId: string; sessionId: string; modelId?: string; modelProvider?: string; modelApi?: string; modelFactVersion?: number }> | undefined> {
    for (const ref of parent.observations.flatMap((item) => item.evidenceRefs)) {
      try {
        const text = await this.readFleetEffect(parent.command.runId, ref);
        const value: unknown = JSON.parse(text);
        if (typeof value !== 'object' || value === null) continue;
        const item = value as Record<string, unknown>;
        if (item.attemptId === attemptId && item.spawnCommandId === parent.command.commandId && typeof item.sessionId === 'string') {
          return { attemptId, spawnCommandId: parent.command.commandId, sessionId: item.sessionId, ...(typeof item.modelId === 'string' ? { modelId: item.modelId } : {}), ...(typeof item.modelProvider === 'string' ? { modelProvider: item.modelProvider } : {}), ...(typeof item.modelApi === 'string' ? { modelApi: item.modelApi } : {}), ...(typeof item.modelFactVersion === 'number' ? { modelFactVersion: item.modelFactVersion } : {}) };
        }
      } catch { /* The next exact parent observation may be the launch proof. */ }
    }
    return undefined;
  }

  acquireOwnership(lease: OrchestratorLease, expectedEpoch: number): OrchestratorLease {
    return this.kernel.host.acquireOwnership(lease, expectedEpoch);
  }

  /**
   * Returns the only supervisor-facing Log surface. It intentionally excludes
   * authority grants, leases, raw SQLite and provider operations.
   */
  supervisorLog(): SupervisorLog {
    return Object.freeze({
      appendEvent: this.kernel.host.appendEvent.bind(this.kernel.host),
      appendOwnedEvent: this.kernel.host.appendOwnedEvent.bind(this.kernel.host),
      readEvents: this.kernel.host.readEvents.bind(this.kernel.host),
      assertCurrentOwner: this.kernel.host.assertCurrentOwner.bind(this.kernel.host),
    });
  }

  /**
   * Bounded public Log projection for host-owned read tools. Event payloads can
   * include provider or artifact material, so they never cross this boundary.
   */
  readRunEvents(runId: string, limit: number): ReadonlyArray<Readonly<Omit<Event, 'schemaVersion' | 'correlationId' | 'causationId' | 'payload'>>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('log read limit must be between 1 and 100');
    return this.kernel.host.readEventMetadata(runId, limit) as ReadonlyArray<Readonly<Omit<EventMetadata, never>>>;
  }

  /**
   * No polling or provider adapter is hidden here. Callers feed explicit
   * trusted observations; retry effects always traverse kernel admission,
   * claim and at-effect fresh fact reads.
   */
  createSupervisor(): HostSupervisor {
    if (this.supervisorService) return this.supervisorService;
    const service = new EventDrivenSupervisor(new EventSupervisor(this.supervisorLog(), this.now), {
      retry: async (input) => {
        // Kernel's immutable admission is still authoritative for a new
        // command. On replay, check exact durable bytes before returning the
        // old command so SQLite NULL representation cannot turn an already
        // terminal supervisor command into a second admission attempt.
        const proposed = commandSchema.parse(input.intent);
        if (proposed.origin !== 'supervisor') throw new Error('trusted supervisor accepts only supervisor-origin retry commands');
        if (proposed.runId !== input.signal.runId || proposed.scope.mapNodeId !== input.signal.mapNodeId) throw new Error('supervisor signal and retry command must bind the same run and map node');
        const canonical = { ...proposed, actorId: 'trusted-supervisor' };
        const existing = this.kernel.kernel.getCommand(proposed.commandId);
        if (existing) {
          if (JSON.stringify(existing.command) !== JSON.stringify(canonical)) throw new Error('idempotency collision has different immutable command bytes');
          if (existing.status === 'queued') return this.executeSupervisorRetry(existing, input.executor, input.claimExpiresAt);
          if (existing.status === 'claimed' || existing.status === 'effect_started' || existing.status === 'observing' || existing.status === 'unknown') {
            return { decision: { action: 'wake', reason: `retry command ${existing.status} requires reconciliation` }, status: 'reconcile', record: existing };
          }
          return { decision: { action: 'observe', reason: `retry command is already ${existing.status}` }, status: 'terminal', record: existing };
        }
        if (!this.supervisorRuntime) throw new Error('host has no trusted supervisor recovery observer');
        const record = this.kernel.host.admit(proposed, { actorId: 'trusted-supervisor', allowedOrigins: ['supervisor'] });
        return this.executeSupervisorRetry(record, input.executor, input.claimExpiresAt);
      },
    }, this.now);
    this.supervisorService = Object.freeze({
      log: () => this.supervisorLog(),
      process: async (input) => {
        const owner = this.kernel.host.readRun(input.signal.runId).ownership;
        return service.process(input, owner);
      },
    });
    return this.supervisorService;
  }

  private async recoveryFacts(command: Command): Promise<RecoveryFacts> {
    if (!this.supervisorRuntime) throw new Error('host has no trusted supervisor recovery observer');
    const observed = await this.supervisorRuntime.observeRecovery(command);
    const lease = this.kernel.host.readRun(command.runId).autonomyLeases.find((entry) => entry.lease.leaseId === command.leaseId);
    if (!lease) throw new Error('retry command autonomy lease is absent from the durable Kernel projection');
    return { ...observed, leaseIssuedAt: lease.lease.issuedAt, leaseExpiresAt: lease.lease.expiresAt, leaseRevoked: lease.revoked, retryAllowed: true };
  }

  private async executeSupervisorRetry(record: CommandRecord, executor?: TrustedExecutor, claimExpiresAt?: string) {
    if (record.status !== 'queued') throw new Error('only queued supervisor commands can begin an effect');
    if (!executor || !claimExpiresAt) throw new Error('queued supervisor retry requires executor and claim expiry');
    if (!this.runtime) throw new Error('host has no trusted runtime effect binding');
    const before = planRecovery(await this.recoveryFacts(record.command), this.now());
    if (before.action !== 'retry') return { decision: before, status: 'reconcile' as const, record };
    const effect = await this.runtime.createEffect({ command: record.command, artifacts: new HostArtifactStore(this.journal, () => {
          const ownership = this.kernel.host.readRun(record.command.runId).ownership;
          return { runId: record.command.runId, sessionId: ownership?.sessionId ?? 'supervisor-no-owner' };
    }) });
    const claim = this.kernel.host.claim(record.command.commandId, executor, claimExpiresAt);
    const guarded = {
      effectId: effect.effectId,
      execute: async (command: Command) => {
        const atEffect = planRecovery(await this.recoveryFacts(command), this.now());
        if (atEffect.action !== 'retry') throw new Error(`supervisor retry requires reconciliation at effect: ${atEffect.reason}`);
        await effect.execute(command);
      },
      observe: effect.observe,
    };
    const observation = await this.kernel.host.perform(record.command.commandId, claim, executor, (precondition) => this.supervisorRuntime!.readFact(precondition), guarded);
    return observation.state === 'succeeded'
      ? { decision: { action: 'retry' as const, reason: 'retry effect observed' }, status: 'performed' as const, record: this.kernel.kernel.getCommand(record.command.commandId) ?? record, observation }
      : { decision: { action: 'wake' as const, reason: 'retry effect is uncertain and requires reconciliation' }, status: 'reconcile' as const, record: this.kernel.kernel.getCommand(record.command.commandId) ?? record, observation };
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
   * Host-runtime evidence is deliberately scoped to an immutable admitted
   * worker attempt, rather than to the orchestrator that happened to launch
   * it.  It is an append-only evidence capability: it cannot admit, claim or
   * perform a command, so an expired or replaced owner gains no new effects.
   */
  async writeFleetEffect(input: Readonly<{ runId: string; attemptId: string; spawnCommandId: string; phase: 'terminal-known' | 'terminal-unknown' | 'stop-confirmed' | 'stop-unknown'; text: string }>): Promise<string> {
    const snapshot = this.kernel.host.readRun(input.runId);
    const spawn = snapshot.commands.find((entry) => entry.command.commandId === input.spawnCommandId);
    const payload = spawn?.command.payload as { attemptId?: unknown } | undefined;
    if (!spawn || (spawn.command.kind !== 'worker.spawn' && spawn.command.kind !== 'worker.steer') || payload?.attemptId !== input.attemptId) {
      throw new Error('fleet evidence is not bound to an admitted worker invocation');
    }
    const artifacts = new HostArtifactStore(this.journal, () => ({ runId: input.runId, sessionId: `fleet:${input.attemptId}` }));
    return artifacts.writeEffect(`host.worker_fleet.${input.phase}`, input.text, `host-worker-${input.phase}:${input.runId}:${input.attemptId}`);
  }

  /**
   * Reopens only the immutable journal belonging to an already-admitted
   * readonly reviewer. This historical observation capability intentionally
   * bypasses the former controller lease, but exposes neither artifactsFor nor
   * any command/claim/model/write authority.
   */
  reviewJournalForObservation(input: Readonly<{ runId: string; reviewerAttemptId: string; spawnCommandId: string }>): HistoricalReviewObservationJournal {
    const snapshot = this.kernel.host.readRun(input.runId);
    const record = snapshot.commands.find(entry => entry.command.commandId === input.spawnCommandId);
    const payload = record?.command.payload as { attemptId?: unknown; mode?: unknown } | undefined;
    if (!record || record.command.kind !== 'worker.spawn' || payload?.attemptId !== input.reviewerAttemptId || payload?.mode !== 'review-readonly') {
      throw new Error('historical observation is not bound to an admitted readonly reviewer');
    }
    if (!snapshot.attempts.some(attempt => attempt.attemptId === input.reviewerAttemptId && attempt.commandIds.includes(input.spawnCommandId))) throw new Error('historical observation reviewer attempt is absent');
    const afterIdentity = `host-review-git-after:${input.runId}:${input.reviewerAttemptId}`;
    return Object.freeze({
      metadata: () => this.journal.metadata(),
      read: (raw, sourceIdentity) => this.journal.read(raw, sourceIdentity, { permitSensitive: true }),
      appendAfter: (bytes) => this.journal.append({ source: 'host.review.git.after', sourceIdentity: afterIdentity, mediaType: 'application/json', bytes, classification: 'sensitive' }, { permitSensitive: true }),
    });
  }

  /**
   * Gate bytes are raw journal evidence, so they are meaningful for a steer
   * only through the durable gate command that produced them.  A host note or
   * a gate from another worker/head cannot stand in for that binding.
   */
  async assertGateEvidence(runId: string, gateCommandId: string, predecessorCommandId: string, workerId: string, workspace: string, expectedHead: string, evidenceRefs: readonly string[]): Promise<void> {
    const gate = this.kernel.host.readRun(runId).commands.find((entry) => entry.command.commandId === gateCommandId);
    const predecessor = this.kernel.host.readRun(runId).commands.find((entry) => entry.command.commandId === predecessorCommandId);
    const payload = gate?.command.payload as { workerId?: unknown; workspaceDigest?: unknown; expectedHead?: unknown } | undefined;
    const workspaceDigest = `sha256:${createHash('sha256').update(await realpath(workspace)).digest('hex')}`;
    if (!gate || !predecessor || gate.command.kind !== 'gate.run' || gate.command.scope.repositoryId !== predecessor.command.scope.repositoryId || payload?.workerId !== workerId || payload.workspaceDigest !== workspaceDigest || payload.expectedHead !== expectedHead
      || (gate.status !== 'succeeded' && gate.status !== 'failed')) throw new Error('gate evidence is not a completed exact predecessor gate');
    const recorded = new Set(gate.observations.flatMap((observation) => observation.evidenceRefs));
    if (!evidenceRefs.length || evidenceRefs.some((ref) => !recorded.has(ref))) throw new Error('gate evidence refs are not recorded by the bound gate command');
    await Promise.all(evidenceRefs.map(async (ref) => {
      const metadata = (await this.journal.metadata()).filter((entry) => entry.raw.ref === ref);
      if (!metadata.length) throw new Error('gate evidence bytes have no durable metadata');
      // The gate command establishes provenance; journal metadata supplies a
      // source identity for the required hash-checked raw read.
      await this.journal.read(metadata[0].raw, metadata[0].sourceIdentity, { permitSensitive: true });
    }));
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
  admitOrchestrator(intent: unknown, context: HelmToolExecutionContext, actorId: string, attemptId?: string): CommandRecord {
    this.assertSession(context);
    return this.kernel.host.admit(intent, { actorId, sessionId: context.sessionId, ...(attemptId ? { attemptId } : {}), allowedOrigins: ['orchestrator'] });
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

  /**
   * Execute a narrowly supplied host effect for an already admitted command.
   * This is deliberately not an alternate command path: admission, claim,
   * fresh preconditions and observation remain in the Kernel.
   */
  async performAdmitted(commandId: string, executor: TrustedExecutor, claimExpiresAt: string, readFact: (precondition: Precondition) => Promise<Observation<boolean>>, effect: KernelEffect): Promise<EffectObservation> {
    const record = this.kernel.kernel.getCommand(commandId);
    if (!record) throw new Error('unknown command');
    const ownership = this.kernel.host.readRun(record.command.runId).ownership;
    if (!ownership) throw new Error('command run has no current orchestrator owner');
    this.kernel.host.assertCurrentOwner(ownership);
    const claim = this.kernel.host.claim(commandId, executor, claimExpiresAt);
    return this.kernel.host.perform(commandId, claim, executor, readFact, effect);
  }

  /** Re-fence an active multi-step effect against current owner and authority. */
  assertEffectAuthority(commandId: string, context: HelmToolExecutionContext): void {
    this.assertSession(context);
    const record = this.kernel.kernel.getCommand(commandId);
    if (!record || record.command.runId !== context.runId) throw new Error('effect command is outside the trusted run');
    this.kernel.host.assertEffectAuthority(commandId);
  }

  /** A fleet reports an observed attempt disposition; it never edits spawn status. */
  reportAttemptStop(attemptId: string, observed: 'stopped' | 'pending' | 'unknown'): void {
    this.kernel.host.reportAttemptStop(attemptId, observed);
  }

  /** Durable, payload-bearing fleet events never cross the public Log projection. */
  appendFleetEvent(event: Event): void { this.kernel.host.appendEvent(event); }

  /**
   * Recovery-only read for fleet launch records.  It is scoped to a run but
   * intentionally not to a now-dead driver session, so a replacement owner
   * can report the honest `live: unknown` state after process loss.
   */
  async readFleetEffect(runId: string, ref: string): Promise<string> {
    const stored = decodeRef(ref);
    if (stored.kind !== 'effect' || stored.runId !== runId) throw new Error('fleet record is outside the requested run');
    const parsed = decodeEnvelope(JSON.parse((await this.journal.read(stored.raw, stored.sourceIdentity, { permitSensitive: true })).toString('utf8')));
    if (parsed.kind !== 'effect' || parsed.runId !== runId) throw new Error('fleet record does not match durable bytes');
    return parsed.text;
  }

  async readFleetEffectByIdentity(runId: string, sourceIdentity: string): Promise<string | undefined> {
    const record = await this.readFleetEffectRecordByIdentity(runId, sourceIdentity);
    return record?.text;
  }

  /** Hash-checked immutable terminal evidence, including its raw reference. */
  async readFleetEffectRecordByIdentity(runId: string, sourceIdentity: string): Promise<Readonly<{ text: string; evidenceRef: string }> | undefined> {
    const metadata = (await this.journal.metadata()).find((entry) => entry.sourceIdentity === sourceIdentity);
    if (!metadata) return undefined;
    const parsed = decodeEnvelope(JSON.parse((await this.journal.read(metadata.raw, metadata.sourceIdentity, { permitSensitive: true })).toString('utf8')));
    if (parsed.kind !== 'effect' || parsed.runId !== runId) throw new Error('fleet record does not match durable bytes');
    return Object.freeze({ text: parsed.text, evidenceRef: metadata.raw.ref });
  }

  /**
   * New terminals select one accepted report through hash-checked disposition
   * lineage. Legacy terminals retain the exact-one-valid-envelope rule.
   */
  async readFleetTerminalResult(input: Readonly<{ attemptId: string; evidenceRefs: readonly string[]; commandId?: string; sessionId?: string }>): Promise<WorkerResult | undefined> {
    try {
      const selected = await selectTrustedEnvelopeLineage({
        attemptId: input.attemptId, commandId: input.commandId, sessionId: input.sessionId,
        evidenceRefs: input.evidenceRefs, metadata: await this.journal.metadata(),
        read: (raw, sourceIdentity) => this.journal.read(raw, sourceIdentity),
      });
      return selected?.result;
    } catch { return undefined; }
  }

  /** Fresh fleet state without scanning unrelated execution artifacts. */
  readFleetProjection(runId: string): Pick<HostSnapshot, 'commands' | 'attempts'> {
    const projection = this.kernel.host.readRun(runId);
    return { commands: projection.commands, attempts: projection.attempts };
  }

  /** Trusted relation for lifecycle accounting; independent of Attempt.commandIds history. */
  commandAttempt(commandId: string): CommandAttemptBinding | undefined { return this.kernel.host.commandAttempt(commandId); }

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
      attemptLifecycles: projection.attemptLifecycles,
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

export { nativeCommandConfigSchema, nativeCommandDigest, nativeCommandIdentity, nativeCommandKinds, runNativeCommand, observeNativeCommand, createNativeCommandEnvironment } from './native-command.js';
export type { NativeCommandConfig, NativeCommandEnvironment, NativeCommandResult } from './native-command.js';
