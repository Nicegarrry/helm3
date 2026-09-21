import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { control, digestRelease, stageRelease } from '../bin/update.mjs';
import { openStore } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { serve } from '../src/server.js';
import type { Helm } from '../src/helm.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));
async function eventually<T>(get: () => Promise<T> | T, accept: (value: T) => boolean, timeout = 20000): Promise<T> {
  const end = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < end) {
    try { last = await get(); if (accept(last)) return last; } catch { /* waiting for startup */ }
    await sleep(100);
  }
  throw new Error(`condition timed out; last=${JSON.stringify(last)}`);
}
function candidate(root: string, version = '1.5.1-test') {
  mkdirSync(join(root, 'helm'), { recursive: true });
  for (const name of ['src', 'bin', 'package.json']) cpSync(join(packageRoot, name), join(root, 'helm', name), { recursive: true });
  const pkg = read(join(root, 'helm', 'package.json'));
  write(join(root, 'helm', 'package.json'), { ...pkg, version });
  write(join(root, 'helm', 'release.json'), { revision: 'a'.repeat(40), version });
  symlinkSync(realpathSync(join(packageRoot, '..', 'node_modules')), join(root, 'node_modules'), 'dir');
  return { root, version, revision: 'a'.repeat(40), digest: digestRelease(root) };
}
async function start(home: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; port: number; errors: () => string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(packageRoot, 'src', 'cli.ts'), 'serve', '--http'], {
    cwd: packageRoot, env: { ...process.env, HELM_HOME: home, HELM_UPGRADE_ID: '', HELM_SPEND_CAP_USD: '3.75', HELM_MAX_WORKERS: '2', ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr!.on('data', (chunk) => { errors += chunk; });
  try {
    const state = await eventually(() => read(join(home, 'serve.json')), (s) => s.pid === child.pid);
    return { child, port: state.port as number, errors: () => errors };
  } catch (err) { child.kill('SIGKILL'); throw new Error(`${String(err)}\n${errors}`); }
}
function testHome(t: { after: (fn: () => void | Promise<void>) => void }) {
  const home = mkdtempSync(join(tmpdir(), 'helm-upgrade-'));
  t.after(async () => {
    // Every PID here came from this test's private home, never the operator's daemon.
    for (const file of ['serve.json', 'upgrade.json']) {
      try { const value = read(join(home, file)); const pid = value.pid ?? value.helperPid; if (pid && pid !== process.pid) process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test('real daemon handover retains its port and configuration, reopens only after target identity passes', async (t) => {
  const home = testHome(t);
  const staged = candidate(join(home, 'candidate'));
  write(join(home, 'staged-release.json'), staged);
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), 'synthetic upgrade test');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
  const proceed = join(home, 'continue-worker');
  const fakeCodex = join(home, 'synthetic-codex.mjs');
  writeFileSync(fakeCodex, `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs';
const emit = (event) => console.log(JSON.stringify(event));
process.stdin.resume();
emit({ type: 'thread.started', thread_id: 'synthetic-session' });
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(proceed)})) return;
  clearInterval(timer);
  writeFileSync('completed.txt', 'synthetic worker finished before restart');
  emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'succeeded', summary: 'complete synthetic work', changedFiles: ['completed.txt'], commandsRun: [] }) } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } });
  process.exit(0);
}, 30);
`);
  chmodSync(fakeCodex, 0o755);
  const old = await start(home, { HELM_CODEX_BIN: fakeCodex });
  const before = await control(old.port, { action: 'status' });
  const post = async (name: string, body: object) => (await (await fetch(`http://127.0.0.1:${old.port}/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as any;
  const spawned = await post('worker.spawn', { repo, objective: 'synthetic task', difficulty: 'easy' });
  assert.ok(spawned.ok, JSON.stringify(spawned));
  await eventually(() => post('worker.inspect', { workerId: spawned.workerId }), (s) => s.state === 'running' && s.events.some((e: any) => e.kind === 'turn.start'));
  await control(old.port, { action: 'upgrade', timeoutMs: 10000 });
  assert.equal((await control(old.port, { action: 'status' })).phase, 'draining');
  assert.match((await post('worker.spawn', { repo, objective: 'must wait' })).reason, /draining/);
  writeFileSync(proceed, 'finish');
  const done = await eventually(() => read(join(home, 'upgrade.json')), (s) => ['completed', 'failed', 'timed_out'].includes(s.phase));
  assert.equal(done.phase, 'completed', JSON.stringify(done) + '\n' + old.errors());
  const after = await control(old.port, { action: 'status' });
  assert.equal(after.phase, 'accepting');
  assert.equal(after.version, staged.version);
  assert.equal(after.revision, staged.revision);
  assert.notEqual(after.bootId, before.bootId);
  assert.notEqual(after.pid, before.pid);
  const status = await (await fetch(`http://127.0.0.1:${old.port}/tools/run.status`, { method: 'POST', body: '{}' })).json() as Record<string, unknown>;
  assert.equal(status.spendCapUsd, 3.75);
  assert.equal(status.maxWorkers, 2);
  assert.deepEqual(read(join(home, 'current-release.json')), staged);
  const worker = await post('worker.inspect', { workerId: spawned.workerId });
  assert.equal(worker.state, 'succeeded');
  assert.equal(worker.model, 'codex/gpt-5.6-luna:medium');
  assert.match(worker.head, /^[a-f0-9]{40}$/);
  assert.equal(readFileSync(join(spawned.worktree, 'completed.txt'), 'utf8'), 'synthetic worker finished before restart');
  await control(old.port, { action: 'shutdown' });
  await eventually(() => existsSync(join(home, 'daemon.lock')), (locked) => !locked);
  const store = openStore(join(home, 'helm.sqlite'));
  assert.equal(store.getWorker(spawned.workerId)?.sessionFile, 'codex-thread:synthetic-session');
  store.close();
});

test('drain timeout leaves the daemon and worker alive, records blockers, and permits resume', async (t) => {
  const home = testHome(t);
  write(join(home, 'staged-release.json'), candidate(join(home, 'candidate')));
  const lifecycle = new Lifecycle(home, () => ['still-working']);
  const helm = { config: { home }, lifecycle } as unknown as Helm;
  const server = await serve({ helm });
  t.after(() => server.close());
  const { launchUpgrade } = await import('../bin/update.mjs');
  lifecycle.upgrade = (timeout) => launchUpgrade(home, server.port!, lifecycle.status(), timeout);
  await control(server.port!, { action: 'upgrade', timeoutMs: 20 });
  const done = await eventually(() => read(join(home, 'upgrade.json')), (s) => s.phase === 'timed_out' || s.phase === 'failed');
  assert.equal(done.phase, 'timed_out', JSON.stringify(done));
  assert.deepEqual(done.blockers, ['worker:still-working']);
  assert.equal((await control(server.port!, { action: 'status' })).phase, 'draining');
  await eventually(() => existsSync(join(home, 'upgrade.lock')), (locked) => !locked);
  assert.equal((await control(server.port!, { action: 'resume' })).phase, 'accepting');
});

test('changed release is refused before shutdown', async (t) => {
  const home = testHome(t);
  const staged = candidate(join(home, 'candidate'));
  write(join(home, 'staged-release.json'), staged);
  writeFileSync(join(staged.root, 'helm', 'src', 'cli.ts'), 'changed');
  const old = await start(home);
  const before = await control(old.port, { action: 'status' });
  await control(old.port, { action: 'upgrade', timeoutMs: 1000 });
  const done = await eventually(() => read(join(home, 'upgrade.json')), (s) => s.phase === 'failed');
  assert.match(done.error, /changed after validation/);
  assert.equal((await control(old.port, { action: 'status' })).bootId, before.bootId);
  assert.equal((await control(old.port, { action: 'status' })).phase, 'ready');
  await control(old.port, { action: 'shutdown' });
  await eventually(() => existsSync(join(home, 'daemon.lock')), (locked) => !locked);
});

test('failed candidate startup leaves admissions closed and does not change the selected release', async (t) => {
  const home = testHome(t);
  const staged = candidate(join(home, 'candidate'));
  writeFileSync(join(staged.root, 'helm', 'src', 'cli.ts'), 'process.exit(42);');
  staged.digest = digestRelease(staged.root);
  write(join(home, 'staged-release.json'), staged);
  const old = await start(home);
  await control(old.port, { action: 'upgrade', timeoutMs: 1000 });
  const done = await eventually(() => read(join(home, 'upgrade.json')), (s) => s.phase === 'failed');
  assert.match(done.error, /new daemon exited 42/);
  assert.ok(existsSync(join(home, 'drain.json')));
  assert.equal(existsSync(join(home, 'current-release.json')), false);
});

test('staging pins an archive, isolates validation, and preserves prior selection on failure', (t) => {
  const home = testHome(t);
  const repo = join(home, 'repo');
  mkdirSync(join(repo, 'helm', 'src'), { recursive: true });
  write(join(repo, 'helm', 'package.json'), { version: '1.5.1-test' });
  writeFileSync(join(repo, 'helm', 'src', 'lifecycle.ts'), '// supported');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', 'helm'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'helm', 'src', 'lifecycle.ts'), '// uncommitted change must not be staged');
  let validation = false;
  const staged = stageRelease(home, repo, 'HEAD', (root, env) => {
    validation = true;
    assert.notEqual(env.HELM_HOME, home);
    assert.equal(readFileSync(join(root, 'helm', 'src', 'lifecycle.ts'), 'utf8'), '// supported');
  });
  assert.ok(validation);
  assert.equal(staged.revision, revision);
  assert.equal(digestRelease(staged.root), staged.digest);
  assert.throws(() => stageRelease(home, repo, 'HEAD', () => { throw new Error('gate failed'); }), /gate failed/);
  assert.deepEqual(read(join(home, 'staged-release.json')), staged);
  assert.equal(existsSync(join(home, 'upgrade.lock')), false);
});

test('a second real daemon is refused without interrupting the first owner', async (t) => {
  const home = testHome(t);
  const old = await start(home);
  const before = await control(old.port, { action: 'status' });
  const second = spawn(process.execPath, ['--import', 'tsx', join(packageRoot, 'src', 'cli.ts'), 'serve', '--http'], {
    cwd: packageRoot, env: { ...process.env, HELM_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  second.stderr!.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => second.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /already running/);
  assert.equal((await control(old.port, { action: 'status' })).bootId, before.bootId);
  await control(old.port, { action: 'shutdown' });
  await eventually(() => existsSync(join(home, 'daemon.lock')), (locked) => !locked);
});
