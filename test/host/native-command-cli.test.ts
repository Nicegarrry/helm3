import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { nativeCli } from '../../src/cli/native.js';
import { nativeCommandConfigSchema, nativeCommandKinds, openRouterRoutingSchema } from '../../src/host/native-command.js';
import { openHost } from '../../src/host/index.js';
import { createLiveNativeFixture, fixtureStamp, workerEnvelope } from './native-command-fixture.js';

const args = (path: string): string[] => ['--config', path, '--json'];
const exec = promisify(execFile);
const cliEntrypoint = resolve(process.cwd(), 'src/cli/native.ts');
const tsxLoader = createRequire(resolve(process.cwd(), 'test/host/native-command-cli.test.ts')).resolve('tsx');

test('OpenRouter routing requires an explicit no-fallback privacy and provider policy', () => {
  const route = { allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true, only: ['baseten'], quantizations: ['fp8'], max_price: { prompt: 0.2, completion: 0.5 } } as const;
  assert.deepEqual(openRouterRoutingSchema.parse(route), route);
  assert.throws(() => openRouterRoutingSchema.parse({ ...route, allow_fallbacks: true }));
  assert.throws(() => openRouterRoutingSchema.parse({ ...route, data_collection: 'allow' }));
  assert.throws(() => openRouterRoutingSchema.parse({ ...route, only: [] }));
});

async function runPublicCli(configPath: string, cwd: string) {
  const env = { ...process.env };
  delete env.FIXTURE_KEY;
  return exec(process.execPath, ['--import', tsxLoader, cliEntrypoint, ...args(configPath)], { cwd, env, timeout: 30_000 });
}

async function runFixtureExample() {
  const env = { ...process.env };
  delete env.FIXTURE_KEY;
  return exec('npm', ['run', '--silent', 'native:fixture'], { cwd: process.cwd(), env, timeout: 30_000 });
}

test('native:fixture subprocess leaves a replayable public CLI state with one setup', async () => {
  const example = JSON.parse((await runFixtureExample()).stdout) as {
    fixture: boolean;
    state: string;
    commandId: string;
    paths: { root: string; config: string; repository: string; stateDirectory: string; destination: string };
    result?: { status: string };
  };
  assert.equal(example.fixture, true);
  assert.equal(example.state, 'succeeded');
  assert.equal(example.result?.status, 'succeeded');
  try {
    const replay = JSON.parse((await runPublicCli(example.paths.config, example.paths.repository)).stdout) as { state: string; commandId: string };
    assert.equal(replay.state, 'succeeded');
    assert.equal(replay.commandId, example.commandId);
    const config = nativeCommandConfigSchema.parse(JSON.parse(await readFile(example.paths.config, 'utf8')));
    const host = await openHost({ stateDirectory: config.stateDirectory, kinds: nativeCommandKinds(config) });
    try {
      const snapshot = await host.snapshot(config.runId);
      assert.equal(snapshot.commands.filter((entry) => entry.command.kind === 'worker.spawn').length, 1);
      assert.equal(snapshot.commands.filter((entry) => entry.command.kind === 'pi.model').length, 1);
    } finally { host.close(); }
  } finally {
    await rm(example.paths.root, { recursive: true, force: true });
  }
});

test('public native CLI composition launches the real provider-free Pi fixture and replay observes it', async () => {
  const fixture = await createLiveNativeFixture('task-live', { ownershipExpiresAt: '2026-09-17T00:00:01.000Z', hostNow: fixtureStamp });
  try {
    await fixture.writeConfig();
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage(workerEnvelope())]);
    const launched = JSON.parse(await nativeCli(args(fixture.configPath), fixture.environment)) as { state: string; commandId: string; result?: { status: string } };
    assert.equal(launched.state, 'succeeded', 'fixture launch reports the worker result, not setup readiness');
    assert.equal(launched.result?.status, 'succeeded');
    assert.equal(fixture.faux.state.callCount, 1);

    // The shipped public CLI path reopens only the durable host projection.
    // Closing the fixture removes its model catalog and active in-memory lease
    // from this process; replay must not ask the provider for credentials.
    await fixture.close(false);
    delete process.env.FIXTURE_KEY;
    const replayed = JSON.parse((await runPublicCli(fixture.configPath, fixture.repo)).stdout) as { state: string; commandId: string };
    assert.equal(replayed.state, 'succeeded');
    assert.equal(replayed.commandId, launched.commandId);
    await rm(fixture.root, { recursive: true, force: true });
  } catch (error) {
    await fixture.close().catch(() => undefined);
    throw error;
  }
});

test('native CLI reports failed worker envelopes honestly and pre-launch abort has no provider effect', async () => {
  const failed = await createLiveNativeFixture('task-failed');
  try {
    await failed.writeConfig();
    failed.faux.setResponses([failed.ai.fauxAssistantMessage(workerEnvelope('failed'))]);
    const result = JSON.parse(await nativeCli(args(failed.configPath), failed.environment)) as { state: string; commandStatus: string; result?: { status: string } };
    assert.equal(result.state, 'failed');
    assert.equal(result.commandStatus, 'succeeded', 'durable spawn setup succeeded while the worker outcome failed');
    assert.equal(result.result?.status, 'failed');
    assert.notEqual(result.state, 'succeeded');
    await failed.close(false);
    await assert.rejects(runPublicCli(failed.configPath, failed.repo), (error: unknown) => {
      const output = error as { code?: number; stdout?: string };
      assert.equal(output.code, 1);
      const replayed = JSON.parse(output.stdout ?? '') as { state: string; commandStatus: string; result?: { status: string } };
      assert.equal(replayed.state, 'failed');
      assert.equal(replayed.commandStatus, 'succeeded');
      assert.equal(replayed.result?.status, 'failed');
      return true;
    });
    await rm(failed.root, { recursive: true, force: true });
  } finally { await failed.close().catch(() => undefined); }

  const aborted = await createLiveNativeFixture('task-aborted');
  try {
    await aborted.writeConfig();
    const controller = new AbortController();
    controller.abort();
    const result = JSON.parse(await nativeCli(args(aborted.configPath), aborted.environment, { signal: controller.signal })) as { state: string; commandStatus: string };
    assert.equal(result.state, 'cancelled');
    assert.equal(result.commandStatus, 'not-dispatched');
    assert.equal(aborted.faux.state.callCount, 0);
  } finally { await aborted.close(); }
});


test('fresh public CLI sees its unreferenced lease and resolves an inline model before missing credentials refuse', async () => {
  const fixture = await createLiveNativeFixture('fresh-inline-route');
  const credential = 'HELM_TEST_UNSET_OPENROUTER_KEY';
  const previous = process.env[credential];
  delete process.env[credential];
  try {
    const config = nativeCommandConfigSchema.parse({ ...fixture.config,
      modelId: 'helm-test/model-not-in-catalog', modelProvider: 'openrouter', modelFamily: 'fixture', modelApi: 'openai-completions', modelBaseUrl: 'https://openrouter.ai/api/v1', credentialEnvironment: credential,
      openRouterModel: { name: 'Synthetic inline model', reasoning: false, input: ['text'] },
      openRouterRouting: { only: ['baseten'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true, max_price: { prompt: 0.3, completion: 1.2 } },
      policy: { ...fixture.config.policy, baseUrl: 'https://openrouter.ai/api/v1', authEnvironment: credential, inputUsdPerMillion: 0.3, outputUsdPerMillion: 1.2 },
    });
    fixture.host.recordModelFact({ modelId: config.modelId, provider: 'openrouter', poolId: config.policy.poolId, enabled: true, capabilities: ['build'], roles: ['builder'], dataPolicy: 'public-only', availability: 'known_available', factVersion: 1, observedAt: fixtureStamp });
    assert.equal((await fixture.host.snapshot(config.runId)).autonomyLeases.length, 0, 'fresh run display snapshot deliberately has no command-linked lease');
    await writeFile(fixture.configPath, JSON.stringify(config));
    await fixture.close(false);
    await assert.rejects(() => nativeCli(args(fixture.configPath)), /configured native command credential is unavailable/);
    const reopened = await openHost({ stateDirectory: config.stateDirectory, kinds: nativeCommandKinds(config) });
    try { assert.equal(reopened.readFleetProjection(config.runId).commands.length, 0); }
    finally { reopened.close(); }
  } finally {
    if (previous === undefined) delete process.env[credential]; else process.env[credential] = previous;
    await fixture.close().catch(() => undefined);
  }
});
