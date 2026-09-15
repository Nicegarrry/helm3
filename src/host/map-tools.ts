import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import type { Command, Observation, Precondition } from '../contracts/index.js';
import type { CommandRecord, EffectObservation, KernelEffect, TrustedExecutor } from '../core/index.js';
import type { HostArtifactStore, HostSnapshot } from './index.js';
import { HelmToolRegistry, type HelmTool, type HelmToolExecutionContext, type HelmToolResult } from '../runtime/orchestrator/index.js';
import { GitHubMapMutator, type MapMutationReceipt } from '../tracker/mutations.js';
import { GitHubMapTracker, type TrackerCommandTransport } from '../tracker/index.js';

const node = z.string().min(1).max(128).refine((value) => value.trim() === value);
const revision = z.string().datetime({ offset: false });
const text = z.string().min(1).max(65_536).refine((value) => value.trim() === value);
const evidenceRef = z.string().min(1).max(1024).refine((value) => value.trim() === value);
const dependency = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/);

export const mapUpdateToolInput = { node, expectedRevision: revision, title: text.optional(), body: text.optional() } as const;
export const mapCloseToolInput = { node, expectedRevision: revision, rationale: text, evidenceRefs: z.array(evidenceRef).min(1).max(32), resolvedDependencies: z.array(dependency).max(100) } as const;
const updateIntentSchema = z.object(mapUpdateToolInput).strict().superRefine((value, context) => { if (value.title === undefined && value.body === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'update needs title or body' }); });
const closeIntentSchema = z.object(mapCloseToolInput).strict();
export const mapUpdatePayloadSchema = z.object({ issueNumber: z.number().int().positive(), expectedRevision: revision, title: text.optional(), body: text.optional() }).strict().superRefine((value, context) => {
  if (value.title === undefined && value.body === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'update needs title or body' });
});
export const mapClosePayloadSchema = z.object({ issueNumber: z.number().int().positive(), expectedRevision: revision, rationale: text, evidenceRefs: z.array(evidenceRef).min(1).max(32), resolvedDependencies: z.array(dependency).max(100) }).strict();

export type RegisteredMapTarget = Readonly<{ node: string; repositoryId: string; parentIssue: number; issueNumber: number }>;
export type MapTargetCatalog = Readonly<{ resolve(node: string): Promise<RegisteredMapTarget> }>;
export type MapCommandBinding = Readonly<{ actorId: string; leaseId: string; leaseRevision: number; orchestratorLeaseId: string; orchestratorEpoch: number; plannedAt(): string; notAfter(): string }>;
export type ClosureEvidenceValidator = Readonly<{ validate(input: Readonly<{ context: HelmToolExecutionContext; target: RegisteredMapTarget; evidenceRefs: readonly string[] }>): Promise<void> }>;
export type RegisteredGateClosureProof = Readonly<{ evidenceRef: string; runId: string; repositoryId: string; mapNodeId: string; gateCommandId: string; predecessorCommandId: string; workerId: string; workspace: string; expectedHead: string }>;
type GateEvidenceHost = Readonly<{ assertGateEvidence(runId: string, gateCommandId: string, predecessorCommandId: string, workerId: string, workspace: string, expectedHead: string, evidenceRefs: readonly string[]): Promise<void> }>;
export type MapToolHost = Readonly<{
  artifactsFor(context: HelmToolExecutionContext): HostArtifactStore;
  snapshot(runId: string): Promise<HostSnapshot>;
  admitOrchestrator(intent: unknown, context: HelmToolExecutionContext, actorId: string): CommandRecord;
  performAdmitted(commandId: string, executor: TrustedExecutor, claimExpiresAt: string, readFact: (precondition: Precondition) => Promise<Observation<boolean>>, effect: KernelEffect): Promise<EffectObservation>;
  assertEffectAuthority(commandId: string, context: HelmToolExecutionContext): void;
}>;
export type HostMapToolOptions = Readonly<{ context: HelmToolExecutionContext; authorize(context: HelmToolExecutionContext): Promise<void>; host: MapToolHost; catalog: MapTargetCatalog; transport: TrackerCommandTransport; command: MapCommandBinding; executor: TrustedExecutor; claimExpiresAt(): string; closureEvidence: ClosureEvidenceValidator }>;

/**
 * Production closure policy for registered gate evidence. The registry is
 * host configuration, never tool input: a model can present a ref but cannot
 * attach it to another worker, workspace, target, or gate command.
 */
export function createRegisteredGateClosureValidator(input: Readonly<{ host: GateEvidenceHost; proofs: readonly RegisteredGateClosureProof[] }>): ClosureEvidenceValidator {
  const proofs = new Map(input.proofs.map((proof) => [proof.evidenceRef, Object.freeze({ ...proof })]));
  if (proofs.size !== input.proofs.length) throw new Error('registered gate evidence refs must be unique');
  return Object.freeze({ async validate(value) {
    if (!value.evidenceRefs.length) throw new Error('closure requires registered gate evidence');
    for (const ref of value.evidenceRefs) {
      const proof = proofs.get(ref);
      if (!proof || proof.runId !== value.context.runId || proof.repositoryId !== value.target.repositoryId || proof.mapNodeId !== String(value.target.issueNumber)) throw new Error('gate proof is outside the current Map target');
      await input.host.assertGateEvidence(proof.runId, proof.gateCommandId, proof.predecessorCommandId, proof.workerId, proof.workspace, proof.expectedHead, [proof.evidenceRef]);
    }
  } });
}

type Intent = Readonly<{ action: 'update'; node: string; expectedRevision: string; title?: string; body?: string }> | Readonly<{ action: 'close'; node: string; expectedRevision: string; rationale: string; evidenceRefs: readonly string[]; resolvedDependencies: readonly string[] }>;
type StoredReceipt = Readonly<{ command: Command; receipt: MapMutationReceipt }>;
function hash(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function stableId(runId: string, target: RegisteredMapTarget, intent: Intent): string { return `map-${hash({ runId, repositoryId: target.repositoryId, issueNumber: target.issueNumber, intent }).slice('sha256:'.length)}`; }
function sameContext(actual: HelmToolExecutionContext, expected: HelmToolExecutionContext): boolean { return actual.runId === expected.runId && actual.sessionId === expected.sessionId && actual.mode === expected.mode; }
function freezeIntent(value: Intent): Intent { return Object.freeze(value.action === 'close' ? { ...value, evidenceRefs: Object.freeze([...value.evidenceRefs]), resolvedDependencies: Object.freeze([...value.resolvedDependencies]) } : { ...value }); }
function commandFor(options: HostMapToolOptions, target: RegisteredMapTarget, intent: Intent, id: string): Command {
  const payload = intent.action === 'update'
    ? { issueNumber: target.issueNumber, expectedRevision: intent.expectedRevision, ...(intent.title === undefined ? {} : { title: intent.title }), ...(intent.body === undefined ? {} : { body: intent.body }) }
    : { issueNumber: target.issueNumber, expectedRevision: intent.expectedRevision, rationale: intent.rationale, evidenceRefs: [...intent.evidenceRefs], resolvedDependencies: [...intent.resolvedDependencies] };
  return { schemaVersion: 1, commandId: id, kind: `map.${intent.action}`, idempotencyKey: id, payloadHash: hash(payload), scope: { repositoryId: target.repositoryId, mapNodeId: String(target.issueNumber) }, actorId: options.command.actorId, runId: options.context.runId, origin: 'orchestrator', leaseId: options.command.leaseId, leaseRevision: options.command.leaseRevision, orchestratorLeaseId: options.command.orchestratorLeaseId, orchestratorEpoch: options.command.orchestratorEpoch, plannedAt: options.command.plannedAt(), notAfter: options.command.notAfter(), expected: [{ authority: 'github', subject: `repos/${target.repositoryId}/issues/${target.issueNumber}`, version: intent.expectedRevision, predicate: 'issue revision matches' }], payload, requiredEvidence: intent.action === 'close' ? [...intent.evidenceRefs] : [] };
}
function outcome(receipt: MapMutationReceipt): HelmToolResult {
  if (receipt.state === 'succeeded') return { state: 'succeeded', value: { commandId: receipt.commandId, receipt } };
  if (receipt.state === 'refused') return { state: 'refused', reason: receipt.reason ?? 'Map mutation was refused' };
  return { state: 'unknown', reason: `Map mutation ${receipt.commandId} needs reconciliation${receipt.reason ? `: ${receipt.reason}` : ''}` };
}
async function trackerFact(target: RegisteredMapTarget, transport: TrackerCommandTransport, precondition: Precondition): Promise<Observation<boolean>> {
  const observedAt = new Date().toISOString();
  if (precondition.authority !== 'github' || precondition.subject !== `repos/${target.repositoryId}/issues/${target.issueNumber}`) return { state: 'unknown', value: null, source: 'host.map.tracker', observedAt, reason: 'precondition is outside the registered Map target' };
  try {
    const snapshot = await new GitHubMapTracker({ repo: target.repositoryId, parentIssue: target.parentIssue, transport }).snapshot();
    const current = snapshot.nodes.find((item) => item.number === target.issueNumber);
    if (snapshot.completeness !== 'complete' || !current) return { state: 'unknown', value: null, source: 'host.map.tracker', observedAt, reason: 'fresh Map target observation is unavailable' };
    return { state: 'known', value: current.updatedAt === precondition.version, source: 'host.map.tracker', observedAt: snapshot.observedAt, subjectVersion: current.updatedAt };
  } catch { return { state: 'unknown', value: null, source: 'host.map.tracker', observedAt, reason: 'fresh Map target observation is unavailable' }; }
}
async function storedOutcome(host: MapToolHost, context: HelmToolExecutionContext, record: CommandRecord): Promise<HelmToolResult> {
  if (record.status === 'unknown' || record.status === 'claimed' || record.status === 'effect_started' || record.status === 'observing' || record.status === 'queued') return { state: 'unknown', reason: `Map mutation ${record.command.commandId} requires reconciliation` };
  const ref = record.observations.at(-1)?.evidenceRefs.find((item) => item.startsWith('{'));
  if (!ref) return record.status === 'succeeded' ? { state: 'unknown', reason: `Map mutation ${record.command.commandId} has no durable receipt` } : { state: 'refused', reason: 'Map mutation was refused' };
  try { return outcome((JSON.parse(await host.artifactsFor(context).readEffect(ref)) as StoredReceipt).receipt); }
  catch { return { state: 'unknown', reason: `Map mutation ${record.command.commandId} receipt is unavailable` }; }
}

function tool(options: HostMapToolOptions, action: Intent['action']): HelmTool {
  const bound = Object.freeze({ ...options, context: Object.freeze({ ...options.context }) });
  const input = action === 'update' ? mapUpdateToolInput : mapCloseToolInput;
  return { name: `map.${action}`, description: action === 'update' ? 'Update a registered Map node title or body.' : 'Close a registered Map node after host-verified evidence and dependency checks.', input,
    async execute(raw, actual) {
      const parsed = (action === 'update' ? updateIntentSchema.safeParse(raw) : closeIntentSchema.safeParse(raw));
      if (!parsed.success) return { state: 'refused', reason: 'map intent is malformed' };
      const value = parsed.data as Record<string, unknown>;
      const intent = freezeIntent(action === 'update'
        ? { action, node: value.node as string, expectedRevision: value.expectedRevision as string, ...(value.title === undefined ? {} : { title: value.title as string }), ...(value.body === undefined ? {} : { body: value.body as string }) }
        : { action, node: value.node as string, expectedRevision: value.expectedRevision as string, rationale: value.rationale as string, evidenceRefs: value.evidenceRefs as string[], resolvedDependencies: value.resolvedDependencies as string[] });
      if (!sameContext(actual, bound.context) || actual.mode !== 'primary') return { state: 'refused', reason: 'map tool context is outside the trusted host binding' };
      try { await bound.authorize(actual); } catch { return { state: 'refused', reason: 'map tool context is outside the trusted host binding' }; }
      let target: RegisteredMapTarget;
      try { target = Object.freeze({ ...(await bound.catalog.resolve(intent.node)) }); } catch { return { state: 'refused', reason: 'Map node is not registered for this host' }; }
      if (target.node !== intent.node) return { state: 'refused', reason: 'Map node is not registered for this host' };
      if (intent.action === 'close') try { await bound.closureEvidence.validate({ context: actual, target, evidenceRefs: intent.evidenceRefs }); } catch { return { state: 'refused', reason: 'closure evidence is not host-verified for this Map node' }; }
      const id = stableId(actual.runId, target, intent); const existing = (await bound.host.snapshot(actual.runId)).commands.find((record) => record.command.commandId === id);
      if (existing) return storedOutcome(bound.host, actual, existing);
      let admitted: CommandRecord;
      try { admitted = bound.host.admitOrchestrator(commandFor(bound, target, intent, id), actual, bound.command.actorId); } catch { return { state: 'refused', reason: 'Map command was refused by current Helm authority' }; }
      const closureRefs = intent.action === 'close' ? intent.evidenceRefs : undefined;
      let receipt: MapMutationReceipt | undefined; let receiptRef: string | undefined;
      const effect: KernelEffect = { effectId: `host:map:${id}`, execute: async (command) => {
        if (intent.action === 'close') await bound.closureEvidence.validate({ context: actual, target, evidenceRefs: intent.evidenceRefs });
        bound.host.assertEffectAuthority(command.commandId, actual);
        receipt = await new GitHubMapMutator({ repo: target.repositoryId, parentIssue: target.parentIssue, transport: bound.transport }).mutate(command, async (request) => {
          bound.host.assertEffectAuthority(command.commandId, actual);
          return { commandId: request.command.commandId, idempotencyKey: request.command.idempotencyKey, commandHash: request.commandHash, ...(request.action === 'close' && closureRefs ? { verifiedEvidenceRefs: [...closureRefs] } : {}) };
        });
        receiptRef = await bound.host.artifactsFor(actual).writeEffect('host.map.mutation', JSON.stringify({ command, receipt }));
      }, observe: async () => ({ commandId: admitted.command.commandId, effectId: `host:map:${id}`, state: receipt?.state === 'succeeded' ? 'succeeded' : receipt?.state === 'refused' ? 'failed' : 'unknown', source: 'host.map.mutation', observedAt: receipt?.observedAt ?? new Date().toISOString(), evidenceRefs: [receiptRef ?? 'host:map-receipt-missing'], ...(receipt?.reason ? { detail: receipt.reason } : {}) }) };
      let observed: EffectObservation;
      try { observed = await bound.host.performAdmitted(admitted.command.commandId, bound.executor, bound.claimExpiresAt(), (precondition) => trackerFact(target, bound.transport, precondition), effect); } catch { return { state: 'unknown', reason: `Map mutation ${id} outcome is unavailable` }; }
      if (observed.state === 'unknown' || !receipt) return { state: 'unknown', reason: observed.detail ?? `Map mutation ${id} requires reconciliation` };
      return outcome(receipt);
    } };
}

/** Adds the same host-owned Map mutation surface to both Fable and Astra bridges. */
export function appendHostMapTools(base: HelmToolRegistry, options: HostMapToolOptions): HelmToolRegistry { return new HelmToolRegistry([...base.all(), tool(options, 'update'), tool(options, 'close')]); }
