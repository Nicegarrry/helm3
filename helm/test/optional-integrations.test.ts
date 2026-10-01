/** A fresh install: empty HELM_HOME, no env, no Discord/taps/CG/deploys/host. Core loop must work and stay quiet. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createDiscord } from '../src/discord.ts';
import { gateRunner } from '../src/gate.ts';
import { Helm } from '../src/helm.ts';
import { createMemorySync } from '../src/memory-sync.ts';
import { builderPrompt, reviewerPrompt, validatorPrompt } from '../src/prompt.ts';
import { loadSettings } from '../src/settings.ts';
import { openStore } from '../src/store.ts';
import { createToolRegistry } from '../src/tools.ts';
import type { GitHub, HelmConfig } from '../src/types.ts';
import { piWorkerRunner } from '../src/worker.ts';
import { gitWorkspace } from '../src/workspace.ts';
import { disableGitMaintenance, removeTempDir } from './git-fixture.ts';

const exec = promisify(execFile);
const noGitHub: GitHub = { async openPr() { throw new Error('unused'); }, async prStatus() { throw new Error('unused'); }, async comment() { throw new Error('unused'); }, async postComment() { throw new Error('unused'); }, async merge() { throw new Error('unused'); } };

test('empty HELM_HOME and empty env: spawn, gate and status work and nothing tries Discord or Common Ground', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-optional-'));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  await exec('git', ['init', '-b', 'main', repo]);
  disableGitMaintenance(repo);
  await exec('git', ['-C', repo, 'config', 'user.name', 't']);
  await exec('git', ['-C', repo, 'config', 'user.email', 't@example.invalid']);
  writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [{ name: 'hello-exists', command: 'test -f hello.txt' }] }));
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  const faux = ai.fauxProvider({ provider: 'opt-faux', models: [{ id: 'offline' }] });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey('opt-faux', 'fixture');
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall('write', { path: 'hello.txt', content: 'hi\n' })]),
    ai.fauxAssistantMessage(JSON.stringify({ status: 'succeeded', summary: 'Added hello.txt', changedFiles: ['hello.txt'], commandsRun: [] })),
  ]);

  const attempts: string[] = [];
  const settings = loadSettings(home);
  const store = openStore(join(home, 'helm.sqlite'));
  const discord = createDiscord({ store, settings, home, env: {}, envFile: join(root, 'no-env'), fetch: async (url) => { attempts.push(String(url)); return new Response('{}'); } });
  const sync = createMemorySync({ store, settings, env: {}, envFile: join(root, 'no-env'), clientFactory: () => { attempts.push('cg'); throw new Error('unexpected CG client'); } });
  const config: HelmConfig = { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 60_000 };
  const alreadySandboxed = process.env.HELM_GATE_SANDBOXED === '1';
  const helm = new Helm({ config, store, workspace: gitWorkspace(), gates: gateRunner({ allowUnsandboxed: process.platform !== 'darwin' || alreadySandboxed }), github: noGitHub, runner: piWorkerRunner({ modelRuntime }), prompts: { builder: builderPrompt, reviewer: reviewerPrompt, validator: validatorPrompt }, discord });
  try {
    const spawned = await helm.spawn({ repo, objective: 'Create hello.txt.', model: 'opt-faux/offline', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    assert.ok(spawned.ok && spawned.workerId);
    await helm.settle(spawned.workerId);
    const gate = await helm.gate({ workerId: spawned.workerId });
    assert.equal(gate.ok && (gate as { passed: boolean }).passed, true);
    assert.equal((await helm.runStatus()).ok, true);
    await discord.tick();
    await sync();

    assert.deepEqual(attempts, []);
    assert.ok(!store.listEvents('memory:sync').length, 'no CG events without configuration');

    const tools = createToolRegistry(helm);
    assert.deepEqual(await tools.call('notify.owner', { project: 'o/r', text: 'hi' }), { ok: false, reason: 'no notify channel: set discord.projects["o/r"].webhookEnv in helm.json' });
    assert.deepEqual(await tools.call('notify.nick', { project: 'o/r', text: 'hi' }), await tools.call('notify.owner', { project: 'o/r', text: 'hi' }));
    const tap = await tools.call('tap.request', { project: 'o/r', kind: 'spend.cap', action: 'raise' });
    assert.equal(tap.ok, false);
    assert.match(String((tap as { reason?: string }).reason), /discord\.tapWebhookEnv/);
    const raised = await tools.call('spend.set', { maxWorkers: 10 });
    assert.match(String((raised as { reason?: string }).reason), /discord\.tapWebhookEnv/);
    assert.deepEqual(attempts, []);
  } finally {
    store.close();
    removeTempDir(root);
  }
});
