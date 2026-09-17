import { readFile } from 'node:fs/promises';
import { nativeCommandConfigSchema, runNativeCommand, type NativeCommandConfig, type NativeCommandEnvironment } from '../host/native-command.js';
import { createNativeCommandEnvironment, nativeCommandKinds } from '../host/native-command.js';
import { openHost } from '../host/index.js';
import { WorkspaceManager } from '../workspace/index.js';
import type { ModelFact } from '../core/index.js';

/** Public command adapter. Host construction is injected by the trusted host;
 * this module only parses config, invokes the command service and serializes a
 * bounded machine-readable result. */
export async function nativeCli(args: readonly string[], environment?: NativeCommandEnvironment): Promise<string> {
  if (args.length < 2 || args.length > 3 || args[0] !== '--config' || (args.length === 3 && args[2] !== '--json')) {
    throw new Error('Usage: tsx src/cli/native.ts --config /absolute/path/config.json [--json]');
  }
  const configPath = args[1]!;
  if (!configPath.startsWith('/')) throw new Error('native command config path must be absolute');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { throw new Error('native command config could not be read'); }
  const config: NativeCommandConfig = nativeCommandConfigSchema.parse(raw);
  let owned: { host: { close(): void }; workspace: { close(): void }; runtime: { dispose?(): void } } | undefined;
  if (!environment) {
    const host = await openHost({ stateDirectory: config.stateDirectory, kinds: nativeCommandKinds(config) });
    const snapshot = await host.snapshot(config.runId);
    const lease = snapshot.autonomyLeases.find((entry) => entry.lease.leaseId === config.autonomyLeaseId && entry.lease.revision === config.autonomyLeaseRevision)?.lease;
    if (!lease) { host.close(); throw new Error('native command autonomy lease is absent'); }
    const workspace = new WorkspaceManager({ stateRoot: `${config.stateDirectory}/workspace` });
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const ai = await import('@earendil-works/pi-ai');
    const runtime = await ModelRuntime.create({ authPath: `${config.stateDirectory}/native-auth.json`, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
    const model = runtime.getModel(config.modelProvider, config.modelId);
    if (!model) { workspace.close(); host.close(); throw new Error('configured native command model is unavailable'); }
    const modelFact: ModelFact = { modelId: config.modelId, provider: config.modelProvider, poolId: config.policy.poolId, enabled: true, capabilities: [...config.requiredCapabilities], roles: ['builder'], dataPolicy: config.dataClassification === 'public' ? 'public-only' : 'restricted-ok', availability: 'known_available', factVersion: config.modelFactVersion, observedAt: config.plannedAt };
    const ownership = { runId: config.runId, leaseId: config.ownershipLeaseId, owner: config.ownershipOwner, sessionId: config.ownershipSessionId, epoch: config.ownershipEpoch, issuedAt: config.ownershipIssuedAt, expiresAt: config.ownershipExpiresAt } as const;
    const built = createNativeCommandEnvironment(config, { host, workspaceManager: workspace, modelRuntime: runtime, model, modelFact, autonomyLease: lease, ownership, context: { runId: config.runId, sessionId: config.ownershipSessionId, mode: 'primary' }, executorId: 'native-cli' });
    const dispatch = built.dispatch;
    environment = { ...built, dispatch: async (plan, identity, context) => { const key = process.env[config.credentialEnvironment]; if (!key) throw new Error('configured native command credential is unavailable'); await runtime.setRuntimeApiKey(config.modelProvider, key); return dispatch(plan, identity, context); } };
    owned = { host, workspace, runtime: runtime as unknown as { dispose?(): void } };
  }
  try { return `${JSON.stringify(await runNativeCommand(config, environment))}\n`; }
  finally { owned?.workspace.close(); owned?.host.close(); owned?.runtime.dispose?.(); }
}

if (process.argv[1]?.endsWith('/native.ts')) {
  void nativeCli(process.argv.slice(2)).then((output) => process.stdout.write(output)).catch(() => {
    process.stderr.write('native command refused\n'); process.exitCode = 1;
  });
}
