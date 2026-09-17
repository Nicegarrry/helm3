import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v3';
import type { Attempt, AutonomyLease, Command, Observation, Precondition } from '../contracts/index.js';
import type { KernelKind } from '../core/index.js';
import { workerSpawnKind } from './worker-spawn-plan.js';
import type { HostControlPlane } from './index.js';
import { planWorkerSpawn, type WorkerSpawnPlan } from './worker-spawn-plan.js';
import type { WorkerSpawnIdentity, WorkerSpawnInput } from './worker-fleet.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import type { ModelFact } from '../core/index.js';
import { BoundedPiAccess, type BoundedPiAccessPolicy } from '../access/index.js';
import { settlementForBoundedPiEffect } from '../access/live.js';
import { createBoundedFleetRuntime } from './bounded-fleet-runtime.js';
import { PiWorkerFleet } from './worker-fleet.js';
import { WorkspaceManager } from '../workspace/index.js';
import type { Api, Model } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };
import type { ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };

const absolutePath = z.string().min(1).refine((value) => value.startsWith('/'), 'must be an absolute path');
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const timestamp = z.string().datetime({ offset: false });
// Endpoint identity is durable config.  Reject URL components that could
// carry credentials or mutable request material into the manifest/log path.
const endpointUrl = z.string().url().refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.username.length === 0 && parsed.password.length === 0 && parsed.search.length === 0 && parsed.hash.length === 0;
  } catch { return false; }
}, 'endpoint URL must not contain credentials, query, or fragment');

/**
 * OpenRouter routing is part of the immutable native-command input.  Keeping the
 * provider selector here makes the route auditable and prevents Pi's catalog
 * defaults from silently widening it (including fallback providers).
 */
export const openRouterRoutingSchema = z.object({
  allow_fallbacks: z.literal(false),
  require_parameters: z.literal(true),
  data_collection: z.literal('deny'),
  zdr: z.literal(true),
  only: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/)).min(1).max(8),
  quantizations: z.array(z.enum(['int4', 'int8', 'fp4', 'fp6', 'fp8', 'fp16', 'bf16', 'fp32'])).min(1).max(8).optional(),
  max_price: z.object({ prompt: z.number().finite().nonnegative(), completion: z.number().finite().nonnegative() }).strict(),
}).strict();
export type OpenRouterRouting = Readonly<z.infer<typeof openRouterRoutingSchema>>;
const openRouterModelSchema = z.object({ name: z.string().min(1).max(256), reasoning: z.boolean(), input: z.array(z.enum(['text', 'image'])).min(1).max(2) }).strict();
export type OpenRouterModelDefinition = Readonly<z.infer<typeof openRouterModelSchema>>;

/** Strict, versioned input for one native command. It contains references and
 * identities only; credential values are intentionally not representable. */
export const nativeCommandConfigSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  repositoryId: z.string().min(1).max(256),
  mapNodeId: z.string().min(1).max(256),
  mapNodeRevision: z.string().min(1).max(128),
  objectiveVersion: z.string().min(1).max(128),
  acceptanceVersion: z.string().min(1).max(128),
  stateDirectory: absolutePath,
  repository: absolutePath,
  destination: absolutePath,
  branch: z.string().min(1).max(128),
  baseSha: sha,
  writableRoots: z.array(z.string().min(1)).max(64),
  readableRoots: z.array(z.string().min(1)).max(64).optional(),
  protectedRoots: z.array(z.string().min(1)).max(64).optional(),
  objectiveRef: z.string().min(1).max(4096),
  acceptanceRef: z.string().min(1).max(4096),
  contextRefs: z.array(z.string().min(1).max(4096)).max(64),
  modelId: z.string().min(1).max(256),
  modelProvider: z.string().min(1).max(256),
  modelApi: z.string().min(1).max(256),
  modelBaseUrl: endpointUrl,
  modelFamily: z.string().min(1).max(256),
  modelFactVersion: z.number().int().positive(),
  openRouterRouting: openRouterRoutingSchema.optional(),
  openRouterModel: openRouterModelSchema.optional(),
  requiredCapabilities: z.array(z.string().min(1)).min(1).max(32),
  dataClassification: z.enum(['public', 'restricted']),
  credentialEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  autonomyLeaseId: z.string().min(1).max(256),
  autonomyLeaseRevision: z.number().int().positive(),
  ownershipLeaseId: z.string().min(1).max(256),
  ownershipEpoch: z.number().int().positive(),
  ownershipOwner: z.enum(['fable', 'astra']),
  ownershipSessionId: z.string().min(1).max(256),
  ownershipIssuedAt: timestamp,
  ownershipExpiresAt: timestamp,
  notAfter: timestamp,
  plannedAt: timestamp,
  policy: z.object({
    poolId: z.string().min(1).max(256),
    baseUrl: endpointUrl,
    authEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxBilledOutputTokens: z.number().int().positive(),
    maxPacketBytes: z.number().int().positive(),
    maxRequests: z.number().int().positive(),
    inputUsdPerMillion: z.number().finite().nonnegative(),
    outputUsdPerMillion: z.number().finite().nonnegative(),
    cacheReadUsdPerMillion: z.number().finite().nonnegative(),
    cacheWriteUsdPerMillion: z.number().finite().nonnegative(),
    maxToolCalls: z.number().int().nonnegative(),
    timeoutMs: z.number().int().positive(),
    allowCorrection: z.boolean().optional(),
  }).strict(),
}).strict().superRefine((config, context) => {
  if (config.policy.maxOutputTokens > config.policy.maxBilledOutputTokens) context.addIssue({ code: z.ZodIssueCode.custom, message: 'output cap exceeds billed output bound' });
  if (config.policy.baseUrl !== config.modelBaseUrl || config.policy.authEnvironment !== config.credentialEnvironment) context.addIssue({ code: z.ZodIssueCode.custom, message: 'policy endpoint or credential identity differs from model configuration' });
  if (config.modelProvider === 'openrouter' && !config.openRouterRouting) context.addIssue({ code: z.ZodIssueCode.custom, message: 'OpenRouter routing is required' });
  if (config.openRouterRouting && config.modelBaseUrl !== 'https://openrouter.ai/api/v1') context.addIssue({ code: z.ZodIssueCode.custom, message: 'OpenRouter endpoint must be pinned' });
  if (config.openRouterRouting && config.modelProvider !== 'openrouter') context.addIssue({ code: z.ZodIssueCode.custom, message: 'OpenRouter routing requires the openrouter provider' });
  if (config.openRouterRouting && config.modelApi !== 'openai-completions') context.addIssue({ code: z.ZodIssueCode.custom, message: 'inline OpenRouter model requires openai-completions API' });
  if (config.openRouterRouting && !config.openRouterModel) context.addIssue({ code: z.ZodIssueCode.custom, message: 'OpenRouter routing requires an inline model definition' });
  if (!config.openRouterRouting && config.openRouterModel) context.addIssue({ code: z.ZodIssueCode.custom, message: 'inline OpenRouter model requires routing policy' });
  if (config.openRouterRouting?.max_price && (config.openRouterRouting.max_price.prompt > config.policy.inputUsdPerMillion || config.openRouterRouting.max_price.completion > config.policy.outputUsdPerMillion)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'OpenRouter price cap exceeds the bounded policy rate' });
  const bound = (config.policy.contextWindow * (config.policy.inputUsdPerMillion + config.policy.cacheReadUsdPerMillion + config.policy.cacheWriteUsdPerMillion) + config.policy.maxBilledOutputTokens * config.policy.outputUsdPerMillion) / 1_000_000;
  if (!Number.isFinite(bound)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'resource upper bound is not finite' });
});
export type NativeCommandConfig = Readonly<z.infer<typeof nativeCommandConfigSchema>>;

/** Construct the exact model absent from Pi's bundled catalog, using only the
 * already validated native command fields and no external models.json input. */
export function inlineOpenRouterModel(config: NativeCommandConfig): Model<Api> {
  if (config.modelProvider !== 'openrouter' || !config.openRouterRouting || !config.openRouterModel) throw new Error('inline OpenRouter model configuration is absent');
  return {
    id: config.modelId, name: config.openRouterModel.name, api: config.modelApi as Api, provider: 'openrouter', baseUrl: config.modelBaseUrl,
    reasoning: config.openRouterModel.reasoning, input: [...config.openRouterModel.input], contextWindow: config.policy.contextWindow, maxTokens: config.policy.maxBilledOutputTokens,
    cost: { input: config.policy.inputUsdPerMillion, output: config.policy.outputUsdPerMillion, cacheRead: config.policy.cacheReadUsdPerMillion, cacheWrite: config.policy.cacheWriteUsdPerMillion },
    compat: { openRouterRouting: config.openRouterRouting },
  } as Model<Api>;
}

type Manifest = Readonly<{ schemaVersion: 1; digest: string; config: NativeCommandConfig }>;
export type NativeCommandResult = Readonly<{
  schemaVersion: 1;
  state: 'succeeded' | 'queued' | 'running' | 'unknown' | 'failed' | 'cancelled';
  runId: string;
  taskId: string;
  commandId: string;
  workerId: string;
  attemptId: string;
  sessionId?: string;
  configDigest: string;
  commandStatus: string;
  evidenceRefs: readonly string[];
  result?: unknown;
}>;

export type NativeCommandEnvironment = Readonly<{
  host: HostControlPlane;
  context: HelmToolExecutionContext;
  autonomyLease: AutonomyLease;
  ownership: Readonly<{
    runId: string; leaseId: string; owner: 'fable' | 'astra'; sessionId: string; epoch: number; issuedAt: string; expiresAt: string;
  }>;
  modelFact: ModelFact;
  /** Fresh host-owned precondition reads; config cannot manufacture facts. */
  readFact(precondition: Precondition): Promise<Observation<boolean>>;
  now?: () => string;
  /** The trusted composition seam: implementation must call PiWorkerFleet,
   * whose binding supplies createBoundedFleetRuntime and native Pi. */
  dispatch(plan: WorkerSpawnPlan, identity: WorkerSpawnIdentity, context: HelmToolExecutionContext): Promise<Readonly<{ workerId: string; attemptId: string; sessionId: string; state: 'ready' }>>;
  waitForTerminal?(workerId: string): Promise<void>;
  stop?(workerId: string, context: HelmToolExecutionContext): Promise<Readonly<{ state: string; evidenceRefs: readonly string[] }>>;
}>;

const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
const stableIds = (runId: string, taskId: string): WorkerSpawnIdentity => {
  const key = digest({ runId, taskId }).slice('sha256:'.length, 'sha256:'.length + 32);
  return { workerId: `worker-native-${key}`, attemptId: `attempt-worker-native-${key}` };
};
const commandIdentity = (runId: string, taskId: string): string => `native-worker-spawn-${digest({ runId, taskId }).slice('sha256:'.length, 'sha256:'.length + 32)}`;
const manifestPath = (config: NativeCommandConfig): string => join(config.stateDirectory, `native-command-${digest({ runId: config.runId, taskId: config.taskId }).slice('sha256:'.length, 'sha256:'.length + 32)}.manifest.json`);
async function bindManifest(config: NativeCommandConfig): Promise<string> {
  const configDigest = digest(config);
  const path = manifestPath(config);
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as Partial<Manifest>;
    if (existing.schemaVersion !== 1 || existing.digest !== configDigest || JSON.stringify(existing.config) !== JSON.stringify(config)) {
      throw new Error('native command configuration does not match its durable manifest');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not match')) throw error;
    const manifest: Manifest = { schemaVersion: 1, digest: configDigest, config };
    try { await writeFile(path, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (writeError: unknown) {
      if (!(writeError instanceof Error && 'code' in writeError && (writeError as { code?: unknown }).code === 'EEXIST')) throw new Error('native command manifest could not be persisted');
      try {
        const raced = JSON.parse(await readFile(path, 'utf8')) as Partial<Manifest>;
        if (raced.schemaVersion !== 1 || raced.digest !== configDigest || JSON.stringify(raced.config) !== JSON.stringify(config)) throw new Error('native command configuration does not match its durable manifest');
      } catch (readError) { if (readError instanceof Error && readError.message.includes('does not match')) throw readError; throw new Error('native command manifest could not be observed after concurrent creation'); }
    }
  }
  return configDigest;
}

async function existingResult(config: NativeCommandConfig, configDigest: string, command: { command: Command; status: string; observations: readonly { evidenceRefs: readonly string[] }[] }, host: HostControlPlane): Promise<NativeCommandResult> {
  const payload = command.command.payload as { workerId?: unknown; attemptId?: unknown };
  if (typeof payload.workerId !== 'string' || typeof payload.attemptId !== 'string') throw new Error('durable native command has malformed worker identity');
  const expectedIdentity = stableIds(config.runId, config.taskId);
  if (payload.workerId !== expectedIdentity.workerId || payload.attemptId !== expectedIdentity.attemptId) throw new Error('durable native command identity is not bound to its stable run and task');
  const refs = command.observations.flatMap((item) => item.evidenceRefs);
  const [known, unknown, stopped, stopUnknown] = await Promise.all([
    host.readFleetEffectRecordByIdentity(config.runId, `host-worker-terminal-known:${config.runId}:${payload.attemptId}`),
    host.readFleetEffectRecordByIdentity(config.runId, `host-worker-terminal-unknown:${config.runId}:${payload.attemptId}`),
    host.readFleetEffectRecordByIdentity(config.runId, `host-worker-stop-confirmed:${config.runId}:${payload.attemptId}`),
    host.readFleetEffectRecordByIdentity(config.runId, `host-worker-stop-unknown:${config.runId}:${payload.attemptId}`),
  ]);
  const terminalRecord = (entry: { text: string; evidenceRef: string } | undefined): { evidenceRefs: readonly string[]; sessionId?: string } | undefined => {
    if (!entry) return undefined;
    try {
      const parsed = JSON.parse(entry.text) as { evidenceRefs?: unknown; sessionId?: unknown };
      if (!Array.isArray(parsed.evidenceRefs) || !parsed.evidenceRefs.every((ref) => typeof ref === 'string' && ref.length > 0)) return undefined;
      return { evidenceRefs: parsed.evidenceRefs, ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}) };
    } catch { return undefined; }
  };
  const knownTerminal = terminalRecord(known);
  const unknownTerminal = terminalRecord(unknown);
  const stoppedTerminal = terminalRecord(stopped);
  const stopUnknownTerminal = terminalRecord(stopUnknown);
  const terminal = knownTerminal ?? unknownTerminal ?? stoppedTerminal ?? stopUnknownTerminal;
  const result = terminal ? await host.readFleetTerminalResult({ attemptId: payload.attemptId, commandId: command.command.commandId, evidenceRefs: terminal.evidenceRefs, ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}) }) : undefined;
  let state: NativeCommandResult['state'] = command.status === 'queued' ? 'queued' : command.status === 'failed' || command.status === 'refused' ? 'failed' : 'unknown';
  if (result) state = result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed';
  else if (stoppedTerminal) state = 'cancelled';
  else if (known || unknown) state = 'unknown';
  else if (command.status === 'succeeded') state = 'unknown';
  const terminalRefs = [ ...(known?.evidenceRef ? [known.evidenceRef] : []), ...(unknown?.evidenceRef ? [unknown.evidenceRef] : []), ...(stopped?.evidenceRef ? [stopped.evidenceRef] : []), ...(stopUnknown?.evidenceRef ? [stopUnknown.evidenceRef] : []) ];
  return Object.freeze({ schemaVersion: 1, state, runId: config.runId, taskId: config.taskId, commandId: command.command.commandId, workerId: payload.workerId, attemptId: payload.attemptId, configDigest, commandStatus: command.status, evidenceRefs: Object.freeze([...new Set([...refs, ...terminalRefs, ...(terminal?.evidenceRefs ?? [])])]), ...(result ? { result } : {}) });
}

/** Observe the immutable command and terminal selectors without constructing a
 * model runtime or checking credentials. This is the CLI restart path. */
export async function observeNativeCommand(rawConfig: unknown, host: HostControlPlane): Promise<NativeCommandResult | undefined> {
  const config = nativeCommandConfigSchema.parse(rawConfig);
  const configDigest = await bindManifest(config);
  const command = host.readFleetProjection(config.runId).commands.find((entry) => entry.command.commandId === commandIdentity(config.runId, config.taskId));
  if (!command) return undefined;
  const payload = command.command.payload as { label?: unknown };
  if (payload.label !== configDigest) throw new Error('durable native command identity is bound to a different configuration');
  return existingResult(config, configDigest, command, host);
}

/** Execute one bounded native worker command. Existing immutable commands are
 * observed before authority, credential, model, or provider checks. */
export async function runNativeCommand(rawConfig: unknown, environment: NativeCommandEnvironment, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<NativeCommandResult> {
  const config = nativeCommandConfigSchema.parse(rawConfig);
  const configDigest = await bindManifest(config);
  if (environment.context.runId !== config.runId || environment.context.mode !== 'primary') throw new Error('native command context does not match its run');
  const identity = stableIds(config.runId, config.taskId);
  const commandId = commandIdentity(config.runId, config.taskId);
  const before = environment.host.readFleetProjection(config.runId).commands.find((entry) => entry.command.commandId === commandId);
  if (before) {
    const payload = before.command.payload as { label?: unknown };
    if (payload.label !== configDigest) throw new Error('durable native command identity is bound to a different configuration');
    return existingResult(config, configDigest, before, environment.host);
  }

  // A cancellation observed before the immutable command exists is only a
  // local caller disposition.  It must not acquire leases, resolve a model,
  // or create a stop command for a worker that was never launched.
  if (options.signal?.aborted) return Object.freeze({ schemaVersion: 1, state: 'cancelled', runId: config.runId, taskId: config.taskId, commandId, workerId: identity.workerId, attemptId: identity.attemptId, configDigest, commandStatus: 'not-dispatched', evidenceRefs: [] });

  if (environment.ownership.runId !== config.runId || environment.ownership.leaseId !== config.ownershipLeaseId || environment.ownership.owner !== config.ownershipOwner || environment.ownership.epoch !== config.ownershipEpoch || environment.ownership.sessionId !== config.ownershipSessionId || environment.ownership.issuedAt !== config.ownershipIssuedAt || environment.ownership.expiresAt !== config.ownershipExpiresAt) throw new Error('native command ownership does not match durable configuration');
  if (environment.autonomyLease.leaseId !== config.autonomyLeaseId || environment.autonomyLease.revision !== config.autonomyLeaseRevision) throw new Error('native command autonomy lease does not match durable configuration');
  if (environment.modelFact.modelId !== config.modelId || environment.modelFact.provider !== config.modelProvider || environment.modelFact.factVersion !== config.modelFactVersion) throw new Error('native command model fact does not match durable configuration');
  if (environment.modelFact.poolId !== config.policy.poolId || config.policy.authEnvironment !== config.credentialEnvironment) throw new Error('native command resource or credential identity does not match durable configuration');
  if (config.policy.baseUrl !== config.modelBaseUrl) throw new Error('native command model and policy endpoints do not match');

  const input: WorkerSpawnInput = Object.freeze({ objectiveRef: config.objectiveRef, acceptanceRef: config.acceptanceRef, contextRefs: Object.freeze([...config.contextRefs]), modelId: config.modelId, role: 'builder', label: configDigest });
  const plan = planWorkerSpawn({ input, workerId: identity.workerId, attemptId: identity.attemptId, commandId, actorId: `native-command:${config.taskId}`, context: environment.context, autonomyLease: environment.autonomyLease, ownership: environment.ownership, plannedAt: config.plannedAt, notAfter: config.notAfter, repositoryId: config.repositoryId, mapNodeId: config.mapNodeId, mapNodeRevision: config.mapNodeRevision, objectiveVersion: config.objectiveVersion, acceptanceVersion: config.acceptanceVersion, model: { fact: environment.modelFact, api: config.modelApi, family: config.modelFamily }, requiredCapabilities: config.requiredCapabilities, dataClassification: config.dataClassification, workspace: { repository: config.repository, destination: config.destination, branch: config.branch, baseSha: config.baseSha, owner: { attemptId: identity.attemptId, generation: 1, expiresAt: config.notAfter }, policy: { writableRoots: config.writableRoots, ...(config.readableRoots ? { readableRoots: config.readableRoots } : {}), ...(config.protectedRoots ? { protectedRoots: config.protectedRoots } : {}) } } });

  let finished = false;
  let launch: Readonly<{ workerId: string; attemptId: string; sessionId: string; state: 'ready' }> | undefined;
  let abortPending = false;
  let abortObservation: Readonly<{ state: string; evidenceRefs: readonly string[] }> | undefined;
  const onAbort = async (): Promise<void> => {
    if (finished) return;
    if (!launch) { abortPending = true; return; }
    if (!environment.stop) { abortObservation = { state: 'unknown', evidenceRefs: [] }; return; }
    try { abortObservation = await environment.stop(launch.workerId, environment.context); }
    catch { abortObservation = { state: 'unknown', evidenceRefs: [] }; }
  };
  let abortPromise: Promise<void> | undefined;
  const abortListener = options.signal ? () => { abortPromise = onAbort(); void abortPromise.catch(() => undefined); } : undefined;
  options.signal?.addEventListener('abort', abortListener!, { once: true });
  try {
    launch = await environment.dispatch(plan, identity, environment.context);
    if (abortPending) await onAbort();
    if (environment.waitForTerminal) await environment.waitForTerminal(launch.workerId);
    // An abort callback may still be admitting/observing worker.stop while
    // terminal wait completes.  Join it before reading or closing host state.
    if (abortPromise) await abortPromise;
    const record = environment.host.readFleetProjection(config.runId).commands.find((entry) => entry.command.commandId === commandId);
    if (!record) throw new Error('native command dispatch was not durably recorded');
    if (record.command.payload && (record.command.payload as { label?: unknown }).label !== configDigest) throw new Error('native command dispatch changed its immutable configuration');
    const observed = await existingResult(config, configDigest, record, environment.host);
    // The terminal selector read above is asynchronous.  Join an abort that
    // arrived during that read before detaching the listener, so a stop
    // admission cannot race a caller closing the host after this resolves.
    if (abortPromise) await abortPromise;
    const cancellationRefs = abortObservation?.evidenceRefs ?? [];
    const cancellationState: NativeCommandResult['state'] = abortObservation?.state === 'stopped' && cancellationRefs.length > 0 ? 'cancelled' : abortObservation ? 'unknown' : observed.state;
    const output = Object.freeze({ ...observed, state: observed.result ? observed.state : cancellationState, workerId: launch.workerId, attemptId: launch.attemptId, ...(observed.sessionId ? {} : { sessionId: launch.sessionId }), evidenceRefs: Object.freeze([...new Set([...observed.evidenceRefs, ...cancellationRefs])]) });
    // No await follows this point.  Marking finished and removing the
    // listener synchronously closes the cancellation race for this command.
    finished = true;
    if (options.signal && abortListener) options.signal.removeEventListener('abort', abortListener);
    return output;
  } finally {
    finished = true;
    if (options.signal && abortListener) options.signal.removeEventListener('abort', abortListener);
    if (abortPromise) await abortPromise;
  }
}

export { digest as nativeCommandDigest, stableIds as nativeCommandIdentity };

const piEffectPayloadSchema = z.object({ effectId: z.string().min(1), kind: z.enum(['model.request', 'workspace.write']), attemptId: z.string().min(1) }).strict();
const workerStopPayloadSchema = z.object({ workerId: z.string().min(1) }).strict();
/** Kernel registrations required by an opened native command host. */
export function nativeCommandKinds(config: NativeCommandConfig): Readonly<Record<string, KernelKind>> {
  const upperBound = (config.policy.contextWindow * (config.policy.inputUsdPerMillion + config.policy.cacheReadUsdPerMillion + config.policy.cacheWriteUsdPerMillion) + config.policy.maxBilledOutputTokens * config.policy.outputUsdPerMillion) / 1_000_000;
  return Object.freeze({
    'worker.spawn': workerSpawnKind,
    'worker.stop': { payloadSchema: workerStopPayloadSchema },
    'pi.model': { payloadSchema: piEffectPayloadSchema, resourceRequest: () => ({ poolId: config.policy.poolId, unit: 'usd', upperBound, consumer: 'worker' as const }) },
    'pi.write': { payloadSchema: piEffectPayloadSchema },
  });
}
const piEffectCommand = (config: NativeCommandConfig, effect: { effectId: string; kind: 'model.request' | 'workspace.write' }, attemptId: string, executorId: string): Command => ({
  schemaVersion: 1, commandId: effect.effectId, kind: effect.kind === 'model.request' ? 'pi.model' : 'pi.write', idempotencyKey: effect.effectId,
  payloadHash: digest({ effectId: effect.effectId, kind: effect.kind, attemptId }), scope: { repositoryId: config.repositoryId, mapNodeId: config.mapNodeId }, actorId: executorId,
  runId: config.runId, origin: 'worker', leaseId: config.autonomyLeaseId, leaseRevision: config.autonomyLeaseRevision, plannedAt: config.plannedAt, notAfter: config.notAfter,
  expected: [], payload: { effectId: effect.effectId, kind: effect.kind, attemptId }, requiredEvidence: [],
});
const workerStopCommand = (config: NativeCommandConfig, workerId: string, context: HelmToolExecutionContext): Command => {
  const payload = { workerId };
  return {
    schemaVersion: 1,
    commandId: `native-worker-stop-${workerId}`,
    kind: 'worker.stop',
    idempotencyKey: `native-worker-stop-${workerId}`,
    payloadHash: digest(payload),
    scope: { repositoryId: config.repositoryId, mapNodeId: config.mapNodeId },
    actorId: `native-command:${config.taskId}`,
    runId: context.runId,
    origin: 'orchestrator',
    leaseId: config.autonomyLeaseId,
    leaseRevision: config.autonomyLeaseRevision,
    orchestratorLeaseId: config.ownershipLeaseId,
    orchestratorEpoch: config.ownershipEpoch,
    plannedAt: config.plannedAt,
    notAfter: config.notAfter,
    expected: [],
    payload,
    requiredEvidence: [],
  };
};

/** Native host composition used by the shipped CLI and provider-free fixture.
 * It is deliberately a constructor, not a workflow: all policy, model,
 * ownership, workspace and command facts come from the supplied config/host. */
export function createNativeCommandEnvironment(config: NativeCommandConfig, options: Readonly<{
  host: HostControlPlane;
  workspaceManager: WorkspaceManager;
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  modelFact: ModelFact;
  autonomyLease: AutonomyLease;
  ownership: NativeCommandEnvironment['ownership'];
  context: HelmToolExecutionContext;
  executorId: string;
  readFact(precondition: Precondition): Promise<Observation<boolean>>;
  thinking?: { level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  now?: () => string;
}>): NativeCommandEnvironment & Readonly<{ fleet: PiWorkerFleet }> {
  nativeCommandConfigSchema.parse(config);
  const policy: BoundedPiAccessPolicy = { ...config.policy, provider: config.modelProvider, model: config.modelId, api: config.modelApi as BoundedPiAccessPolicy['api'], baseUrl: config.modelBaseUrl, ...(config.openRouterRouting ? { openRouterRouting: config.openRouterRouting } : {}) };
  new BoundedPiAccess(policy); // Validate all policy bounds before command admission or workspace effects.
  if (options.model.id !== config.modelId || options.model.provider !== config.modelProvider || options.model.api !== config.modelApi || options.model.baseUrl !== config.modelBaseUrl || options.model.contextWindow !== config.policy.contextWindow || options.model.maxTokens < config.policy.maxBilledOutputTokens) throw new Error('native model differs from pinned configuration');
  if (config.openRouterRouting) {
    const compat = (options.model as Model<Api> & { compat?: { openRouterRouting?: unknown } }).compat;
    const actual = compat?.openRouterRouting;
    if (JSON.stringify(actual) !== JSON.stringify(config.openRouterRouting)) throw new Error('native model OpenRouter routing differs from pinned configuration');
  }
  const planFor = (input: WorkerSpawnInput, workerId: string, attemptId: string, context: HelmToolExecutionContext): WorkerSpawnPlan => planWorkerSpawn({
    input, workerId, attemptId, commandId: `native-worker-spawn-${digest({ runId: config.runId, taskId: config.taskId }).slice('sha256:'.length, 'sha256:'.length + 32)}`, actorId: `native-command:${config.taskId}`, context,
    autonomyLease: options.autonomyLease, ownership: options.ownership, plannedAt: config.plannedAt, notAfter: config.notAfter, repositoryId: config.repositoryId, mapNodeId: config.mapNodeId, mapNodeRevision: config.mapNodeRevision, objectiveVersion: config.objectiveVersion, acceptanceVersion: config.acceptanceVersion,
    model: { fact: options.modelFact, api: config.modelApi, family: config.modelFamily }, requiredCapabilities: config.requiredCapabilities, dataClassification: config.dataClassification,
    workspace: { repository: config.repository, destination: config.destination, branch: config.branch, baseSha: config.baseSha, owner: { attemptId, generation: 1, expiresAt: config.notAfter }, policy: { writableRoots: config.writableRoots, ...(config.readableRoots ? { readableRoots: config.readableRoots } : {}), ...(config.protectedRoots ? { protectedRoots: config.protectedRoots } : {}) } },
  });
  const lifecycle = createBoundedFleetRuntime({
    workerFor: (command, workspace) => { const payload = command.payload as { attemptId: string }; return { attemptId: payload.attemptId, owner: workspace.owner, workspaceManager: options.workspaceManager, stateRoot: join(config.stateDirectory, 'pi'), modelRuntime: options.modelRuntime, model: options.model, thinking: options.thinking ?? { level: 'medium' } }; },
    policyFor: () => policy,
    authorityFor: (command, access) => { const payload = command.payload as { attemptId?: unknown }; if (typeof payload.attemptId !== 'string') throw new Error('native effect command lacks attempt identity'); const attemptId = payload.attemptId; return options.host.piAuthority({ attemptId, actorId: 'native-pi', executorId: options.executorId, commandForEffect: (effect) => piEffectCommand(config, effect, attemptId, options.executorId), observedSettlement: (effect) => settlementForBoundedPiEffect(access, effect) }); },
    journalFor: () => options.host.artifactsFor(options.context).journalForTrustedPi(),
  });
  let fleet!: PiWorkerFleet;
  const binding = {
    host: options.host, workspaceManager: options.workspaceManager, executor: { executorId: options.executorId }, claimExpiresAt: () => config.notAfter, readFact: options.readFact,
    spawnCommand: (input: WorkerSpawnInput, workerId: string, attemptId: string, context: HelmToolExecutionContext) => planFor(input, workerId, attemptId, context).command,
    inputDigest: (command: Command) => (command.payload as { inputDigest: string }).inputDigest,
    attempt: (command: Command, workerId: string): Attempt => ({ attemptId: (command.payload as { attemptId: string }).attemptId, mapNodeId: config.mapNodeId, mapNodeRevision: config.mapNodeRevision, objectiveVersion: config.objectiveVersion, acceptanceVersion: config.acceptanceVersion, role: 'builder', model: config.modelId, family: config.modelFamily, provider: config.modelProvider, capability: config.requiredCapabilities.join(','), poolId: config.policy.poolId, workspace: config.destination, baseSha: config.baseSha, contextManifestHash: (command.payload as { inputDigest: string }).inputDigest, leaseId: config.autonomyLeaseId, sessionIds: [], commandIds: [command.commandId], startedAt: config.plannedAt, evidenceRefs: [], usageRefs: [], findingRefs: [] }),
    workspace: (_command: Command, _workerId: string, attempt: Attempt) => ({ repository: config.repository, destination: config.destination, branch: config.branch, baseSha: config.baseSha, owner: { attemptId: attempt.attemptId, generation: 1, expiresAt: config.notAfter }, policy: { writableRoots: config.writableRoots, ...(config.readableRoots ? { readableRoots: config.readableRoots } : {}), ...(config.protectedRoots ? { protectedRoots: config.protectedRoots } : {}) } }),
    start: lifecycle.start, rehydrate: lifecycle.rehydrate,
    stopCommand: (record: { workerId: string }, context: HelmToolExecutionContext) => workerStopCommand(config, record.workerId, context),
    prompt: async (command: Command) => { const artifacts = options.host.artifactsFor(options.context); const payload = command.payload as { objectiveRef: string; acceptanceRef: string; contextRefs: readonly string[] }; return [await artifacts.readText(payload.objectiveRef), await artifacts.readText(payload.acceptanceRef), ...await Promise.all(payload.contextRefs.map((ref) => artifacts.readText(ref)))].join('\n\n'); },
    correction: () => 'Return only a valid WorkerResult JSON object.',
  };
  fleet = new PiWorkerFleet(binding);
  return { host: options.host, context: options.context, autonomyLease: options.autonomyLease, ownership: options.ownership, modelFact: options.modelFact, readFact: options.readFact, now: options.now, fleet, dispatch: (plan, identity, context) => { const payload = plan.command.payload as { objectiveRef: string; acceptanceRef: string; contextRefs: readonly string[]; modelId: string; role: string; label?: string }; return fleet.spawn(context, { objectiveRef: payload.objectiveRef, acceptanceRef: payload.acceptanceRef, contextRefs: payload.contextRefs, modelId: payload.modelId, role: payload.role, ...(payload.label ? { label: payload.label } : {}) }, identity); }, waitForTerminal: (workerId) => fleet.waitForTerminal(workerId), stop: (workerId, context) => fleet.stop(context, workerId) };
}
