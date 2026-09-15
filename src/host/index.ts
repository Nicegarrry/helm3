import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AutonomyLease, Command, Observation, OrchestratorLease, Precondition, RawArtifactRef } from '../contracts/index.js';
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

type StoredArtifactRef = Readonly<{ schemaVersion: 1; sourceIdentity: string; raw: RawArtifactRef }>;

function encodeRef(value: StoredArtifactRef): string { return JSON.stringify(value); }
function decodeRef(value: string): StoredArtifactRef {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid host artifact reference');
  const item = parsed as Partial<StoredArtifactRef>;
  if (item.schemaVersion !== 1 || typeof item.sourceIdentity !== 'string' || !item.sourceIdentity
    || typeof item.raw !== 'object' || item.raw === null) throw new Error('invalid host artifact reference');
  const raw = item.raw as Partial<RawArtifactRef>;
  if (typeof raw.ref !== 'string' || typeof raw.hash !== 'string' || typeof raw.mediaType !== 'string') throw new Error('invalid host artifact reference');
  return { schemaVersion: 1, sourceIdentity: item.sourceIdentity, raw: { ref: raw.ref, hash: raw.hash, mediaType: raw.mediaType } };
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
  constructor(private readonly journal: ArtifactJournal) {}

  async writeText(source: string, text: string, sourceIdentity = `${source}:${randomUUID()}`): Promise<string> {
    const raw = await this.journal.append({ source, sourceIdentity, mediaType: 'text/plain; charset=utf-8', bytes: Buffer.from(text) });
    return encodeRef({ schemaVersion: 1, sourceIdentity, raw });
  }

  async readText(ref: string): Promise<string> {
    const stored = decodeRef(ref);
    return (await this.journal.read(stored.raw, stored.sourceIdentity)).toString('utf8');
  }

  async saveInvocation(input: { driver: 'fable' | 'astra'; sessionId: string; providerSessionId?: string; outcome: InvocationOutcome; text: string }): Promise<string> {
    return this.writeText('host.orchestrator.invocation', JSON.stringify(input));
  }

  async saveRecoveryBundle(bundle: RecoveryBundle): Promise<string> {
    return this.writeText('host.orchestrator.recovery_bundle', JSON.stringify(bundle));
  }

  async loadRecoveryBundle(ref: string): Promise<RecoveryBundle> {
    const parsed: unknown = JSON.parse(await this.readText(ref));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid durable recovery bundle');
    const bundle = parsed as Partial<RecoveryBundle>;
    if ((bundle.driver !== 'fable' && bundle.driver !== 'astra') || typeof bundle.runId !== 'string'
      || typeof bundle.sessionId !== 'string' || (bundle.mode !== 'primary' && bundle.mode !== 'consultant')
      || !Array.isArray(bundle.contextRefs) || !Array.isArray(bundle.eventRefs) || typeof bundle.recoveryStateRef !== 'string') {
      throw new Error('invalid durable recovery bundle');
    }
    return bundle as RecoveryBundle;
  }
}

/** Provider-free Pi-shaped runtime for local vertical-slice and recovery tests. */
export class FauxPiRuntime implements HostRuntime {
  readonly effects: string[] = [];

  async createEffect(input: Readonly<{ command: Command; artifacts: HostArtifactStore }>): Promise<KernelEffect> {
    const effectId = `faux-pi:${input.command.commandId}`;
    let receiptRef: string | undefined;
    return {
      effectId,
      execute: async () => {
        receiptRef = await input.artifacts.writeText('faux-pi.completed', JSON.stringify({
          runId: input.command.runId, commandId: input.command.commandId, sessionId: `faux-pi:${input.command.commandId}`,
        }), `faux-pi:${input.command.commandId}:completed`);
        this.effects.push(input.command.commandId);
      },
      observe: async () => ({
        commandId: input.command.commandId,
        effectId,
        state: 'succeeded',
        source: 'faux-pi',
        observedAt: new Date().toISOString(),
        evidenceRefs: [receiptRef ?? 'host:faux-pi-receipt-missing'],
      }),
    };
  }
}

export class HostControlPlane {
  readonly artifacts: HostArtifactStore;

  private constructor(
    private readonly kernel: ReturnType<typeof openKernel>,
    private readonly journal: ArtifactJournal,
    private readonly runtime?: HostRuntime,
  ) { this.artifacts = new HostArtifactStore(journal); }

  static async open(options: HostOptions): Promise<HostControlPlane> {
    await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
    const kernel = openKernel({ databasePath: join(options.stateDirectory, 'kernel.sqlite'), kinds: options.kinds, now: options.now });
    const journal = await ArtifactJournal.open({ root: join(options.stateDirectory, 'journal') });
    return new HostControlPlane(kernel, journal, options.runtime);
  }

  /** The caller must have already recorded the human grant and autonomy lease. */
  recordHumanAuthority(grant: HumanAuthorityGrant): void { this.kernel.host.declareHumanAuthority(grant); }
  /** Records an externally authorised autonomy lease; this method never creates or renews one. */
  recordAutonomyLease(lease: AutonomyLease): void { this.kernel.host.issueAutonomyLease(lease); }

  acquireOwnership(lease: OrchestratorLease, expectedEpoch: number): OrchestratorLease {
    return this.kernel.host.acquireOwnership(lease, expectedEpoch);
  }

  /**
   * Bind the random session ID generated by Fable/Astra before its first
   * recovery capture. This is the only start path the durable host exposes.
   */
  createSessionGuard(authority: DriverStartAuthority): OrchestratorSessionGuard {
    let startAuthorised = false;
    return {
      authorizeStart: async (input) => {
        if (startAuthorised || input.runId !== authority.runId || input.driver !== authority.owner || input.mode !== 'primary') {
          throw new Error('host start binding refused');
        }
        this.acquireOwnership({
          runId: authority.runId,
          leaseId: authority.leaseId,
          owner: authority.owner,
          sessionId: input.sessionId,
          epoch: authority.expectedEpoch + 1,
          issuedAt: authority.issuedAt,
          expiresAt: authority.expiresAt,
        }, authority.expectedEpoch);
        startAuthorised = true;
      },
      assertCurrent: async (input) => {
        const ownership = this.kernel.host.readRun(input.runId).ownership;
        if (!ownership || input.mode !== 'primary' || ownership.owner !== authority.owner || ownership.sessionId !== input.sessionId) {
          throw new Error('orchestrator session is not the current durable owner');
        }
      },
    };
  }

  /** Trusted driver/tool adapters may submit only as the fenced session owner. */
  admitOrchestrator(intent: unknown, context: HelmToolExecutionContext, actorId: string): CommandRecord {
    const ownership = this.kernel.host.readRun(context.runId).ownership;
    if (!ownership || context.mode !== 'primary' || ownership.sessionId !== context.sessionId) throw new Error('orchestrator session is not the current durable owner');
    return this.kernel.host.admit(intent, { actorId, sessionId: context.sessionId, allowedOrigins: ['orchestrator'] });
  }

  async perform(commandId: string, executor: TrustedExecutor, claimExpiresAt: string, readFact: (precondition: Precondition) => Promise<Observation<boolean>>): Promise<EffectObservation> {
    if (!this.runtime) throw new Error('host has no trusted runtime effect binding');
    const record = this.kernel.kernel.getCommand(commandId);
    if (!record) throw new Error('unknown command');
    const effect = await this.runtime.createEffect({ command: record.command, artifacts: this.artifacts });
    const claim = this.kernel.host.claim(commandId, executor, claimExpiresAt);
    return this.kernel.host.perform(commandId, claim, executor, readFact, effect);
  }

  async snapshot(runId: string): Promise<HostSnapshot> {
    const projection = this.kernel.host.readRun(runId);
    const metadata = await this.journal.metadata();
    const ordinary = metadata.filter((entry) => entry.classification === 'ordinary');
    const evidenceRefs = new Set(projection.commands.flatMap((record) => record.observations.flatMap((observation) => observation.evidenceRefs)));
    const encoded = (entry: ArtifactMetadata) => encodeRef({ schemaVersion: 1, sourceIdentity: entry.sourceIdentity, raw: entry.raw });
    const recoveryEntries = await Promise.all(ordinary
      .filter((entry) => entry.source === 'host.orchestrator.recovery_bundle' || entry.source === 'host.recovery')
      .map(async (entry) => {
        try {
          const value: unknown = JSON.parse(await this.journal.read(entry.raw, entry.sourceIdentity).then((bytes) => bytes.toString('utf8')));
          const candidate = value as { runId?: unknown };
          return candidate.runId === runId ? entry : undefined;
        } catch { return undefined; }
      }));
    return {
      runId,
      ...(projection.ownership ? { ownership: projection.ownership } : {}),
      commands: projection.commands,
      attempts: projection.attempts,
      autonomyLeases: projection.autonomyLeases,
      reservations: projection.reservations,
      artifacts: ordinary.filter((entry) => evidenceRefs.has(encoded(entry))).map((entry) => ({ source: entry.source, ref: encoded(entry) })),
      recoveryRefs: recoveryEntries.filter((entry): entry is ArtifactMetadata => Boolean(entry)).map(encoded),
    };
  }

  /** Restart recovery is deterministic: in-flight effects become unknown and are never replayed blindly. */
  async recover(runId: string): Promise<HostSnapshot> {
    this.kernel.host.recoverAfterRestart();
    return this.snapshot(runId);
  }

  recoveryState(): OrchestratorRecoveryState {
    return {
      capture: async (input) => ({ recoveryStateRef: await this.artifacts.writeText('host.recovery', JSON.stringify(await this.snapshot(input.runId))) }),
      restore: async (ref) => this.artifacts.readText(ref),
    };
  }

  close(): void { this.journal.close(); this.kernel.host.close(); }
}

export async function openHost(options: HostOptions): Promise<HostControlPlane> { return HostControlPlane.open(options); }
