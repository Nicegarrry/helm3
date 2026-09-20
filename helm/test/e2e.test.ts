/**
 * Provider-free end-to-end smoke: real SQLite store, real git worktree, real gate
 * runner, real Pi session on the faux provider, real HTTP daemon. Only GitHub is
 * faked (no `gh` here). This is the closest local stand-in for the Wave A exit proof.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gateRunner } from '../src/gate.ts';
import { Helm } from '../src/helm.ts';
import { builderPrompt, reviewerPrompt } from '../src/prompt.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import type { GitHub, HelmConfig, PrStatus } from '../src/types.ts';
import { piWorkerRunner } from '../src/worker.ts';
import { gitWorkspace } from '../src/workspace.ts';

const exec = promisify(execFile);

async function makeRepoWithOrigin(root: string): Promise<{ repo: string; sha: string }> {
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  await exec('git', ['init', '--bare', '-b', 'main', origin]);
  await exec('git', ['init', '-b', 'main', repo]);
  await exec('git', ['-C', repo, 'config', 'user.name', 'e2e']);
  await exec('git', ['-C', repo, 'config', 'user.email', 'e2e@example.invalid']);
  writeFileSync(join(repo, 'README.md'), '# target\n');
  writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [{ name: 'hello-exists', command: 'test -f hello.txt' }] }));
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  await exec('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  await exec('git', ['-C', repo, 'push', '-u', 'origin', 'main']);
  const { stdout } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD']);
  return { repo, sha: stdout.trim() };
}

function fakeGitHub(calls: string[]): GitHub {
  let head = '';
  return {
    async openPr(input) { head = input.head; calls.push(`openPr ${input.base} <- ${input.head} draft=${input.draft} title=${input.title}`); return { number: 7, url: 'https://github.example/pr/7' }; },
    async prStatus(slug, number): Promise<PrStatus> { calls.push(`prStatus ${slug}#${number}`); return { number, state: 'open', head, mergeable: true, draft: false, checks: [], reviews: [], url: 'https://github.example/pr/7' }; },
    async comment(slug, number, body) { calls.push(`comment ${slug}#${number}: ${body.slice(0, 60)}`); },
    async merge(slug, number, expectedHead) { calls.push(`merge ${slug}#${number} ${expectedHead}`); },
  };
}

test('e2e: spawn -> faux Pi writes a file -> commit -> gate -> pr.open -> daemon reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-e2e-'));
  const home = join(root, 'home');
  const { repo, sha } = await makeRepoWithOrigin(root);
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  const faux = ai.fauxProvider({ provider: 'e2e-faux', models: [{ id: 'offline', cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 } }] });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey('e2e-faux', 'fixture');
  faux.setResponses([
    ai.fauxAssistantMessage([ai.fauxToolCall('write', { path: 'hello.txt', content: 'hello from a helm worker\n' })]),
    ai.fauxAssistantMessage([ai.fauxToolCall('bash', { command: 'git push origin HEAD' })]),
    ai.fauxAssistantMessage(JSON.stringify({ status: 'succeeded', summary: 'Added hello.txt', changedFiles: ['hello.txt'], commandsRun: [] })),
  ]);

  const config: HelmConfig = { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 60_000 };
  const store = openStore(join(home, 'helm.sqlite'));
  const ghCalls: string[] = [];
  const helm = new Helm({ config, store, workspace: gitWorkspace(), gates: gateRunner(), github: fakeGitHub(ghCalls), runner: piWorkerRunner({ modelRuntime }), prompts: { builder: builderPrompt, reviewer: reviewerPrompt } });
  const daemon = await serve({ helm, mode: 'http', port: 0 });
  try {
    const spawned = await helm.spawn({ repo, objective: 'Create hello.txt containing a greeting.', model: 'e2e-faux/offline', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    assert.equal(spawned.branch, `helm/${spawned.workerId}`);
    await helm.settle(spawned.workerId);

    const inspected = await helm.inspect({ workerId: spawned.workerId, tail: 50 });
    assert.equal(inspected.ok, true);
    if (!inspected.ok) return;
    const w = (inspected as unknown as { worker: { state: string; head: string | null; result: { status: string } | null } }).worker ?? inspected;
    const kinds = ((inspected as unknown as { events: Array<{ kind: string }> }).events ?? []).map((e) => e.kind);
    assert.ok(kinds.includes('tool.call'), `expected tool.call in ${kinds.join(',')}`);
    assert.ok(kinds.includes('tool.refused'), `expected tool.refused (git push) in ${kinds.join(',')}`);
    assert.ok((inspected as { spendUsd: number }).spendUsd > 0, 'usage priced into spend');
    assert.equal((w as { state: string }).state, 'succeeded');
    assert.notEqual((w as { head: string | null }).head, sha, 'worker commit advanced the head');
    assert.equal(readFileSync(join(spawned.worktree, 'hello.txt'), 'utf8'), 'hello from a helm worker\n');

    const gate = await helm.gate({ workerId: spawned.workerId });
    assert.equal(gate.ok, true);
    if (!gate.ok) return;
    assert.equal((gate as { passed: boolean }).passed, true);

    const pr = await helm.prOpen({ workerId: spawned.workerId, draft: true });
    assert.equal(pr.ok, true, JSON.stringify(pr));
    if (!pr.ok) return;
    assert.equal((pr as { number: number }).number, 7);
    assert.match(ghCalls[0] ?? '', /^openPr main <- helm\/w-/);
    const { stdout: remoteBranches } = await exec('git', ['-C', join(root, 'origin.git'), 'branch', '--list']);
    assert.match(remoteBranches, new RegExp(`helm/${spawned.workerId}`), 'branch was pushed to origin');

    const status = await helm.runStatus();
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.ok((status as { spendUsd: number }).spendUsd > 0, 'faux usage priced');

    const port = daemon.port!;
    const listed = await fetch(`http://127.0.0.1:${port}/tools/worker.list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = (await listed.json()) as { ok: boolean; workers: Array<{ workerId: string; state: string }> };
    assert.equal(body.ok, true);
    assert.equal(body.workers[0]?.workerId, spawned.workerId);
    assert.equal(body.workers[0]?.state, 'succeeded');
    const table = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(table, new RegExp(spawned.workerId));
    assert.ok(existsSync(join(home, 'serve.json')));
  } finally {
    await daemon.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('e2e: daemon restart marks a running worker interrupted; steer resumes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-e2e-'));
  const home = join(root, 'home');
  const { repo } = await makeRepoWithOrigin(root);
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, credentials: new ai.InMemoryCredentialStore() });
  const faux = ai.fauxProvider({ provider: 'e2e-faux2', models: [{ id: 'offline' }] });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey('e2e-faux2', 'fixture');
  const config: HelmConfig = { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 60_000 };
  const dbPath = join(home, 'helm.sqlite');
  let store = openStore(dbPath);
  try {
    // First daemon life: the worker is left in 'running' by writing the row directly, as a crash would.
    faux.setResponses([ai.fauxAssistantMessage(JSON.stringify({ status: 'partial', summary: 'started', changedFiles: [], commandsRun: [] }))]);
    let helm = new Helm({ config, store, workspace: gitWorkspace(), gates: gateRunner(), github: fakeGitHub([]), runner: piWorkerRunner({ modelRuntime }), prompts: { builder: builderPrompt, reviewer: reviewerPrompt } });
    const spawned = await helm.spawn({ repo, objective: 'Start something.', model: 'e2e-faux2/offline', role: 'builder', contextPaths: [], allowWorkflows: false });
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    await helm.settle(spawned.workerId);
    assert.equal(store.getWorker(spawned.workerId)?.state, 'idle');
    store.updateWorker(spawned.workerId, { state: 'running' });
    store.close();

    // Second daemon life.
    store = openStore(dbPath);
    helm = new Helm({ config, store, workspace: gitWorkspace(), gates: gateRunner(), github: fakeGitHub([]), runner: piWorkerRunner({ modelRuntime }), prompts: { builder: builderPrompt, reviewer: reviewerPrompt } });
    assert.deepEqual(helm.markInterruptedOnStart(), [spawned.workerId]);
    assert.equal(store.getWorker(spawned.workerId)?.state, 'interrupted');
    assert.ok(store.getWorker(spawned.workerId)?.sessionFile, 'session file recorded for resume');

    faux.setResponses([ai.fauxAssistantMessage(JSON.stringify({ status: 'succeeded', summary: 'finished after resume', changedFiles: [], commandsRun: [] }))]);
    const steered = await helm.steer({ workerId: spawned.workerId, message: 'Continue and finish.' });
    assert.equal(steered.ok, true, JSON.stringify(steered));
    await helm.settle(spawned.workerId);
    assert.equal(store.getWorker(spawned.workerId)?.state, 'succeeded');
    assert.equal(store.getWorker(spawned.workerId)?.result?.summary, 'finished after resume');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
