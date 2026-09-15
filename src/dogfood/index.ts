import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod/v3';
import type { Command } from '../contracts/index.js';
import { openHost, PiNativeRuntime, type HostControlPlane } from '../host/index.js';
import { AstraDriver, AstraLoopbackMcpTransport, createAstraSdk, FableDriver, HelmToolRegistry, type HelmToolExecutionContext, type OrchestratorSessionGuard } from '../runtime/orchestrator/index.js';
import { PiNativeWorker, type PiAuthority } from '../runtime/pi/index.js';
import { WorkspaceManager, type WorktreeReservation } from '../workspace/index.js';

const exec = promisify(execFile);
const now = '2026-09-15T00:00:00.000Z';
const later = '2099-01-01T00:00:00.000Z';
const ownerLater = '2099-01-02T00:00:00.000Z';
const runId = 'fixture-run';
const attemptId = 'fixture-attempt';
const commandId = 'fixture-worker-spawn';
const hash = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const workerPayload = z.object({ path: z.literal('result.txt'), contents: z.literal('provider-free Pi fixture\n') }).strict();
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
  usageActions: Readonly<{ modelRequests: number; workspaceWrites: number }>;
  expiredRefusal: true;
  host: HostControlPlane;
  close(): Promise<void>;
}>;

export type LocalFixtureOptions = Readonly<{ stateDirectory: string; orchestrator: 'fable' | 'astra' }>;

function workerCommand(sessionId: string, context: HelmToolExecutionContext): Command {
  const payload = { path: 'result.txt', contents: 'provider-free Pi fixture\n' };
  return { schemaVersion: 1, commandId, kind: 'worker.spawn', idempotencyKey: commandId, payloadHash: hash(payload), scope: { repositoryId: 'fixture-repository', mapNodeId: 'fixture-node' }, actorId: 'fixture-model', runId: context.runId, origin: 'orchestrator', leaseId: 'fixture-autonomy', leaseRevision: 1, orchestratorLeaseId: 'fixture-orchestrator', orchestratorEpoch: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] };
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
  const workspace = await workspaceManager.create(repository, join(root, 'worker'), 'fixture-worker', baseSha, owner, { writableRoots: ['.'], protectedRoots: ['README.md'] });
  let clock = now;
  let plane: HostControlPlane | undefined;
  let modelRuntime: { dispose?: () => void } | undefined;
  let bridge: AstraLoopbackMcpTransport | undefined; let astraExecutable: string | undefined;
  let activePiAuthority: ReturnType<HostControlPlane['piAuthority']> | undefined;
  const afterWriteMarker = process.env.HELM_DOGFOOD_AFTER_WRITE_MARKER;
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const runtime = await ModelRuntime.create({ authPath: join(root, 'no-account-auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  modelRuntime = runtime as unknown as { dispose?: () => void };
  const faux = ai.fauxProvider({ provider: 'helm3-local-faux', models: [{ id: 'offline' }] }); runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('helm3-local-faux', 'offline');
  const nativeRuntime = new PiNativeRuntime({
    authority: (): PiAuthority => {
      activePiAuthority ??= plane!.piAuthority({ attemptId, actorId: 'fixture-pi', executorId: 'fixture-pi', commandForEffect: (effect) => piCommand(effect), observedSettlement: (effect) => effect.kind === 'model.request' ? { state: 'known', amount: 1 } : undefined });
      if (!afterWriteMarker) return activePiAuthority;
      return { ...activePiAuthority, perform: async (effect, action) => activePiAuthority!.perform(effect, async () => { await action(); if (effect.kind === 'workspace.write') { await writeFile(afterWriteMarker, 'workspace write completed before observation\n'); await new Promise<void>(() => undefined); } }) };
    },
    start: async ({ command, journal, authority }) => PiNativeWorker.start({ commandId: command.commandId, attemptId, workspace, owner, workspaceManager, authority, journal, stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model: faux.getModel() }),
    prompt: () => 'Write result.txt using helm_write, then return a WorkerResult JSON envelope.', correction: () => 'Return only a valid WorkerResult JSON envelope.',
  });
  const kinds = { 'worker.spawn': { payloadSchema: workerPayload }, 'pi.model': { payloadSchema: piPayload, resourceRequest: () => ({ poolId: 'fixture-requests', unit: 'requests', upperBound: 1, consumer: 'worker' as const }) }, 'pi.write': { payloadSchema: piPayload } };
  plane = await openHost({ stateDirectory: join(root, 'host'), now: () => clock, runtime: nativeRuntime, kinds });
  plane.recordHumanAuthority({ authorityId: 'fixture-human', repositoryId: 'fixture-repository', mapNodeIds: ['fixture-node'], allowedActions: ['worker.spawn', 'pi.model', 'pi.write'], expiresAt: ownerLater, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [{ poolId: 'fixture-requests', unit: 'requests', limit: 3 }], protectedReserves: [] });
  plane.recordAutonomyLease({ leaseId: 'fixture-autonomy', revision: 1, issuedBy: 'fixture-human', parentAuthorityId: 'fixture-human', scope: { repositoryId: 'fixture-repository', mapNodeIds: ['fixture-node'] }, allowedActions: ['worker.spawn', 'pi.model', 'pi.write'], issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [{ poolId: 'fixture-requests', unit: 'requests', limit: 3 }], protectedReserves: [] });
  plane.recordAttempt({ attemptId, mapNodeId: 'fixture-node', mapNodeRevision: 'fixture', objectiveVersion: 'fixture', acceptanceVersion: 'fixture', role: 'builder', model: 'offline', family: 'faux', provider: 'helm3-local-faux', capability: 'fixture', poolId: 'fixture-requests', workspace: workspace.root, baseSha, contextManifestHash: 'sha256:fixture-context', leaseId: 'fixture-autonomy', sessionIds: [], commandIds: [commandId], startedAt: now, evidenceRefs: [], usageRefs: [], findingRefs: [] });

  const hostGuard = plane.createSessionGuard({ runId, owner: options.orchestrator, leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater });
  const tools = new HelmToolRegistry([{
    name: 'worker.spawn', description: 'Start the one local Pi fixture worker.', input: {},
    async execute(_input, context) {
      if (context.mode !== 'primary') return { state: 'refused', reason: 'fixture requires primary ownership' };
      const admitted = plane!.admitOrchestrator(workerCommand(context.sessionId, context), context, `fixture-${options.orchestrator}`);
      const observed = await plane!.perform(admitted.command.commandId, { executorId: 'fixture-host' }, later, async () => ({ value: true, state: 'known', source: 'fixture', observedAt: now }));
      if (observed.state === 'succeeded') await activePiAuthority?.reportWorkerStop(admitted.command.commandId, 'stopped');
      if (observed.state !== 'succeeded') return { state: observed.state === 'unknown' ? 'unknown' : 'refused', reason: observed.detail ?? 'fixture worker did not succeed' };
      return { state: 'succeeded', value: { commandId: admitted.command.commandId } };
    },
  }]);
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall('helm_write', { path: 'result.txt', contents: 'provider-free Pi fixture\n' })),
    ai.fauxAssistantMessage('not a WorkerResult'),
    ai.fauxAssistantMessage(JSON.stringify({ status: 'succeeded', summary: 'fixture wrote result.txt', changed_files: ['result.txt'], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' })),
  ]);

  let driver: FableDriver | AstraDriver;
  if (options.orchestrator === 'fable') {
    const claude = await import('@anthropic-ai/claude-agent-sdk'); let definitions: Array<{ handler(args: Record<string, unknown>, extra: unknown): Promise<unknown> }> = [];
    const sdk = { ...claude, createSdkMcpServer(input: Parameters<typeof claude.createSdkMcpServer>[0]) { definitions = input.tools as typeof definitions; return claude.createSdkMcpServer(input); }, query: (() => (async function* () { const result = await definitions[0]!.handler({}, {}); yield { type: 'system', subtype: 'init', session_id: 'fixture-fable' }; yield { type: 'result', subtype: 'success', session_id: 'fixture-fable', result }; })()) as unknown as typeof claude.query };
    driver = new FableDriver(plane.artifactsForStart({ runId, owner: 'fable', leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater }), tools, hostGuard, plane.recoveryStateForStart({ runId, owner: 'fable', leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater }), { env: { PATH: process.env.PATH ?? '' } }, sdk);
  } else {
    let astraSession: { runId: string; sessionId: string; mode: 'primary' | 'consultant' } | undefined;
    const guard: OrchestratorSessionGuard = { authorizeStart: async (input) => { await hostGuard.authorizeStart?.(input); astraSession = { runId: input.runId, sessionId: input.sessionId, mode: input.mode }; bridge = await AstraLoopbackMcpTransport.open({ registry: tools, guard: hostGuard, session: astraSession }); }, assertCurrent: (input) => hostGuard.assertCurrent(input) };
    const executable = join(root, 'fixture-codex.mjs'); astraExecutable = executable; const mcpClient = pathToFileURL(join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href; const mcpTransport = pathToFileURL(join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js')).href; await writeFile(executable, `#!/usr/bin/env node
import { Client } from ${JSON.stringify(mcpClient)};
import { StreamableHTTPClientTransport } from ${JSON.stringify(mcpTransport)};
const args = process.argv.join(' '); const resumed = args.includes('resume'); const url = args.match(/http:\\/\\/127\\.0\\.0\\.1:[0-9]+\\/mcp/)?.[0]; const key = Object.keys(process.env).find((name) => name.startsWith('HELM_ASTRA_MCP_TOKEN_')); if (!url || !key) throw new Error('fixture MCP config was absent'); const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'Bearer ' + process.env[key] } } }); const client = new Client({ name: 'fixture-codex', version: '1' }); await client.connect(transport); const response = resumed ? undefined : await client.callTool({ name: 'worker.spawn', arguments: {} }); await transport.close(); if (response?.isError) throw new Error('fixture MCP worker.spawn was refused'); console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-astra' })); console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }));\n`, { mode: 0o700 }); await chmod(executable, 0o700);
    const sdk = { async create() { if (!bridge) throw new Error('fixture MCP bridge was not bound'); return (await createAstraSdk({ env: { PATH: process.env.PATH ?? '', ...bridge.env }, config: bridge.config as never, codexPathOverride: executable }).create()); } };
    driver = new AstraDriver(plane.artifactsForStart({ runId, owner: 'astra', leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater }), guard, plane.recoveryStateForStart({ runId, owner: 'astra', leaseId: 'fixture-orchestrator', expectedEpoch: 0, issuedAt: now, expiresAt: ownerLater }), sdk as never);
  }
  const started = await driver.start({ runId, contextRefs: [], mode: 'primary' });
  const artifacts = plane.artifactsFor({ runId, sessionId: started.sessionId, mode: 'primary' }); const objectiveRef = await artifacts.writeText('dogfood.objective', 'Run the local fixture worker.');
  await driver.invoke({ sessionId: started.sessionId, objectiveRef, contextRefs: [] });
  const checkpoint = await driver.checkpoint({ sessionId: started.sessionId });
  const bundle = await artifacts.loadRecoveryBundle(checkpoint.bundleRef);
  await driver.stop({ sessionId: started.sessionId }); await bridge?.close(); bridge = undefined;
  plane.close(); activePiAuthority = undefined;
  plane = await openHost({ stateDirectory: join(root, 'host'), now: () => clock, runtime: nativeRuntime, kinds });
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
  await workspaceManager.write(workspace, owner, 'README.md', 'forbidden').then(() => { throw new Error('protected path write was allowed'); }, () => undefined);
  const snapshot = await plane.snapshot(runId);
  const resultPath = join(workspace.root, 'result.txt');
  let duplicateRefused = false;
  try { plane.admitOrchestrator({ ...workerCommand(started.sessionId, { runId, sessionId: started.sessionId, mode: 'primary' }), actorId: 'different-model' }, { runId, sessionId: started.sessionId, mode: 'primary' }, 'fixture-duplicate'); } catch { duplicateRefused = true; }
  if (!duplicateRefused) throw new Error('duplicate command identity was not refused');
  clock = later;
  let expiredRefusal = false;
  try { plane.admitOrchestrator({ ...workerCommand(started.sessionId, { runId, sessionId: started.sessionId, mode: 'primary' }), commandId: 'fixture-expired-command', idempotencyKey: 'fixture-expired-command' }, { runId, sessionId: started.sessionId, mode: 'primary' }, `fixture-${options.orchestrator}`); } catch { expiredRefusal = true; }
  if (!expiredRefusal) throw new Error('expired autonomy lease admitted a new command');
  return Object.freeze({ fixture: true, orchestrator: options.orchestrator, stateDirectory: root, observedAt: clock, runId, attemptId, sessionId: started.sessionId, workspace: workspace.root, resultPath, recoveryBundleRef: checkpoint.bundleRef, recoveryStateRef: bundle.recoveryStateRef, rawRefs: Object.freeze(snapshot.artifacts.map((item) => item.ref)), commandState: snapshot.commands.find((entry) => entry.command.commandId === commandId)?.status ?? 'unknown', usageActions: Object.freeze({ modelRequests: snapshot.commands.filter((entry) => entry.command.kind === 'pi.model' && entry.status === 'succeeded').length, workspaceWrites: snapshot.commands.filter((entry) => entry.command.kind === 'pi.write' && entry.status === 'succeeded').length }), expiredRefusal: expiredRefusal as true, host: plane, async close() { await bridge?.close(); plane?.close(); workspaceManager.close(); modelRuntime?.dispose?.(); } });
}
