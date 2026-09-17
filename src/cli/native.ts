import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createNativeCommandEnvironment, inlineOpenRouterModel, nativeCommandConfigSchema, nativeCommandKinds,
  observeNativeCommand, runNativeCommand, type NativeCommandEnvironment,
} from '../host/native-command.js';
import { openHost } from '../host/index.js';
import { WorkspaceManager } from '../workspace/index.js';

/** The CLI selects durable host facts. It cannot issue or renew authority. */
export async function nativeCli(args: readonly string[], environment?: NativeCommandEnvironment, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<string> {
  if (args.length < 2 || args.length > 3 || args[0] !== '--config' || (args.length === 3 && args[2] !== '--json')) {
    throw new Error('Usage: tsx src/cli/native.ts --config /absolute/path/config.json [--json]');
  }
  const configPath = args[1]!;
  if (!configPath.startsWith('/')) throw new Error('native command config path must be absolute');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { throw new Error('native command config could not be read'); }
  const config = nativeCommandConfigSchema.parse(raw);
  if (environment) return `${JSON.stringify(await runNativeCommand(config, environment, options))}\n`;

  const host = await openHost({ stateDirectory: config.stateDirectory, kinds: nativeCommandKinds(config) });
  let workspace: WorkspaceManager | undefined;
  try {
    // Recovery observation must work after expiry, without a provider account
    // or even a currently installed/catalogued model.
    const previous = await observeNativeCommand(config, host);
    if (previous) return `${JSON.stringify(previous)}\n`;
    if (options.signal?.aborted) throw new Error('native command interrupted before launch');
    const snapshot = await host.snapshot(config.runId);
    const lease = host.readAutonomyLease(config.autonomyLeaseId, config.autonomyLeaseRevision);
    if (!lease) throw new Error('native command autonomy lease is absent');
    const modelFact = host.readModelFact(config.modelId);
    if (!modelFact) throw new Error('native command registered model is absent');
    const ownership = snapshot.ownership;
    if (!ownership) throw new Error('native command ownership is absent');
    workspace = new WorkspaceManager({ stateRoot: `${config.stateDirectory}/workspace` });
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const ai = await import('@earendil-works/pi-ai');
    const runtime = await ModelRuntime.create({ authPath: `${config.stateDirectory}/native-auth.json`, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
    if (config.openRouterRouting) {
      const { openrouterProvider } = await import('@earendil-works/pi-ai/providers/openrouter');
      const builtIn = openrouterProvider();
      const inline = inlineOpenRouterModel(config);
      runtime.registerNativeProvider({ ...builtIn, getModels: () => [...builtIn.getModels().filter(model => model.id !== inline.id), inline] });
    }
    const model = runtime.getModel(config.modelProvider, config.modelId);
    if (!model || model.api !== config.modelApi || model.baseUrl !== config.modelBaseUrl || model.id !== config.modelId || model.provider !== config.modelProvider) {
      throw new Error('native command model does not match its pinned endpoint and API');
    }
    const built = createNativeCommandEnvironment(config, { host, workspaceManager: workspace, modelRuntime: runtime, model, modelFact, autonomyLease: lease, ownership, context: { runId: config.runId, sessionId: config.ownershipSessionId, mode: 'primary' }, executorId: 'native-cli', readFact: async () => ({ state: 'unknown', value: null, source: 'native-cli', observedAt: new Date().toISOString(), reason: 'no external precondition reader is configured' }) });
    const dispatch = built.dispatch;
    const ready: NativeCommandEnvironment = { ...built, dispatch: async (plan, identity, context) => {
      const key = process.env[config.credentialEnvironment];
      if (!key) throw new Error('configured native command credential is unavailable');
      await runtime.setRuntimeApiKey(config.modelProvider, key);
      return dispatch(plan, identity, context);
    } };
    return `${JSON.stringify(await runNativeCommand(config, ready, options))}\n`;
  } finally {
    workspace?.close();
    host.close();
  }
}

if (process.argv[1] && /[/\\]cli[/\\]native\.(ts|js)$/.test(resolve(process.argv[1]))) {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  void nativeCli(process.argv.slice(2), undefined, { signal: controller.signal }).then((output) => {
    process.stdout.write(output);
    const state = (JSON.parse(output) as { state: string }).state;
    if (state !== 'succeeded') process.exitCode = state === 'failed' || state === 'cancelled' ? 1 : 2;
  }).catch(() => {
    // Never echo validation input, credentials, or raw provider bodies.
    process.stderr.write('native command refused\n');
    process.exitCode = 1;
  }).finally(() => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  });
}
