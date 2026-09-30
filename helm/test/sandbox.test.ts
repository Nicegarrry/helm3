import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import test from 'node:test';
import { gateRunner } from '../src/gate.js';
import { buildSandboxProfile, minimalGateEnv, operatorHomePaths, resolveDarwinGitDir, sandboxExecutable, worktreeGitDirs } from '../src/sandbox.js';

const sandboxUsable = process.platform === 'darwin' && Boolean(sandboxExecutable()) && (() => {
  try { execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true']); return true; } catch { return false; }
})();
const macOnly = process.platform !== 'darwin' ? { skip: 'native sandbox tests require macOS' } : !sandboxUsable ? { skip: 'a usable macOS sandbox-exec is required' } : undefined;

function fixture(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('generated profile denies credentials and writes outside the worktree', () => {
  const home = '/Users/tester';
  const cwd = '/Users/tester/.helm/worktrees/project/w-123';
  const tempDir = '/private/tmp/helm-gate-123';
  const tempHome = join(tempDir, 'home');
  const daemonSocket = '/private/tmp/helm-daemon.sock';
  const profile = buildSandboxProfile({ cwd, tempDir, operatorHomes: [home], gateHome: tempHome, toolchainPaths: [join(home, '.nvm', 'versions', 'node', 'v22', 'bin')], npmCachePaths: [join(home, '.npm')], gitDir: '/Users/tester/.helm/worktrees/project/.git/worktrees/w-123', denyLocalSocketPaths: [daemonSocket], allowNetwork: false });

  assert.match(profile, new RegExp(`\\(deny file-read\\* \\(subpath "${home.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"\\)\\)`));
  assert.match(profile, /\(deny file-read\* \(subpath ".*\/\.config"\)\)/);
  assert.match(profile, /\(allow file-read\* \(subpath ".*\/\.config\/git"\)\)/);
  assert.match(profile, /\(allow file-read-metadata \(literal "\/Users"\)\)/);
  assert.match(profile, new RegExp(`\\(allow file-read-metadata \\(literal "${cwd.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}"\\)\\)`));
  assert.match(profile, /\(allow file-read\* \(subpath ".*\/\.nvm\/versions\/node\/v22\/bin"\)\)/);
  assert.match(profile, /\(allow file-read\* \(subpath ".*\/\.npm"\)\)/);
  assert.match(profile, /\(deny file-read\* \(subpath ".*\/\.ssh"\)\)/);
  assert.match(profile, /\(deny file-read\* \(subpath ".*\/\.helm"\)\)/);
  assert.match(profile, new RegExp(`\\(allow file-write\\* \\(subpath "${cwd.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"\\)\\)`));
  assert.match(profile, new RegExp(`\\(deny file-write\\* \\(subpath "${cwd.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}/\\.git"\\)\\)`));
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(allow signal \(target same-sandbox\)\)/);
  assert.doesNotMatch(profile, /xcrun_db/);
  for (const path of [tempDir, cwd]) {
    assert.match(profile, new RegExp(`\\(allow network\\* \\(local unix-socket \\(subpath "${path.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"\\)\\)\\)`));
    assert.match(profile, new RegExp(`\\(allow network\\* \\(remote unix-socket \\(subpath "${path.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"\\)\\)\\)`));
  }
  assert.match(profile, /\(allow network\* \(local ip "localhost:\*"\)\)/);
  assert.match(profile, /\(allow network\* \(remote ip "localhost:\*"\)\)/);
  for (const port of [4747, 4748, 4749, 4750]) assert.match(profile, new RegExp(`\\(deny network-outbound \\(remote ip "localhost:${port}"\\)\\)`));
  assert.ok(profile.includes(`(deny network-outbound (remote unix-socket (subpath "${daemonSocket}")))`));
  const tempRead = profile.indexOf(`(allow file-read* (subpath "${tempDir}"))`);
  const homeDeny = profile.indexOf(`(deny file-read* (subpath "${home}"))`);
  assert.ok(tempRead >= 0 && homeDeny >= 0 && homeDeny < tempRead, 'HOME deny must precede disposable temp HOME re-allow');
  assert.deepEqual(minimalGateEnv('/private/tmp/helm-gate-123/home', tempDir, '/Library/Developer/CommandLineTools/usr/bin'), {
    PATH: ['/Library/Developer/CommandLineTools/usr/bin', process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(delimiter),
    HOME: '/private/tmp/helm-gate-123/home',
    LANG: process.env.LANG ?? 'C',
    TMPDIR: tempDir,
    HELM_GATE_SANDBOXED: '1',
    CI: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'gc.auto',
    GIT_CONFIG_VALUE_0: '0',
    GIT_CONFIG_KEY_1: 'maintenance.auto',
    GIT_CONFIG_VALUE_1: 'false',
  });
});

test('gate environments prefer the resolved real git directory', async () => {
  const gitDir = await resolveDarwinGitDir();
  const env = minimalGateEnv('/private/tmp/helm-gate-123/home', '/private/tmp/helm-gate-123', gitDir);
  if (process.platform === 'darwin') {
    assert.ok(gitDir);
    assert.equal(env.PATH?.split(delimiter)[0], gitDir);
  } else {
    assert.equal(env.PATH, process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin');
  }
});

test('install profiles retain unrestricted network access', () => {
  const profile = buildSandboxProfile({
    cwd: '/Users/tester/.helm/worktrees/project/w-123',
    tempDir: '/private/tmp/helm-gate-123',
    operatorHomes: ['/Users/tester'],
    allowNetwork: true,
  });

  assert.match(profile, /^\(allow network\*\)$/m);
  assert.doesNotMatch(profile, /\(allow network\* \(/);
  assert.doesNotMatch(profile, /\(deny network-outbound /);
});

test('operatorHome adds a fixture to the real operator HOME deny list', () => {
  const fixtureHome = '/private/tmp/helm-gate-fixture-home';
  assert.deepEqual(operatorHomePaths(fixtureHome), [homedir(), fixtureHome]);
  assert.deepEqual(operatorHomePaths(), [homedir()]);
});

test('git sandbox directories come from git rev-parse', async () => {
  const root = fixture('helm-gate-git-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const expected = [...new Set(
      execFileSync('git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'], { cwd: root, encoding: 'utf8' })
        .trim().split(/\r?\n/).map((path) => realpathSync(path.startsWith('/') ? path : join(root, path))),
    )].sort();
    assert.deepEqual((await worktreeGitDirs(root)).sort(), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate refuses an escaping node_modules symlink without touching its target', async () => {
  const root = fixture('helm-gate-symlink-');
  const worktree = join(root, 'worktree');
  const outside = join(root, 'operator-node-modules');
  const link = join(worktree, 'node_modules');
  const sentinel = join(outside, 'sentinel.txt');
  const logDir = join(root, 'logs');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(sentinel, 'untouched');
  symlinkSync(outside, link, 'dir');
  const reasons: string[] = [];
  try {
    const result = await gateRunner({ allowUnsandboxed: true }).run(worktree, [{ name: 'must-not-run', command: 'exit 0' }], logDir, { sandbox: false, onRefused: (reason) => reasons.push(reason) });
    assert.equal(result.passed, false);
    assert.deepEqual(reasons, [`worktree contains a symlink escaping the worktree: ${link}`]);
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched');
    assert.equal(existsSync(link), false);
    assert.match(readFileSync(join(logDir, 'gate-refused.log'), 'utf8'), /unlinked escaping node_modules symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real macOS sandbox permits metadata traversal under a protected fake HOME', macOnly, async () => {
  const root = fixture('helm-gate-home-metadata-');
  const fakeHome = join(root, 'fake-home');
  const worktree = join(fakeHome, 'project', 'worktree');
  const toolchain = join(fakeHome, '.nvm', 'versions', 'node', 'v-test', 'bin');
  const secret = join(fakeHome, 'sibling-secret');
  const logDir = join(root, 'logs');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(toolchain, { recursive: true });
  writeFileSync(secret, 'must-not-read');
  symlinkSync(process.execPath, join(toolchain, 'node'));
  const previousPath = process.env.PATH;
  process.env.PATH = `${toolchain}${delimiter}${previousPath ?? ''}`;
  try {
    const result = await gateRunner({ operatorHome: fakeHome }).run(worktree, [
      { name: 'realpath', command: 'node -e "require(\'fs\').realpathSync(\'.\')"' },
      { name: 'sibling-secret', command: `cat ${JSON.stringify(secret)}` },
    ], logDir, { timeoutMs: 10_000 });
    assert.equal(result.passed, false);
    assert.equal(result.checks[0]?.exitCode, 0);
    assert.notEqual(result.checks[1]?.exitCode, 0);
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate cannot read the temporary HOME credential fixture or write outside the worktree', macOnly, async () => {
  const root = fixture('helm-gate-sandbox-');
  const operatorHome = join(root, 'operator-home');
  const worktree = join(root, 'worktree');
  const logDir = join(root, 'logs');
  const secret = join(operatorHome, 'code', 'other', '.env.local');
  const outside = join(root, 'outside.txt');
  mkdirSync(join(operatorHome, 'code', 'other'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(secret, 'HELM_SECRET=must-not-escape');
  try {
    const runner = gateRunner({ operatorHome });
    const result = await runner.run(worktree, [
      { name: 'credential-read', command: `cat ${JSON.stringify(secret)}` },
      { name: 'outside-write', command: `node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(outside)}, 'nope')`)}` },
    ], logDir);
    assert.equal(result.passed, false);
    assert.notEqual(result.checks[0]?.exitCode, 0);
    assert.match(readFileSync(result.checks[0]!.outputPath, 'utf8'), /Operation not permitted|operation not permitted|Permission denied|permission denied/);
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test steps have no network, while npm ci steps are profiled for network', macOnly, async () => {
  const root = fixture('helm-gate-network-');
  const worktree = join(root, 'worktree');
  mkdirSync(worktree, { recursive: true });
  try {
    const result = await gateRunner().run(worktree, [
      { name: 'test', command: 'curl --max-time 2 https://example.com' },
      { name: 'install', command: 'npm ci --ignore-scripts --no-audit --no-fund' },
    ], join(root, 'logs'), { timeoutMs: 10_000 });
    assert.equal(result.passed, false);
    assert.notEqual(result.checks[0]?.exitCode, 0);
    assert.notEqual(result.checks[1]?.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real macOS smoke applies the profile to cat, curl, and an in-worktree node write', macOnly, async () => {
  const root = fixture('helm-gate-smoke-');
  const worktree = join(root, 'worktree');
  const secret = join(root, '.config', 'helm', 'env');
  const output = join(worktree, 'ok.txt');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(root, '.config', 'helm'), { recursive: true });
  writeFileSync(secret, 'smoke-secret');
  try {
    const result = await gateRunner({ operatorHome: root }).run(worktree, [
      { name: 'cat-secret', command: `cat ${JSON.stringify(secret)}` },
      { name: 'curl-network', command: 'curl --max-time 2 https://example.com' },
      { name: 'worktree-write', command: `node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(output)}, 'ok')`)}` },
    ], join(root, 'logs'), { timeoutMs: 10_000 });
    assert.equal(result.passed, false);
    assert.notEqual(result.checks[0]?.exitCode, 0);
    assert.notEqual(result.checks[1]?.exitCode, 0);
    assert.equal(result.checks[2]?.exitCode, 0);
    assert.equal(readFileSync(output, 'utf8'), 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real macOS offline sandbox permits scoped IPC and loopback only', macOnly, async () => {
  const root = fixture('helm-gate-socket-');
  const worktree = join(root, 'worktree');
  const outsideSocket = join(root, 'outside.sock');
  const logDir = join(root, 'logs');
  mkdirSync(worktree, { recursive: true });

  const outsideServer = await new Promise<Server>((resolve, reject) => {
    const server = createServer((socket) => socket.end('outside'));
    server.once('error', reject);
    server.listen(outsideSocket, () => resolve(server));
  });
  const deniedPortServer = await new Promise<Server>((resolve, reject) => {
    const server = createServer((socket) => socket.end('denied-port'));
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const deniedPortAddress = deniedPortServer.address();
  assert.ok(deniedPortAddress && typeof deniedPortAddress === 'object');
  const deniedPort = deniedPortAddress.port;

  const unixScript = [
    "const net = require('node:net');",
    "const socketPath = require('node:path').join(process.env.TMPDIR, 'inside.sock');",
    "const server = net.createServer((socket) => socket.end('ok'));",
    "server.on('error', (error) => { console.error(error); process.exit(1); });",
    "server.listen(socketPath, () => {",
    "  const client = net.createConnection(socketPath); let data = '';",
    "  client.on('data', (chunk) => { data += chunk; });",
    "  client.on('error', (error) => { console.error(error); process.exit(1); });",
    "  client.on('end', () => { server.close(() => process.exit(data === 'ok' ? 0 : 1)); });",
    "});",
  ].join(' ');
  const loopbackScript = [
    "const net = require('node:net');",
    "const server = net.createServer((socket) => socket.end('ok'));",
    "server.on('error', (error) => { console.error(error); process.exit(1); });",
    "server.listen(0, '127.0.0.1', () => {",
    "  const port = server.address().port; const client = net.createConnection({ host: '127.0.0.1', port }); let data = '';",
    "  client.on('data', (chunk) => { data += chunk; });",
    "  client.on('error', (error) => { console.error(error); process.exit(1); });",
    "  client.on('end', () => { server.close(() => process.exit(data === 'ok' ? 0 : 1)); });",
    "});",
  ].join(' ');
  const blockedUnixScript = [
    `const client = require('node:net').createConnection(${JSON.stringify(outsideSocket)});`,
    "client.on('connect', () => process.exit(1));",
    "client.on('error', () => process.exit(0));",
    "client.setTimeout(1000, () => process.exit(0));",
  ].join(' ');
  const blockedPortScript = [
    `const client = require('node:net').createConnection({ host: '127.0.0.1', port: ${deniedPort} });`,
    "client.on('connect', () => process.exit(1));",
    "client.on('error', () => process.exit(0));",
    "client.setTimeout(1000, () => process.exit(0));",
  ].join(' ');

  try {
    const result = await gateRunner({ denyLocalPorts: [deniedPort] }).run(worktree, [
      { name: 'temp-unix', command: `node -e ${JSON.stringify(unixScript)}` },
      { name: 'loopback', command: `node -e ${JSON.stringify(loopbackScript)}` },
      { name: 'denied-loopback', command: `node -e ${JSON.stringify(blockedPortScript)}` },
      { name: 'external-network', command: 'curl --max-time 2 --silent --show-error https://example.com >/dev/null' },
      { name: 'outside-unix', command: `node -e ${JSON.stringify(blockedUnixScript)}` },
    ], logDir, { timeoutMs: 10_000 });
    assert.equal(result.passed, false);
    assert.equal(result.checks[0]?.exitCode, 0, readFileSync(result.checks[0]!.outputPath, 'utf8'));
    assert.equal(result.checks[1]?.exitCode, 0, readFileSync(result.checks[1]!.outputPath, 'utf8'));
    assert.equal(result.checks[2]?.exitCode, 0, readFileSync(result.checks[2]!.outputPath, 'utf8'));
    assert.notEqual(result.checks[3]?.exitCode, 0, readFileSync(result.checks[3]!.outputPath, 'utf8'));
    assert.equal(result.checks[4]?.exitCode, 0, readFileSync(result.checks[4]!.outputPath, 'utf8'));
  } finally {
    await new Promise<void>((resolve) => outsideServer.close(() => resolve()));
    await new Promise<void>((resolve) => deniedPortServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon metadata denial follows all read exceptions, including custom HELM_HOME', () => {
  const daemonHome = '/private/tmp/custom-helm';
  const profile = buildSandboxProfile({ cwd: daemonHome, tempDir: '/private/tmp/gate', operatorHomes: [], daemonHomes: [daemonHome], toolchainPaths: [daemonHome], npmCachePaths: [daemonHome], allowNetwork: true });
  const deny = `(deny file-read* (literal "${daemonHome}/serve.json"))`;
  assert.ok(profile.includes(deny));
  assert.ok(profile.indexOf(deny) > profile.lastIndexOf('(allow file-read*'));
  assert.equal(minimalGateEnv('/private/tmp/home', '/private/tmp/gate').HELM_HOME, undefined);
  assert.equal(minimalGateEnv('/private/tmp/home', '/private/tmp/gate').HELM_TOKEN, undefined);
});

test('native gate cannot read daemon metadata even through a symlink in its worktree', macOnly, async () => {
  const root = realpathSync(fixture('helm-auth-sandbox-'));
  const home = join(root, 'daemon');
  const cwd = join(root, 'worktree');
  mkdirSync(home); mkdirSync(cwd);
  writeFileSync(join(home, 'serve.json'), '{"token":"synthetic-secret"}', { mode: 0o600 });
  symlinkSync(join(home, 'serve.json'), join(cwd, 'metadata'));
  const profile = buildSandboxProfile({ cwd, tempDir: root, operatorHomes: [], daemonHomes: [home], allowNetwork: true });
  try {
    for (const path of [join(home, 'serve.json'), join(cwd, 'metadata')]) {
      assert.throws(() => execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', path], { stdio: 'pipe' }));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
