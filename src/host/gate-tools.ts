import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod/v3';
import type { Command, Observation, Precondition } from '../contracts/index.js';
import type { EffectObservation, KernelEffect, TrustedExecutor } from '../core/index.js';
import { runGate, type GateCheck } from '../verification/index.js';
import type { HostArtifactStore } from './index.js';
import { HelmToolRegistry, type HelmTool, type HelmToolExecutionContext, type HelmToolResult } from '../runtime/orchestrator/index.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'must be an exact lowercase Git SHA');
const nonEmpty = z.string().min(1).max(128).refine((value) => value.trim() === value, 'must not have surrounding whitespace');
const path = z.string().min(1).max(4096);
const artifactIdentity = z.string().min(1).max(512);

/** The only model-selected gate inputs: registered identifiers and an exact expected head. */
export const gateRunToolInput = {
  gateId: nonEmpty,
  workerId: nonEmpty,
  expectedHead: sha,
} as const;

/** Immutable, JSON-only facts a trusted host binds into every gate.run command. */
export const gateRunPayloadSchema = z.object({
  gateId: nonEmpty,
  workerId: nonEmpty,
  workspaceId: nonEmpty,
  expectedHead: sha,
  acceptanceVersion: nonEmpty,
  gateConfigDigest: nonEmpty,
  trustedDefinitionRef: nonEmpty,
}).strict();
export type GateRunPayload = z.infer<typeof gateRunPayloadSchema>;

export type RegisteredGate = Readonly<{
  gateId: string;
  workerId: string;
  repositoryId: string;
  mapNodeId?: string;
  workspaceId: string;
  workspace: string;
  expectedHead: string;
  acceptanceVersion: string;
  checks: readonly GateCheck[];
  /** Trusted environment selected by host configuration, never by a tool invocation. */
  environment: Readonly<Record<string, string>>;
}>;
type GateSnapshot = Readonly<RegisteredGate & { gateConfigDigest: string; trustedDefinitionRef: string }>;

/** A host registry resolves gate IDs and worker IDs to fixed configuration. */
export type GateCatalog = Readonly<{ resolve(gateId: string, workerId: string): Promise<RegisteredGate> }>;

export type GateCommandBinding = Readonly<{
  actorId: string;
  leaseId: string;
  leaseRevision: number;
  orchestratorLeaseId: string;
  orchestratorEpoch: number;
  plannedAt(): string;
  notAfter(): string;
  commandId?(): string;
}>;

/** The narrow privileged host surface required for an already-admitted gate effect. */
export type GateToolHost = Readonly<{
  artifactsFor(context: HelmToolExecutionContext): HostArtifactStore;
  admitOrchestrator(intent: unknown, context: HelmToolExecutionContext, actorId: string): { command: Command };
  performAdmitted(
    commandId: string,
    executor: TrustedExecutor,
    claimExpiresAt: string,
    readFact: (precondition: Precondition) => Promise<Observation<boolean>>,
    effect: KernelEffect,
  ): Promise<EffectObservation>;
  assertEffectAuthority(commandId: string, context: HelmToolExecutionContext): void;
}>;

export type HostGateToolOptions = Readonly<{
  context: HelmToolExecutionContext;
  authorize(context: HelmToolExecutionContext): Promise<void>;
  host: GateToolHost;
  catalog: GateCatalog;
  command: GateCommandBinding;
  executor: TrustedExecutor;
  claimExpiresAt(): string;
}>;

function payloadHash(payload: GateRunPayload): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

/** Canonical digest of the complete host-selected definition, excluding no executable fact. */
export function gateConfigDigest(target: RegisteredGate): string {
  const definition = {
    gateId: target.gateId, workerId: target.workerId, repositoryId: target.repositoryId, mapNodeId: target.mapNodeId ?? null,
    workspaceId: target.workspaceId, workspace: target.workspace, expectedHead: target.expectedHead,
    acceptanceVersion: target.acceptanceVersion,
    checks: target.checks.map((check) => ({ name: check.name, executable: check.executable, args: [...check.args], timeoutMs: check.timeoutMs })),
    environment: Object.fromEntries(Object.entries(target.environment).sort(([left], [right]) => left.localeCompare(right))),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(definition)).digest('hex')}`;
}

const registeredGateSchema = z.object({
  gateId: nonEmpty, workerId: nonEmpty, repositoryId: nonEmpty, mapNodeId: nonEmpty.optional(), workspaceId: nonEmpty, workspace: path,
  expectedHead: sha, acceptanceVersion: nonEmpty,
  checks: z.array(z.object({ name: nonEmpty, executable: path, args: z.array(z.string().min(1).max(2048)).max(64), timeoutMs: z.number().int().min(1).max(300000) }).strict()).min(1).max(32),
  environment: z.record(z.string().min(1).max(256), z.string().max(8192)),
}).strict();

/** Snapshot and deep-freeze every executable fact before command admission. */
function snapshotGate(value: unknown): GateSnapshot {
  const parsed = registeredGateSchema.parse(value);
  const target: RegisteredGate = Object.freeze({
    ...parsed,
    checks: Object.freeze(parsed.checks.map((check) => Object.freeze({ ...check, args: Object.freeze([...check.args]) }))),
    environment: Object.freeze(Object.fromEntries(Object.entries(parsed.environment).sort(([left], [right]) => left.localeCompare(right)))),
  });
  const digest = gateConfigDigest(target);
  return Object.freeze({ ...target, gateConfigDigest: digest, trustedDefinitionRef: `gate-definition:${digest}` });
}

function matchesContext(actual: HelmToolExecutionContext, expected: HelmToolExecutionContext): boolean {
  return actual.runId === expected.runId && actual.sessionId === expected.sessionId && actual.mode === expected.mode;
}

async function authorize(options: HostGateToolOptions, actual: HelmToolExecutionContext): Promise<HelmToolResult | undefined> {
  if (!matchesContext(actual, options.context) || actual.mode !== 'primary') {
    return { state: 'refused', reason: 'gate tool context is outside the trusted host binding' };
  }
  try { await options.authorize(actual); }
  catch { return { state: 'refused', reason: 'gate tool context is outside the trusted host binding' }; }
  return undefined;
}

function commandFor(options: HostGateToolOptions, target: GateSnapshot): Command {
  const payload: GateRunPayload = {
    gateId: target.gateId,
    workerId: target.workerId,
    workspaceId: target.workspaceId,
    expectedHead: target.expectedHead,
    acceptanceVersion: target.acceptanceVersion,
    gateConfigDigest: target.gateConfigDigest,
    trustedDefinitionRef: target.trustedDefinitionRef,
  };
  const commandId = options.command.commandId?.() ?? `gate-run-${randomUUID()}`;
  return {
    schemaVersion: 1,
    commandId,
    kind: 'gate.run',
    // Each invocation receives a fresh bounded attempt. Core still protects a
    // replay of this exact immutable command ID.
    idempotencyKey: commandId,
    payloadHash: payloadHash(payload),
    scope: { repositoryId: target.repositoryId, ...(target.mapNodeId ? { mapNodeId: target.mapNodeId } : {}) },
    actorId: options.command.actorId,
    runId: options.context.runId,
    origin: 'orchestrator',
    leaseId: options.command.leaseId,
    leaseRevision: options.command.leaseRevision,
    orchestratorLeaseId: options.command.orchestratorLeaseId,
    orchestratorEpoch: options.command.orchestratorEpoch,
    plannedAt: options.command.plannedAt(),
    notAfter: options.command.notAfter(),
    expected: [{ authority: 'git', subject: target.workspaceId, version: target.expectedHead, predicate: 'registered workspace is clean at the exact expected head' }],
    payload,
    requiredEvidence: [target.trustedDefinitionRef, target.gateConfigDigest, target.acceptanceVersion],
  };
}

async function gateFact(target: GateSnapshot, precondition: Precondition): Promise<Observation<boolean>> {
  const observedAt = new Date().toISOString();
  if (precondition.authority !== 'git' || precondition.subject !== target.workspaceId || precondition.version !== target.expectedHead) {
    return { state: 'unknown', value: null, source: 'host.gate', observedAt, reason: 'gate precondition is outside registered workspace facts' };
  }
  try {
    const head = execFileSync('git', ['-C', target.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }).trim();
    const clean = execFileSync('git', ['-C', target.workspace, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }) === '';
    return { state: 'known', value: head === target.expectedHead && clean, source: 'host.gate.workspace', observedAt: new Date().toISOString(), subjectVersion: head };
  } catch {
    return { state: 'unknown', value: null, source: 'host.gate.workspace', observedAt, reason: 'registered workspace observation is unavailable' };
  }
}

/**
 * One effect-bound gate tool. Tool JSON never carries a shell command, path,
 * gate configuration, budget, lease, or authority. The host resolves all of
 * those before admitting an immutable Core command.
 */
export function createHostGateTool(options: HostGateToolOptions): HelmTool {
  const bound = Object.freeze({ ...options, context: Object.freeze({ ...options.context }) });
  return {
    name: 'gate.run',
    description: 'Run one host-registered gate against a registered worker workspace and exact Git head.',
    input: gateRunToolInput,
    async execute(raw: Record<string, unknown>, actual: HelmToolExecutionContext): Promise<HelmToolResult> {
      const refusal = await authorize(bound, actual); if (refusal) return refusal;
      const parsed = z.object(gateRunToolInput).strict().safeParse(raw);
      if (!parsed.success) return { state: 'refused', reason: 'gate input must contain only a registered gate ID, worker ID, and exact expected head' };
      const input = parsed.data;
      let target: GateSnapshot;
      try { target = snapshotGate(await bound.catalog.resolve(input.gateId, input.workerId)); }
      catch { return { state: 'refused', reason: 'gate or worker is not registered for this host run' }; }
      if (target.gateId !== input.gateId || target.workerId !== input.workerId || target.expectedHead !== input.expectedHead) {
        return { state: 'refused', reason: 'gate input does not match the registered trusted target' };
      }
      if (!target.checks.length) return { state: 'refused', reason: 'registered gate has no configured checks' };
      let admitted: { command: Command };
      try { admitted = bound.host.admitOrchestrator(commandFor(bound, target), actual, bound.command.actorId); }
      catch { return { state: 'refused', reason: 'gate command was refused by current Helm authority' }; }

      let terminal: EffectObservation | undefined;
      const effect: KernelEffect = {
        effectId: `host:gate:${admitted.command.commandId}`,
        execute: async () => {
          // Re-fence immediately before the verifier can start a child process.
          await bound.authorize(actual);
          // A registry may be backed by mutable external configuration. It is
          // re-read at effect time, but execution continues only with the
          // immutable planned snapshot when all material facts still agree.
          const fresh = snapshotGate(await bound.catalog.resolve(input.gateId, input.workerId));
          if (fresh.gateConfigDigest !== target.gateConfigDigest || fresh.acceptanceVersion !== target.acceptanceVersion || fresh.expectedHead !== target.expectedHead) {
            throw new Error('registered gate definition changed before effect');
          }
          bound.host.assertEffectAuthority(admitted.command.commandId, actual);
          const artifacts = bound.host.artifactsFor(actual);
          const { result, evidence } = await runGate({
            gateId: target.gateId,
            workspace: target.workspace,
            expectedHead: target.expectedHead,
            checks: target.checks,
            journal: artifacts.journalForTrustedPi(),
            env: { ...target.environment },
            assertAuthority: async () => {
              await bound.authorize(actual);
              bound.host.assertEffectAuthority(admitted.command.commandId, actual);
            },
          });
          const evidenceRefs = [evidence.ref, ...result.checks.map((check) => check.evidence.ref)];
          terminal = {
            commandId: admitted.command.commandId,
            effectId: `host:gate:${admitted.command.commandId}`,
            state: result.state === 'passed' && result.observedHead === target.expectedHead ? 'succeeded' : result.state === 'failed' ? 'failed' : 'unknown',
            source: 'host.gate.run',
            observedAt: result.completedAt,
            evidenceRefs,
            ...(result.reason ? { detail: result.reason } : {}),
          };
          // Keep a completed-but-uncertain verifier result observable with its
          // raw evidence. The Core records it as unknown and never treats it
          // as a successful effect.
        },
        observe: async () => terminal ?? {
          commandId: admitted.command.commandId,
          effectId: `host:gate:${admitted.command.commandId}`,
          state: 'unknown', source: 'host.gate.run', observedAt: new Date().toISOString(), evidenceRefs: ['host:gate-observation-missing'],
        },
      };
      let observed: EffectObservation;
      try {
        observed = await bound.host.performAdmitted(admitted.command.commandId, bound.executor, bound.claimExpiresAt(), (fact) => gateFact(target, fact), effect);
      } catch {
        return { state: 'unknown', reason: 'gate effect outcome is unavailable' };
      }
      if (observed.state === 'succeeded' || observed.state === 'failed') {
        // A red gate is a complete, useful observation rather than a tool-transport error.
        return { state: 'succeeded', value: { commandId: admitted.command.commandId, gateState: observed.state, evidenceRefs: observed.evidenceRefs, ...(observed.detail ? { detail: observed.detail } : {}) } };
      }
      return { state: 'unknown', reason: observed.detail ?? 'gate outcome is unknown' };
    },
  };
}

/** Compose this mutating tool with the one host-owned registry used by every driver. */
export function appendHostGateTool(base: HelmToolRegistry, options: HostGateToolOptions): HelmToolRegistry {
  return new HelmToolRegistry([...base.all(), createHostGateTool(options)]);
}
