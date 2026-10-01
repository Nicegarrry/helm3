/** Real daemon handover and recovery checks for the standalone upgrade helper. */
import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { daemonAuthorization } from '../bin/daemon-auth.mjs';
import { control, digestRelease, stageRelease, launchUpgrade } from '../bin/update.mjs';
import { openStore } from '../src/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { serve } from '../src/server.js';
import type { Helm } from '../src/helm.js';
import { cleanupTestDaemons, spawnTestDaemon } from './daemon-fixture.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));
async function eventually<T>(get: () => Promise<T> | T, accept: (value: T) => boolean, timeout = 90000): Promise<T> {
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
  const child = spawnTestDaemon(home, process.execPath, ['--import', 'tsx', join(packageRoot, 'src', 'cli.ts'), 'serve', '--http'], {
    cwd: packageRoot, env: { ...process.env, HELM_HOME: home, HELM_UPGRADE_ID: '', HELM_SPEND_CAP_USD: '3.75', HELM_MAX_WORKERS: '2', HELM_ROUTING_STARTUP_CHECK: '0', ...extraEnv }, stdio: ['ignore', 'ignore', 'pipe'],
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
    await cleanupTestDaemons(home);
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
import { join, resolve } from 'node:path';
const emit = (event) => console.log(JSON.stringify(event));
const args = process.argv.slice(2);
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({ models: [{ slug: 'gpt-5.6-luna' }] }));
  process.exit(0);
}
const cdFlag = ['-C', '--cd'].find((flag) => args.includes(flag));
if (!cdFlag) process.exit(2);
const worktree = args[args.indexOf(cdFlag) + 1];
process.stdin.resume();
emit({ type: 'thread.started', thread_id: 'synthetic-session' });
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(proceed)})) return;
  clearInterval(timer);
  writeFileSync(join(resolve(worktree), 'completed.txt'), 'synthetic worker finished before restart');
  emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'succeeded', summary: 'complete synthetic work', changedFiles: ['completed.txt'], commandsRun: [] }) } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } });
  process.exit(0);
}, 30);
`);
  chmodSync(fakeCodex, 0o755);
  const old = await start(home, { HELM_CODEX_BIN: fakeCodex });
  const before = await control(old.port, { action: 'status' }, home);
  const post = async (name: string, body: object) => (await (await fetch(`http://127.0.0.1:${old.port}/tools/${name}`, { method: 'POST', headers: { authorization: daemonAuthorization(home), 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as any;
  const spawned = await post('worker.spawn', { repo, objective: 'synthetic task', model: 'codex/gpt-6-luna:medium', difficulty: 'easy' });
  assert.ok(spawned.ok, JSON.stringify(spawned));
  await eventually(() => post('worker.inspect', { workerId: spawned.workerId }), (s) => s.state === 'running' && s.events.some((e: any) => e.kind === 'turn.start'));
  await control(old.port, { action: 'upgrade', timeoutMs: 10000 }, home);
  assert.equal((await control(old.port, { action: 'status' }, home)).phase, 'draining');
  assert.match((await post('worker.spawn', { repo, objective: 'must wait' })).reason, /draining/);
  writeFileSync(proceed, 'finish');
  const done = await eventually(() => read(join(home, 'upgrade.json')), (s) => ['completed', 'failed', 'timed_out'].includes(s.phase));
  assert.equal(done.phase, 'completed', JSON.stringify(done) + '\n' + old.errors());
  const after = await control(old.port, { action: 'status' }, home);
  assert.equal(after.phase, 'accepting');
  assert.equal(after.version, staged.version);
  assert.equal(after.revision, staged.revision);
  assert.notEqual(after.bootId, before.bootId);
  assert.notEqual(after.pid, before.pid);
  const status = await (await fetch(`http://127.0.0.1:${old.port}/tools/run.status`, { method: 'POST', headers: { authorization: daemonAuthorization(home) }, body: '{}' })).json() as Record<string, unknown>;
  assert.equal(status.spendCapUsd, 3.75);
  assert.equal(status.maxWorkers, 2);
  assert.deepEqual(read(join(home, 'current-release.json')), staged);
  const worker = await post('worker.inspect', { workerId: spawned.workerId });
  assert.equal(worker.state, 'succeeded');
  assert.equal(worker.model, 'codex/gpt-6-luna:medium');
  assert.match(worker.head, /^[a-f0-9]{40}$/);
  assert.equal(readFileSync(join(spawned.worktree, 'completed.txt'), 'utf8'), 'synthetic worker finished before restart');
  assert.equal(existsSync(join(packageRoot, 'completed.txt')), false);
  await control(old.port, { action: 'shutdown' }, home);
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
  await control(server.port!, { action: 'upgrade', timeoutMs: 20 }, home);
  const done = await eventually(() => read(join(home, 'upgrade.json')), (s) => s.phase === 'timed_out' || s.phase === 'failed');
  assert.equal(done.phase, 'timed_out', JSON.stringify(done));
  assert.deepEqual(done.blockers, ['worker:still-working']);
  assert.equal((await control(server.port!, { action: 'status' }, home)).phase, 'draining');
  await eventually(() => existsSync(join(home, 'upgrade.lock')), (locked) => !locked);
  assert.equal((await control(server.port!, { action: 'resume' }, home)).phase, 'accepting');
});

test('changed release is refused before shutdown', async (t) => {
  const home = testHome(t);
  const staged = candidate(join(home, 'candidate'));
  write(join(home, 'staged-release.json'), staged);
  writeFileSync(join(staged.root, 'helm', 'src', 'cli.ts'), 'changed');
  const old = await start(home);
  const before = await control(old.port, { action: 'status' }, home);
  await control(old.port, { action: 'upgrade', timeoutMs: 1000 }, home);
  const done = await eventually(() => read(join(home, 'upgrade.json')), (s) => s.phase === 'failed');
  assert.match(done.error, /changed after validation/);
  assert.equal((await control(old.port, { action: 'status' }, home)).bootId, before.bootId);
  assert.equal((await control(old.port, { action: 'status' }, home)).phase, 'ready');
  await control(old.port, { action: 'shutdown' }, home);
  await eventually(() => existsSync(join(home, 'daemon.lock')), (locked) => !locked);
});

test('failed candidate startup leaves admissions closed and does not change the selected release', async (t) => {
  const home = testHome(t);
  const staged = candidate(join(home, 'candidate'));
  writeFileSync(join(staged.root, 'helm', 'src', 'cli.ts'), 'process.exit(42);');
  staged.digest = digestRelease(staged.root);
  write(join(home, 'staged-release.json'), staged);
  const old = await start(home);
  await control(old.port, { action: 'upgrade', timeoutMs: 1000 }, home);
  const done = await eventually(() => read(join(home, 'upgrade.json')), (s) => s.phase === 'failed');
  assert.match(done.error, /new daemon exited 42/);
  assert.ok(existsSync(join(home, 'drain.json')));
  assert.equal(existsSync(join(home, 'current-release.json')), false);
  assert.equal(done.handoverStarted, true);
  await eventually(() => existsSync(join(home, 'upgrade.lock')), (locked) => !locked);
  assert.throws(() => execFileSync(process.execPath, ['--import', 'tsx', join(packageRoot, 'src', 'cli.ts'), 'serve', '--stdio'], {
    cwd: packageRoot, env: { ...process.env, HELM_HOME: home }, timeout: 5000, stdio: 'pipe',
  }), /explicit manual recovery/);
  assert.equal(existsSync(join(home, 'daemon.lock')), false);
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
  assert.equal(git('rev-parse', '--is-shallow-repository'), 'false');
});

test('staging leaves the source repository non-shallow', (t) => {
  const home = testHome(t);
  const repo = join(home, 'repo');
  mkdirSync(join(repo, 'helm', 'src'), { recursive: true });
  write(join(repo, 'helm', 'package.json'), { version: '1.5.1-test' });
  writeFileSync(join(repo, 'helm', 'src', 'lifecycle.ts'), '// supported');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', 'helm'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  assert.equal(git('rev-parse', '--is-shallow-repository'), 'false');
  stageRelease(home, repo, 'HEAD', () => {});
  assert.equal(git('rev-parse', '--is-shallow-repository'), 'false');
});

test('a second real daemon is refused without interrupting the first owner', async (t) => {
  const home = testHome(t);
  const old = await start(home);
  const before = await control(old.port, { action: 'status' }, home);
  const second = spawnTestDaemon(home, process.execPath, ['--import', 'tsx', join(packageRoot, 'src', 'cli.ts'), 'serve', '--http'], {
    cwd: packageRoot, env: { ...process.env, HELM_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  second.stderr!.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => second.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /already running/);
  assert.equal((await control(old.port, { action: 'status' }, home)).bootId, before.bootId);
  await control(old.port, { action: 'shutdown' }, home);
  await eventually(() => existsSync(join(home, 'daemon.lock')), (locked) => !locked);
});


test('signal metadata failure leaves the daemon alive', async (t) => {
  const home = testHome(t);
  const old = await start(home);
  const before = await control(old.port, { action: 'status' }, home);
  mkdirSync(join(home, 'drain.json'));
  old.child.kill('SIGTERM');
  await eventually(old.errors, (errors) => errors.includes('EISDIR'));
  assert.equal(old.child.exitCode, null);
  assert.equal((await control(old.port, { action: 'status' }, home)).bootId, before.bootId);
  rmSync(join(home, 'drain.json'), { recursive: true });
  await control(old.port, { action: 'shutdown' }, home);
  await eventually(() => existsSync(join(home, 'daemon.lock')), (locked) => !locked);
});

test('upgrade setup failure releases its lock before any helper starts', (t) => {
  const home = testHome(t);
  write(join(home, 'staged-release.json'), {});
  mkdirSync(join(home, 'upgrade.log'));
  assert.throws(() => launchUpgrade(home, 1, { bootId: 'test' }, 1000), /EISDIR/);
  assert.equal(existsSync(join(home, 'upgrade.lock')), false);
  assert.equal(existsSync(join(home, 'upgrade.json')), false);
});

test('release digest covers installed and linked dependencies', (t) => {
  const home = testHome(t);
  const root = join(home, 'release'), dependency = join(home, 'dependency');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  mkdirSync(dependency);
  writeFileSync(join(dependency, 'index.js'), 'original');
  symlinkSync(dependency, join(root, 'node_modules', 'dependency'), 'dir');
  const before = digestRelease(root);
  writeFileSync(join(dependency, 'index.js'), 'changed');
  assert.notEqual(digestRelease(root), before);
  symlinkSync(root, join(dependency, 'cycle'), 'dir');
  assert.throws(() => digestRelease(root), /symlink cycle/);
});

test('token-aware upgrade helper checks and resumes a token-requiring daemon', async (t) => {
  const home = testHome(t);
  const lifecycle = new Lifecycle(home, () => []);
  lifecycle.drain();
  const server = await serve({ helm: { config: { home }, lifecycle } as unknown as Helm });
  t.after(() => server.close());
  assert.match(read(join(home, 'serve.json')).token, /^[a-f0-9]{64}$/);
  const unauthenticated = await fetch(`http://127.0.0.1:${server.port}/tools/daemon.control`, {
    method: 'POST', body: JSON.stringify({ action: 'resume' }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(await unauthenticated.text(), '');
  assert.equal((await control(server.port!, { action: 'status' }, home)).phase, 'ready');
  assert.equal((await control(server.port!, { action: 'resume' }, home)).phase, 'accepting');
  assert.equal((await control(server.port!, { action: 'status' }, home)).phase, 'accepting');
});
