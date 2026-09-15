import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod/v3';
import type { Command } from '../contracts/index.js';
import { openHost, PiNativeRuntime, type HostControlPlane } from '../host/index.js';
import { createHostReadToolRegistry } from '../host/tools.js';
import { createHostWorkerToolRegistry } from '../host/worker-tools.js';
import { appendHostGateTool, gateRunPayloadSchema } from '../host/gate-tools.js';
import { PiWorkerFleet, type WorkerSpawnInput, type WorkerSteerInput } from '../host/worker-fleet.js';
import { AstraDriver, AstraLoopbackMcpTransport, createAstraSdk, FableDriver, HelmToolRegistry, type HelmTool, type HelmToolExecutionContext, type OrchestratorSessionGuard } from '../runtime/orchestrator/index.js';
import { PiNativeWorker, type PiAuthority, type PiEffect } from '../runtime/pi/index.js';
import { WorkspaceManager, type WorktreeReservation } from '../workspace/index.js';

const exec = promisify(execFile);
const now = '2026-09-15T00:00:00.000Z';
const later = '2099-01-01T00:00:00.000Z';
const ownerLater = '2099-01-02T00:00:00.000Z';
const runId = 'fixture-run';
const attemptId = 'fixture-attempt';
const commandId = 'fixture-worker-spawn';
const hash = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const workerPayload = z.object({ workerId: z.string().min(1), attemptId: z.string().min(1), modelId: z.literal('offline'), modelProvider: z.literal('helm3-local-faux'), modelApi: z.string().min(1), role: z.literal('builder'), inputDigest: z.string().min(1), baseSha: z.string().min(1), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict();
const piPayload = z.object({ effectId: z.string().min(1), kind: z.enum(['model.request', 'workspace.write']) }).strict();

export type LocalFixtureResult = Readonly<{
  fixture: true;
  orchestrator: 'fable' | 'astra';
  stateDirectory: string;
  observedAt: string;
  runId: string;
  attemptId: string;
  sessionId: string;
  workspace: string;
  resultPath: string;
  recoveryBundleRef: string;
  recoveryStateRef: string;
  rawRefs: readonly string[];
  commandState: string;
  gateHead: string;
  redGateHead: string;
  redGateEvidenceRefs: readonly string[];
  steerWorkerId: string;
  steerAttemptId: string;
  steerCommandId: string;
  workerAttemptId: string;
  workerSessionId: string;
  steerSessionId: string;
  secondModelSawPriorContext: boolean;
  gateCommandState: string;
  gateEvidenceRefs: readonly string[];
  usageActions: Readonly<{ modelRequests: number; workspaceWrites: number }>;
  expiredRefusal: true;
  toolNames: readonly string[];
  host: HostControlPlane;
  close(): Promise<void>;
}>;

export type LocalFixtureOptions = Readonly<{ stateDirectory: string; orchestrator: 'fable' | 'astra' }>;

async function waitForFile(path: string): Promise<void> {
  for (;;) {
    try { await access(path); return; }
    catch { await new Promise<void>((resolve) => setTimeout(resolve, 20)); }
  }
}

function localFixtureReadRegistry(host: HostControlPlane, context: HelmToolExecutionContext, observedAt: string): HelmToolRegistry {
  return createHostReadToolRegistry({
    context,
    authorize: async (actual) => { host.artifactsFor(actual); },
    host,
    brief: { async read() { return { text: 'Provider-free local fixture Brief.', source: 'fixture://brief', observedAt }; } },
    map: { async snapshot() { return { source: { repository: 'fixture/repository', parentIssue: 1 }, observedAt, completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }; } },
    economy: { snapshot: () => ({
      pools: [{ poolId: 'fixture-requests', kind: 'subscription' as const, unit: 'requests' }],
      models: [{ modelId: 'offline', provider: 'helm3-local-faux', family: 'faux', poolId: 'fixture-requests', enabled: true, availability: 'unknown' as const, roles: ['builder' as const], buildCapabilities: [], reviewCapabilities: [], dataPolicy: 'public-only' as const, observedAt }],
      quota: [{ poolId: 'fixture-requests', state: 'unknown' as const, observedAt, detail: 'fixture provider capacity is unobserved' }],
    }) },
  });
}

/** The fixture's driver and loopback cockpit use this same host-owned read surface. */
export function createLocalFixtureReadToolRegistry(result: LocalFixtureResult): HelmToolRegistry {
  return localFixtureReadRegistry(result.host, { runId: result.runId, sessionId: result.sessionId, mode: 'primary' }, result.observedAt);
}

function workerCommand(input: WorkerSpawnInput, workerId: string, attempt: string, context: HelmToolExecutionContext, baseSha: string, modelProvider: string, modelApi: string): Command {
  const payload = { workerId, attemptId: attempt, modelId: 'offline' as const, modelProvider, modelApi, role: 'builder' as const, inputDigest: hash({ ...input, contextRefs: [...input.contextRefs] }), baseSha, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const };
  const id = commandId;
  return { schemaVersion: 1, commandId: id, kind: 'worker.spawn', idempotencyKey: id, payloadHash: hash(payload), scope: { repositoryId: 'fixture-repository', mapNodeId: 'fixture-node' }, actorId: 'fixture-model', runId: context.runId, origin: 'orchestrator', leaseId: 'fixture-autonomy', leaseRevision: 1, orchestratorLeaseId: 'fixture-orchestrator', orchestratorEpoch: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] };
}
function piCommand(effect: { effectId: string; kind: 'model.request' | 'workspace.write' }): Command {
  const payload = { effectId: effect.effectId, kind: effect.kind };
  return { schemaVersion: 1, commandId: effect.effectId, kind: effect.kind === 'model.request' ? 'pi.model' : 'pi.write', idempotencyKey: effect.effectId, payloadHash: hash(payload), scope: { repositoryId: 'fixture-repository', mapNodeId: 'fixture-node' }, actorId: 'fixture-pi', runId, origin: 'worker', leaseId: 'fixture-autonomy', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] };
}

async function fixtureRepository(root: string): Promise<{ repository: string; baseSha: string }> {
  const repository = join(root, 'repository'); await mkdir(repository, { recursive: true });
  await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'fixture@example.invalid']); await exec('git', ['-C', repository, 'config', 'user.name', 'Helm fixture']);
  await writeFile(join(repository, 'README.md'), 'fixture base\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'fixture base']);
  return { repository, baseSha: (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim() };
}

/** Provider-free integration fixture. It never reads account credentials or calls a remote endpoint. */
export async function runLocalFixture(options: LocalFixtureOptions): Promise<LocalFixtureResult> {
  if (options.orchestrator !== 'fable' && options.orchestrator !== 'astra') throw new Error('fixture orchestrator must be fable or astra');
  const root = options.stateDirectory; await mkdir(root, { recursive: true, mode: 0o700 }); if ((await readdir(root)).length !== 0) throw new Error('fixture state directory must be newly created and empty');
  const { repository, baseSha } = await fixtureRepository(root);
  const workspaceManager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state'), now: () => Date.parse(now) });
  const owner = { attemptId, generation: 1, expiresAt: later };
  let workspace: WorktreeReservation | undefined;
  let clock = now;
  let plane: HostControlPlane | undefined;
  let modelRuntime: { dispose?: () => void } | undefined;
  let bridge: AstraLoopbackMcpTransport | undefined; let astraExecutable: string | undefined;
  let activePiAuthority: ReturnType<HostControlPlane['piAuthority']> | undefined;
  let activeAttemptId = attemptId;
  let secondModelSawPriorContext = false;
  let workerSessionId = '';
  let workerAttemptId = '';
  let steerSessionId = '';
  let gateHead = baseSha;
  let gateWorkerId = 'fixture-worker';
  const afterWriteMarker = process.env.HELM_DOGFOOD_AFTER_WRITE_MARKER;
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const runtime = await ModelRuntime.create({ authPath: join(root, 'no-account-auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  modelRuntime = runtime as unknown as { dispose?: () => void };
  const faux = ai.fauxProvider({ provider: 'helm3-local-faux', models: [{ id: 'offline' }] }); runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('helm3-local-faux', 'offline');
  const steerPayload = z.object({ workerId: z.string().min(1), attemptId: z.string().min(1), predecessorWorkerId: z.string().min(1), objectiveRef: z.string().min(1), evidenceRefs: z.array(z.string().min(1)).min(1), gateCommandId: z.string().min(1), expectedSessionId: z.string().min(1), expectedHead: z.string().regex(/^[0-9a-f]{40}$/), inputDigest: z.string().min(1), modelId: z.literal('offline'), modelProvider: z.literal('helm3-local-faux'), modelApi: z.string().min(1), modelFactVersion: z.literal(1), dataPolicy: z.literal('public-only') }).strict();
  const kinds = { 'worker.spawn': { payloadSchema: workerPayload, modelSelection: (value: unknown) => ({ modelId: workerPayload.parse(value).modelId, role: workerPayload.parse(value).role, requiredCapabilities: ['build'], dataClassification: 'public' as const }) }, 'worker.steer': { payloadSchema: steerPayload, modelSelection: () => ({ modelId: 'offline', role: 'builder', requiredCapabilities: ['build'], dataClassification: 'public' as const }) }, 'worker.stop': { payloadSchema: z.object({ workerId: z.string().min(1) }).strict() }, 'gate.run': { payloadSchema: gateRunPayloadSchema }, 'pi.model': { payloadSchema: piPayload, resourceRequest: () => ({ poolId: 'fixture-requests', unit: 'requests', upperBound: 1, consumer: 'worker' as const }) }, 'pi.write': { payloadSchema: piPayload } };
  plane = await openHost({ stateDirectory: join(root, 'host'), now: () => clock, kinds });
  plane.recordHumanAuthority({ authorityId: 'fixture-human', repositoryId: 'fixture-repository', mapNodeIds: ['fixture-node'], allowedActions: ['worker.spawn', 'worker.steer', 'gate.run', 'pi.model', 'pi.write'], expiresAt: ownerLater, maxConcurrency: 1, maxAttemptsPerNode: 2, poolLimits: [{ poolId: 'fixture-requests', unit: 'requests', limit: 4 }], protectedReserves: [] });
  plane.recordAutonomyLease({ leaseId: 'fixture-autonomy', revision: 1, issuedBy: 'fixture-human', parentAuthorityId: 'fixture-human', scope: { repositoryId: 'fixture-repository', mapNodeIds: ['fixture-node'] }, allowedActions: ['worker.spawn', 'worker.steer', 'gate.run', 'pi.model', 'pi.write'], issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 2, poolLimits: [{ poolId: 'fixture-requests', unit: 'requests', limit: 4 }], protectedReserves: [] });
  plane.recordModelFact({ modelId: 'offline', provider: 'helm3-local-faux', poolId: 'fixture-requests', enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: now });

  const hostGuard = plane.createSessionGuard({ runId, owner: options.orchestrator, leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater });
  let activeContext: HelmToolExecutionContext | undefined;
  let fixtureSpawnInput: WorkerSpawnInput | undefined;
  const fleet = new PiWorkerFleet({ host: plane, workspaceManager, executor: { executorId: 'fixture-host' }, claimExpiresAt: () => later, readFact: async () => ({ value: true, state: 'known', source: 'fixture', observedAt: now }),
    spawnCommand: (input: WorkerSpawnInput, workerId: string, spawnedAttemptId: string, context: HelmToolExecutionContext) => { activeContext = context; activeAttemptId = spawnedAttemptId; return workerCommand(input, workerId, spawnedAttemptId, context, baseSha, faux.getModel().provider, faux.getModel().api); },
    steerCommand: (input: WorkerSteerInput, successorWorkerId: string, record, nextAttemptId: string, context: HelmToolExecutionContext) => { activeContext = context; activeAttemptId = nextAttemptId; const frozenInput = { ...input, evidenceRefs: [...input.evidenceRefs] }; const payload = { workerId: successorWorkerId, attemptId: nextAttemptId, predecessorWorkerId: record.workerId, objectiveRef: input.objectiveRef, evidenceRefs: [...input.evidenceRefs], gateCommandId: input.gateCommandId, expectedSessionId: input.expectedSessionId, expectedHead: input.expectedHead, inputDigest: hash(frozenInput), modelId: 'offline' as const, modelProvider: record.modelProvider, modelApi: record.modelApi, modelFactVersion: 1 as const, dataPolicy: 'public-only' as const }; return { schemaVersion: 1, commandId: `fixture-worker-steer-${nextAttemptId}`, kind: 'worker.steer', idempotencyKey: `fixture-worker-steer-${nextAttemptId}`, payloadHash: hash(payload), scope: { repositoryId: 'fixture-repository', mapNodeId: 'fixture-node' }, actorId: 'fixture-model', runId: context.runId, origin: 'orchestrator', leaseId: 'fixture-autonomy', leaseRevision: 1, orchestratorLeaseId: 'fixture-orchestrator', orchestratorEpoch: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] } as Command; },
    inputDigest: (command) => (command.payload as { inputDigest: string }).inputDigest,
    stopCommand: (record, context) => { const payload = { workerId: record.workerId }; return { schemaVersion: 1, commandId: `fixture-worker-stop-${record.workerId}`, kind: 'worker.stop', idempotencyKey: `fixture-worker-stop-${record.workerId}`, payloadHash: hash(payload), scope: { repositoryId: 'fixture-repository', mapNodeId: 'fixture-node' }, actorId: 'fixture-model', runId: context.runId, origin: 'orchestrator', leaseId: 'fixture-autonomy', leaseRevision: 1, orchestratorLeaseId: 'fixture-orchestrator', orchestratorEpoch: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] } as Command; },
    attempt: (command, workerId) => ({ attemptId: activeAttemptId, mapNodeId: 'fixture-node', mapNodeRevision: 'fixture', objectiveVersion: 'fixture', acceptanceVersion: 'fixture', role: 'builder', model: 'offline', family: 'faux', provider: 'helm3-local-faux', capability: 'fixture', poolId: 'fixture-requests', workspace: join(root, 'worker'), baseSha: (command.payload as { expectedHead?: string }).expectedHead ?? baseSha, contextManifestHash: 'sha256:fixture-context', leaseId: 'fixture-autonomy', sessionIds: [], commandIds: [command.commandId], startedAt: now, evidenceRefs: [], usageRefs: [], findingRefs: [] }),
    workspace: (command, _workerId, attempt) => ({ repository, destination: command.kind === 'worker.steer' && workspace ? workspace.root : join(root, 'worker'), branch: 'fixture-worker', baseSha: (command.payload as { expectedHead?: string }).expectedHead ?? baseSha, owner: { attemptId: attempt.attemptId, generation: command.kind === 'worker.steer' ? 2 : 1, expiresAt: later }, policy: { writableRoots: ['.'], protectedRoots: ['README.md'] } }),
    start: async (command, reservation) => { workspace = reservation; const baseAuthority = plane!.piAuthority({ attemptId: activeAttemptId, actorId: 'fixture-pi', executorId: 'fixture-pi', commandForEffect: (effect) => piCommand(effect), observedSettlement: (effect) => effect.kind === 'model.request' ? { state: 'known', amount: 1 } : undefined }); const authority: PiAuthority = !afterWriteMarker ? baseAuthority : { ...baseAuthority, perform: async (effect: PiEffect, action: () => Promise<void>) => baseAuthority.perform(effect, async () => { await action(); if (effect.kind === 'workspace.write') { await writeFile(afterWriteMarker, 'workspace write completed before observation\n'); await new Promise<void>(() => undefined); } }) }; activePiAuthority = authority; return PiNativeWorker.start({ commandId: command.commandId, attemptId: activeAttemptId, workspace: reservation, owner: reservation.owner, workspaceManager, authority, journal: plane!.artifactsFor(activeContext!).journalForTrustedPi(), stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model: faux.getModel() }); },
    rehydrate: async (command, reservation, persisted) => { const transcript = await readFile(persisted.sessionFile, 'utf8'); secondModelSawPriorContext = transcript.includes('bad fixture result') && transcript.includes('fixture wrote invalid result.txt'); const authority = plane!.piAuthority({ attemptId: activeAttemptId, actorId: 'fixture-pi', executorId: 'fixture-pi', commandForEffect: (effect) => piCommand(effect), observedSettlement: (effect) => effect.kind === 'model.request' ? { state: 'known', amount: 1 } : undefined }); return PiNativeWorker.rehydrate({ commandId: command.commandId, attemptId: activeAttemptId, workspace: reservation, owner: reservation.owner, workspaceManager, authority, journal: plane!.artifactsFor(activeContext!).journalForTrustedPi(), stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model: faux.getModel() }, persisted); },
    prompt: (command) => command.kind === 'worker.steer'
      ? 'Repair result.txt using helm_write, then return a WorkerResult JSON envelope.'
      : 'Write result.txt using helm_write, then return a WorkerResult JSON envelope.', correction: () => 'Return only a valid WorkerResult JSON envelope.',
  });
  // Drivers provide the session context, never model JSON. Rebuild the small
  // host registry at invocation so its durable owner fence is checked again.
  const registryFor = (context: HelmToolExecutionContext) => appendHostGateTool(createHostWorkerToolRegistry({ context, authorize: async (actual) => { plane!.artifactsFor(actual); }, host: plane!, brief: { async read() { return { text: 'Provider-free local fixture Brief.', source: 'fixture://brief', observedAt: now }; } }, map: { async snapshot() { return { source: { repository: 'fixture/repository', parentIssue: 1 }, observedAt: now, completeness: 'complete' as const, nodes: [], frontier: [], incomplete: [] }; } }, economy: { snapshot: () => ({ pools: [{ poolId: 'fixture-requests', kind: 'subscription' as const, unit: 'requests' }], models: [], quota: [] }) } }, fleet), { context, authorize: async (actual) => { plane!.artifactsFor(actual); }, host: plane!, catalog: { async resolve() { return { gateId: 'fixture.gate', workerId: gateWorkerId, repositoryId: 'fixture-repository', mapNodeId: 'fixture-node', workspaceId: 'fixture-worker-worktree', workspace: join(root, 'worker'), expectedHead: gateHead, acceptanceVersion: 'fixture', checks: [{ name: 'fixture result content', executable: process.execPath, args: ['-e', 'const fs=require("node:fs"); if (fs.readFileSync("result.txt", "utf8") !== "provider-free Pi fixture\\n") process.exit(1)'], timeoutMs: 5000 }], environment: { PATH: process.env.PATH ?? '' } }; } }, command: { actorId: 'fixture-model', leaseId: 'fixture-autonomy', leaseRevision: 1, orchestratorLeaseId: 'fixture-orchestrator', orchestratorEpoch: 1, plannedAt: () => now, notAfter: () => later }, executor: { executorId: 'fixture-gate-host' }, claimExpiresAt: () => later });
  const templateContext = { runId, sessionId: 'fixture-read-template', mode: 'primary' as const };
  const templateRegistry = registryFor(templateContext);
  const tools = new HelmToolRegistry(templateRegistry.all().map((entry) => ({ ...entry, execute: (input: Record<string, unknown>, context: HelmToolExecutionContext) => registryFor(context).invoke(entry.name, input, context) })));
  const resultEnvelope = (summary: string) => JSON.stringify({ status: 'succeeded', summary, changed_files: ['result.txt'], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' });
  // The first valid worker result intentionally leaves bad content for the
  // gate. Rehydrating this same native session consumes the second pair.
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'result.txt', contents: 'bad fixture result\n' })),
    ai.fauxAssistantMessage(resultEnvelope('fixture wrote invalid result.txt')),
    ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'result.txt', contents: 'provider-free Pi fixture\n' })),
    ai.fauxAssistantMessage(resultEnvelope('fixture repaired result.txt')),
  ]);

  let driver: FableDriver | AstraDriver;
  let fixtureGateInput: Readonly<{ gateId: string; workerId: string; expectedHead: string }> | undefined;
  let fixtureSteerInput: WorkerSteerInput | undefined;
  const fixtureTurns = [
    () => ({ name: 'worker.spawn', input: fixtureSpawnInput }),
    () => ({ name: 'gate.run', input: fixtureGateInput }),
    () => ({ name: 'worker.steer', input: fixtureSteerInput }),
    () => ({ name: 'gate.run', input: fixtureGateInput }),
  ] as const;
  if (options.orchestrator === 'fable') {
    const claude = await import('@anthropic-ai/claude-agent-sdk'); let definitions: Array<{ name: string; handler(args: Record<string, unknown>, extra: unknown): Promise<unknown> }> = []; let invocation = 0;
    const sdk = { ...claude, createSdkMcpServer(input: Parameters<typeof claude.createSdkMcpServer>[0]) { definitions = input.tools as typeof definitions; return claude.createSdkMcpServer(input); }, query: (() => (async function* () { const turn = fixtureTurns[invocation++]; const action = turn?.(); const definition = action && definitions.find((entry) => entry.name === action.name); const result = definition && action?.input ? await definition.handler(action.input as Record<string, unknown>, {}) : undefined; yield { type: 'system', subtype: 'init', session_id: 'fixture-fable' }; yield { type: 'result', subtype: 'success', session_id: 'fixture-fable', result }; })()) as unknown as typeof claude.query };
    driver = new FableDriver(plane.artifactsForStart({ runId, owner: 'fable', leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater }), tools, hostGuard, plane.recoveryStateForStart({ runId, owner: 'fable', leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater }), { env: { PATH: process.env.PATH ?? '' } }, sdk);
  } else {
    let astraSession: { runId: string; sessionId: string; mode: 'primary' | 'consultant' } | undefined;
    const guard: OrchestratorSessionGuard = { authorizeStart: async (input) => { await hostGuard.authorizeStart?.(input); astraSession = { runId: input.runId, sessionId: input.sessionId, mode: input.mode }; bridge = await AstraLoopbackMcpTransport.open({ registry: tools, guard: hostGuard, session: astraSession }); }, assertCurrent: (input) => hostGuard.assertCurrent(input) };
    const executable = join(root, 'fixture-codex.mjs'); astraExecutable = executable; const mcpClient = pathToFileURL(join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href; const mcpTransport = pathToFileURL(join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')).href; await writeFile(executable, `#!/usr/bin/env node
import { Client } from ${JSON.stringify(mcpClient)};
import { readFileSync, writeFileSync } from 'node:fs';
import { StreamableHTTPClientTransport } from ${JSON.stringify(mcpTransport)};
const fixtureTurn = Number.parseInt((() => { try { return readFileSync(${JSON.stringify(join(root, 'fixture-driver-count'))}, 'utf8'); } catch { return '0'; } })(), 10); if (fixtureTurn < 4) process.argv = process.argv.map((value) => value.replaceAll('resume', 'continued'));
const args = process.argv.join(' '); const resumed = args.includes('resume'); const url = args.match(/http:\\/\\/127\\.0\\.0\\.1:[0-9]+\\/mcp/)?.[0]; const key = Object.keys(process.env).find((name) => name.startsWith('HELM_ASTRA_MCP_TOKEN_')); if (!url || !key) throw new Error('fixture MCP config was absent'); const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'Bearer ' + process.env[key] } } }); const client = new Client({ name: 'fixture-codex', version: '1' }); await client.connect(transport); const counterPath = ${JSON.stringify(join(root, 'fixture-driver-count'))}; const count = Number.parseInt((() => { try { return readFileSync(counterPath, 'utf8'); } catch { return '0'; } })(), 10); const turns = JSON.parse(readFileSync(${JSON.stringify(join(root, 'fixture-driver-turns.json'))}, 'utf8')); const turn = turns[count]; const response = resumed || !turn ? undefined : await client.callTool({ name: turn.name, arguments: JSON.parse(readFileSync(turn.inputPath, 'utf8')) }); if (!resumed && turn) writeFileSync(counterPath, String(count + 1)); await transport.close(); if (response?.isError) throw new Error('fixture MCP tool was refused'); console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-astra' })); console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }));\n`, { mode: 0o700 }); await chmod(executable, 0o700);
    const sdk = { async create() { if (!bridge) throw new Error('fixture MCP bridge was not bound'); return (await createAstraSdk({ env: { PATH: process.env.PATH ?? '', ...bridge.env }, config: bridge.config as never, codexPathOverride: executable }).create()); } };
    driver = new AstraDriver(plane.artifactsForStart({ runId, owner: 'astra', leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater }), guard, plane.recoveryStateForStart({ runId, owner: 'astra', leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater }), sdk as never);
  }
  const started = await driver.start({ runId, contextRefs: [], mode: 'primary' });
  const artifacts = plane.artifactsFor({ runId, sessionId: started.sessionId, mode: 'primary' }); const objectiveRef = await artifacts.writeText('dogfood.objective', 'Run the local fixture worker.'); const acceptanceRef = await artifacts.writeText('dogfood.acceptance', 'Write result.txt.');
  fixtureSpawnInput = Object.freeze({ objectiveRef, acceptanceRef, contextRefs: Object.freeze([]), modelId: 'offline', role: 'builder' });
  await writeFile(join(root, 'fixture-spawn-input.json'), JSON.stringify(fixtureSpawnInput), { mode: 0o600 });
  await writeFile(join(root, 'fixture-driver-turns.json'), JSON.stringify([
    { name: 'worker.spawn', inputPath: join(root, 'fixture-spawn-input.json') },
    { name: 'gate.run', inputPath: join(root, 'fixture-red-gate-input.json') },
    { name: 'worker.steer', inputPath: join(root, 'fixture-steer-input.json') },
    { name: 'gate.run', inputPath: join(root, 'fixture-green-gate-input.json') },
  ]), { mode: 0o600 });
  await driver.invoke({ sessionId: started.sessionId, objectiveRef, contextRefs: [] });
  const spawned = (await plane.snapshot(runId)).commands.find((entry) => entry.command.kind === 'worker.spawn');
  const spawnedId = (spawned?.command.payload as { workerId?: string } | undefined)?.workerId;
  if (!spawnedId) throw new Error('fixture worker setup did not persist a worker ID');
  if (afterWriteMarker) {
    // The interrupted-child test kills this process at the precise point after
    // a Pi-native write, before its observation and terminal handoff. Do not
    // close the host (which would hide the in-flight worker) or fabricate a
    // completed worker merely to make the child settle.
    await waitForFile(afterWriteMarker);
    await new Promise<void>(() => { setInterval(() => undefined, 1_000); });
  }
  await fleet.waitForTerminal(spawnedId);
  if (!workspace) throw new Error('worker setup did not create a worktree');
  await exec('git', ['-C', workspace.root, 'add', '--', 'result.txt']);
  await exec('git', ['-C', workspace.root, 'commit', '-m', 'fixture worker result']);
  gateHead = (await exec('git', ['-C', workspace.root, 'rev-parse', 'HEAD'])).stdout.trim();
  gateWorkerId = spawnedId;
  fixtureGateInput = Object.freeze({ gateId: 'fixture.gate', workerId: gateWorkerId, expectedHead: gateHead });
  await writeFile(join(root, 'fixture-red-gate-input.json'), JSON.stringify(fixtureGateInput), { mode: 0o600 });
  await driver.invoke({ sessionId: started.sessionId, objectiveRef, contextRefs: [] });
  const redSnapshot = await plane.snapshot(runId);
  const redGate = redSnapshot.commands.filter((entry) => entry.command.kind === 'gate.run').at(-1);
  const redGateEvidenceRefs = Object.freeze(redGate?.observations.flatMap((item) => item.evidenceRefs) ?? []);
  if (!redGate || redGateEvidenceRefs.length === 0) throw new Error('fixture red gate did not retain evidence for steering');
  const spawnedWorker = await fleet.inspect({ runId, sessionId: started.sessionId, mode: 'primary' }, spawnedId);
  workerSessionId = spawnedWorker.sessionId;
  workerAttemptId = spawnedWorker.attemptId;
  fixtureSteerInput = Object.freeze({ workerId: spawnedId, objectiveRef, evidenceRefs: redGateEvidenceRefs, gateCommandId: redGate.command.commandId, expectedSessionId: spawnedWorker.sessionId, expectedHead: gateHead });
  await writeFile(join(root, 'fixture-steer-input.json'), JSON.stringify(fixtureSteerInput), { mode: 0o600 });
  await driver.invoke({ sessionId: started.sessionId, objectiveRef, contextRefs: [] });
  const steered = (await plane.snapshot(runId)).commands.filter((entry) => entry.command.kind === 'worker.steer').at(-1);
  const steerWorkerId = (steered?.command.payload as { workerId?: string } | undefined)?.workerId;
  const steerAttemptId = (steered?.command.payload as { attemptId?: string } | undefined)?.attemptId;
  if (!steered || !steerWorkerId || !steerAttemptId) throw new Error('fixture worker steer did not persist its successor identity');
  await fleet.waitForTerminal(steerWorkerId);
  steerSessionId = (await fleet.inspect({ runId, sessionId: started.sessionId, mode: 'primary' }, steerWorkerId)).sessionId;
  const repairedContents = await readFile(join(workspace.root, 'result.txt'), 'utf8');
  if (repairedContents !== 'provider-free Pi fixture\n') throw new Error('fixture steer did not apply the corrected model write');
  await exec('git', ['-C', workspace.root, 'add', '--', 'result.txt']);
  await exec('git', ['-C', workspace.root, 'commit', '-m', 'fixture worker repair']);
  gateHead = (await exec('git', ['-C', workspace.root, 'rev-parse', 'HEAD'])).stdout.trim();
  gateWorkerId = steerWorkerId;
  fixtureGateInput = Object.freeze({ gateId: 'fixture.gate', workerId: gateWorkerId, expectedHead: gateHead });
  await writeFile(join(root, 'fixture-green-gate-input.json'), JSON.stringify(fixtureGateInput), { mode: 0o600 });
  await driver.invoke({ sessionId: started.sessionId, objectiveRef, contextRefs: [] });
  const checkpoint = await driver.checkpoint({ sessionId: started.sessionId });
  const bundle = await artifacts.loadRecoveryBundle(checkpoint.bundleRef);
  await driver.stop({ sessionId: started.sessionId }); await bridge?.close(); bridge = undefined;
  plane.close(); activePiAuthority = undefined;
  plane = await openHost({ stateDirectory: join(root, 'host'), now: () => clock, kinds });
  const resumedAuthority = { runId, owner: options.orchestrator, leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater } as const;
  const resumedGuard = plane.createSessionGuard(resumedAuthority);
  const resumedArtifacts = plane.artifactsFor({ runId, sessionId: started.sessionId, mode: 'primary' });
  if (options.orchestrator === 'fable') {
    const claude = await import('@anthropic-ai/claude-agent-sdk');
    const resumedSdk = { ...claude, query: (() => (async function* () { yield { type: 'result', subtype: 'success', session_id: 'fixture-fable' }; })()) as unknown as typeof claude.query };
    driver = new FableDriver(resumedArtifacts, tools, resumedGuard, plane.recoveryStateFor({ runId, sessionId: started.sessionId, mode: 'primary' }), { env: { PATH: process.env.PATH ?? '' } }, resumedSdk);
  } else {
    bridge = await AstraLoopbackMcpTransport.open({ registry: tools, guard: resumedGuard, session: { runId, sessionId: started.sessionId, mode: 'primary' } });
    const resumedSdk = { async create() { if (!bridge) throw new Error('fixture MCP bridge was not rebound after restart'); return createAstraSdk({ env: { PATH: process.env.PATH ?? '', ...bridge.env }, config: bridge.config as never, codexPathOverride: astraExecutable! }).create(); } };
    driver = new AstraDriver(resumedArtifacts, resumedGuard, plane.recoveryStateFor({ runId, sessionId: started.sessionId, mode: 'primary' }), resumedSdk as never);
  }
  await driver.resume({ sessionId: started.sessionId, recoveryBundleRef: checkpoint.bundleRef });
  await driver.invoke({ sessionId: started.sessionId, objectiveRef, contextRefs: [] });
  await workspaceManager.write(workspace, workspace.owner, 'README.md', 'forbidden').then(() => { throw new Error('protected path write was allowed'); }, () => undefined);
  const snapshot = await plane.snapshot(runId);
  const completedAttempt = snapshot.attemptLifecycles.find((entry) => entry.attemptId === activeAttemptId);
  if (completedAttempt?.state !== 'finished') throw new Error('provider-free native worker did not durably finish its Core attempt after model/write effects');
  const resultPath = join(workspace.root, 'result.txt');
  clock = later;
  let expiredRefusal = false;
  try { plane.admitOrchestrator({ ...workerCommand(fixtureSpawnInput, 'expired-worker', 'expired-attempt', { runId, sessionId: started.sessionId, mode: 'primary' }, baseSha, faux.getModel().provider, faux.getModel().api), commandId: 'fixture-expired-command', idempotencyKey: 'fixture-expired-command', notAfter: ownerLater }, { runId, sessionId: started.sessionId, mode: 'primary' }, `fixture-${options.orchestrator}`); } catch (error) { expiredRefusal = /autonomy|lease/i.test(String(error)); }
  if (!expiredRefusal) throw new Error('expired autonomy lease admitted a new command without a lease-expiry refusal');
  const gates = snapshot.commands.filter((entry) => entry.command.kind === 'gate.run'); const gate = gates.find((entry) => (entry.command.payload as { expectedHead?: string }).expectedHead === gateHead);
  return Object.freeze({ fixture: true, orchestrator: options.orchestrator, stateDirectory: root, observedAt: clock, runId, attemptId: activeAttemptId, sessionId: started.sessionId, workspace: workspace.root, resultPath, recoveryBundleRef: checkpoint.bundleRef, recoveryStateRef: bundle.recoveryStateRef, rawRefs: Object.freeze(snapshot.artifacts.map((item) => item.ref)), commandState: snapshot.commands.find((entry) => entry.command.kind === 'worker.spawn')?.status ?? 'unknown', gateHead, redGateHead: (redGate?.command.payload as { expectedHead?: string } | undefined)?.expectedHead ?? '', redGateEvidenceRefs, steerWorkerId, steerAttemptId, steerCommandId: steered.command.commandId, workerAttemptId, workerSessionId, steerSessionId, secondModelSawPriorContext, gateCommandState: gate?.status ?? 'unknown', gateEvidenceRefs: Object.freeze(gate?.observations.flatMap((item) => item.evidenceRefs) ?? []), usageActions: Object.freeze({ modelRequests: snapshot.commands.filter((entry) => entry.command.kind === 'pi.model' && entry.status === 'succeeded').length, workspaceWrites: snapshot.commands.filter((entry) => entry.command.kind === 'pi.write' && entry.status === 'succeeded').length }), expiredRefusal: expiredRefusal as true, toolNames: Object.freeze(tools.all().map((entry) => entry.name)), host: plane, async close() { await bridge?.close(); plane?.close(); workspaceManager.close(); modelRuntime?.dispose?.(); } });
}
