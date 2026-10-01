import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';

const exec = promisify(execFile);
const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/helm.js');
const secret = 'onboarding-secret-must-not-appear';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'helm-onboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'state'), repo = join(root, 'repo'), bin = join(root, 'bin'), agent = join(root, 'pi');
  await Promise.all([home, repo, bin, agent].map((p) => mkdir(p)));
  await exec('git', ['init', '-q', repo]);
  const script = async (name: string, body: string) => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };
  const codex = await script('codex', `case "$1" in\n --version) echo codex-test;;\n login) echo '${secret}' >&2;;\n debug) echo '{"models":[{"slug":"test-model"}]}';;\n *) exit 1;;\nesac`);
  const claude = await script('claude', `echo '${secret}'`);
  await script('gh', `echo '${secret}' >&2`);
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: root, HELM_HOME: home, HELM_CODEX_BIN: codex, HELM_CLAUDE_BIN: claude, PI_CODING_AGENT_DIR: agent };
  const config = { routing: { tiers: { 1: ['codex/test-model:medium'] } } };
  const cli = async (...args: string[]) => {
    try { const result = await exec(process.execPath, [launcher, ...args], { cwd: repo, env, timeout: 20_000 }); return { ...result, code: 0 }; }
    catch (e) { const err = e as { stdout: string; stderr: string; code: number }; return { stdout: err.stdout, stderr: err.stderr, code: err.code }; }
  };
  return { root, home, repo, bin, agent, env, config, cli, script };
}
test('doctor uses real node/git, emits JSON and leaves missing home/daemon untouched', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'helm.json'), JSON.stringify(f.config));
  const result = await f.cli('doctor', '--json');
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find((c: { name: string }) => c.name === 'node').status, 'ok');
  assert.equal(report.checks.find((c: { name: string }) => c.name === 'git').status, 'ok');
  assert.deepEqual(report.lanes, { codex: true, claude: true, pi: false });
  assert.deepEqual(report.tiers['1'].available, ['codex/test-model:medium']);
  assert.equal(report.nextCommand, 'helm serve --stdio');
  assert.ok(!result.stdout.includes(secret));
  assert.deepEqual(await readdir(f.home), ['helm.json']);
  assert.deepEqual(await readdir(f.agent), []);
  await rm(f.home, { recursive: true });
  const missing = await f.cli('doctor', '--json');
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).checks.find((c: { name: string }) => c.name === 'home').status, 'fail');
  await assert.rejects(readdir(f.home), { code: 'ENOENT' });
});
test('doctor fails invalid configuration, empty/unavailable tiers, policy exclusions and unauthenticated gh', async (t) => {
  const f = await fixture(t);
  const path = join(f.home, 'helm.json');
  await writeFile(path, `{"secret":"${secret}",broken`);
  let result = await f.cli('doctor', '--json');
  assert.equal(result.code, 1);
  assert.ok(!result.stdout.includes(secret));
  for (const routing of [{ tiers: {} }, { tiers: { 1: ['codex/missing'] } }, { tiers: { 1: ['codex/test-model'] }, policy: { lanes: ['pi'] } }]) {
    await writeFile(path, JSON.stringify({ routing }));
    result = await f.cli('doctor', '--json');
    assert.equal(result.code, 1);
  }
  await writeFile(path, JSON.stringify(f.config));
  await f.script('gh', `echo '${secret}' >&2; exit 1`);
  result = await f.cli('doctor');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /fail gh:/);
  assert.equal(result.stdout.split('\n').filter((s) => s.startsWith('next:')).length, 1);
  assert.ok(!result.stdout.includes(secret));
});
test('doctor finds Pi environment and stored keys without modifying provider files', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'helm.json'), JSON.stringify({ routing: { tiers: { 1: ['google/gemini-3.8-flash'] } } }));
  f.env.GEMINI_API_KEY = secret;
  let result = await f.cli('doctor', '--json');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).lanes.pi, true);
  assert.ok(!result.stdout.includes(secret));
  assert.deepEqual(await readdir(f.agent), []);
  delete f.env.GEMINI_API_KEY;
  const auth = JSON.stringify({ google: { type: 'api_key', key: secret } });
  await writeFile(join(f.agent, 'auth.json'), auth);
  result = await f.cli('doctor', '--json');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).lanes.pi, true);
  assert.ok(!result.stdout.includes(secret));
  assert.equal(await readFile(join(f.agent, 'auth.json'), 'utf8'), auth);
  assert.deepEqual(await readdir(f.agent), ['auth.json']);
});
test('doctor reports unavailable SQLite instead of loading the store', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'helm.json'), JSON.stringify(f.config));
  f.env.NODE_OPTIONS = '--no-experimental-sqlite';
  const result = await f.cli('doctor', '--json');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find((c: { name: string }) => c.name === 'node').status, 'fail');
});
test('doctor checks live pid and authenticated status without leaking tokens or response bodies', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'helm.json'), JSON.stringify(f.config));
  const token = 'a'.repeat(64);
  let authorized = false, reject = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    authorized = req.headers.authorization === `Bearer ${token}` && req.url === '/tools/daemon.control' && JSON.parse(body).action === 'status';
    res.statusCode = reject ? 401 : 200;
    res.end(JSON.stringify({ ok: !reject, secret, token }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const metadata = JSON.stringify({ pid: process.pid, port: address.port, token });
  await writeFile(join(f.home, 'serve.json'), metadata);
  let result = await f.cli('doctor', '--json');
  assert.equal(result.code, 0, result.stderr); assert.equal(authorized, true);
  assert.equal(JSON.parse(result.stdout).checks.find((c: { name: string }) => c.name === 'daemon-status').status, 'ok');
  reject = true; result = await f.cli('doctor', '--json'); assert.equal(result.code, 1);
  assert.ok(!result.stdout.includes(secret) && !result.stdout.includes(token));
  assert.equal(await readFile(join(f.home, 'serve.json'), 'utf8'), metadata);
  await writeFile(join(f.home, 'serve.json'), JSON.stringify({ pid: 2147483647, port: address.port, token }));
  result = await f.cli('doctor', '--json'); assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).checks.find((c: { name: string }) => c.name === 'daemon-pid').status, 'warn');
  assert.ok((await readdir(f.home)).includes('serve.json'));
});
test('doctor warns when ps finds multiple HTTP daemons with their ports and homes', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'helm.json'), JSON.stringify(f.config));
  await f.script('ps', "printf '%s\\n' ' 101 node --import tsx /opt/helm/src/cli.ts serve --http --port 4747 HELM_HOME=/tmp/helm-shared PATH=/bin' ' 202 node /opt/helm/bin/helm.js serve --http --port=4748 HELM_HOME=/tmp/helm-isolated PATH=/bin' ' 303 node /opt/helm/bin/helm.js serve --stdio --port 4749 HELM_HOME=/tmp/ignore' ' 404 node /opt/other/src/cli.ts serve --http --port 4749 HELM_HOME=/tmp/ignore'");
  const result = await f.cli('doctor', '--json');
  assert.equal(result.code, 0, result.stderr);
  const check = JSON.parse(result.stdout).checks.find((entry: { name: string }) => entry.name === 'daemon-processes');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /port 4747.*HELM_HOME=\/tmp\/helm-shared/);
  assert.match(check.detail, /port 4748.*HELM_HOME=\/tmp\/helm-isolated/);
  assert.doesNotMatch(check.detail, /4749/);
});
test('doctor reports the shared home and port defaults for HTTP daemons without overrides', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'helm.json'), JSON.stringify(f.config));
  await f.script('ps', "printf '%s\\n' ' 101 node /opt/helm/bin/helm.js serve --http' ' 202 node /opt/helm/bin/helm.js serve --http --port 4748 HELM_HOME=/tmp/helm-isolated'");
  const result = await f.cli('doctor', '--json');
  assert.equal(result.code, 0, result.stderr);
  const check = JSON.parse(result.stdout).checks.find((entry: { name: string }) => entry.name === 'daemon-processes');
  assert.match(check.detail, /port 4747 HELM_HOME=.*\.helm/);
  assert.match(check.detail, /port 4748 HELM_HOME=\/tmp\/helm-isolated/);
});
test('doctor preserves stale or malformed metadata and rejects non-writable home', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'helm.json'), JSON.stringify(f.config));
  for (const metadata of [JSON.stringify({ pid: 2147483647, port: 4747, token: secret }), `{"token":"${secret}",broken`]) {
    await writeFile(join(f.home, 'serve.json'), metadata);
    const result = await f.cli('doctor', '--json');
    const stale = metadata.startsWith('{"pid":');
    assert.equal(result.code, stale ? 0 : 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.find((c: { name: string }) => c.name === 'daemon-pid').status, stale ? 'warn' : 'fail');
    if (stale) {
      assert.equal(report.nextCommand, 'start the daemon: helm serve');
      assert.ok(!report.checks.some((c: { name: string }) => c.name === 'daemon-status'));
    }
    assert.ok(!result.stdout.includes(secret));
    assert.equal(await readFile(join(f.home, 'serve.json'), 'utf8'), metadata);
  }
  await chmod(f.home, 0o555);
  try {
    const result = await f.cli('doctor', '--json');
    assert.equal(JSON.parse(result.stdout).checks.find((c: { name: string }) => c.name === 'home').status, 'fail');
  } finally { await chmod(f.home, 0o755); }
});
test('doctor success hint shell-quotes the absolute target repo', async (t) => {
  const f = await fixture(t);
  const repo = join(f.root, "repo ' $cash $(echo unsafe)");
  await mkdir(repo); await exec('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'package.json'), '{"name":"hint-target"}');
  await writeFile(join(f.home, 'helm.json'), JSON.stringify(f.config));
  await writeFile(join(f.home, 'serve.json'), JSON.stringify({ pid: process.pid, port: 4747, token: secret }));
  const hook = join(f.root, 'doctor-status.mjs');
  await writeFile(hook, 'globalThis.fetch = async () => new Response(JSON.stringify({ok:true}));');
  f.env.NODE_OPTIONS = `--import=${hook}`;
  const result = await f.cli('doctor', '--repo', repo, '--json');
  assert.equal(result.code, 0, result.stderr);
  const hint = JSON.parse(result.stdout).nextCommand;
  assert.match(hint, /^helm spawn --repo '\//);
  const parsed = await exec('/bin/sh', ['-c', `helm() { printf '%s\\n' "$@"; }; ${hint}`], { cwd: dirname(launcher) });
  assert.deepEqual(parsed.stdout.trimEnd().split('\n'), ['spawn', '--repo', repo, '--objective', 'Describe your task']);
});
test('doctor enforces the package engine minimum Node 22.22.0', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'helm.json'), JSON.stringify(f.config));
  const hook = join(f.root, 'node-version.mjs');
  for (const [version, status] of [['21.99.0', 'fail'], ['22.0.0', 'fail'], ['22.21.9', 'fail'], ['22.22.0', 'ok'], ['22.23.0', 'ok'], ['23.0.0', 'ok']]) {
    await writeFile(hook, `Object.defineProperty(process.versions, 'node', {value:${JSON.stringify(version)}});`);
    f.env.NODE_OPTIONS = `--import=${hook}`;
    const result = await f.cli('doctor', '--json');
    assert.equal(result.code, status === 'ok' ? 0 : 1, result.stderr);
    const check = JSON.parse(result.stdout).checks.find((c: { name: string }) => c.name === 'node');
    assert.equal(check.status, status, version);
    assert.equal(check.detail, 'Node >= 22.22.0 with node:sqlite');
  }
});
test('init leaves repo config untouched when operator config creation fails', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'package.json'), '{"name":"write-failure","scripts":{"test":"node --test"}}');
  await chmod(f.home, 0o555);
  try {
    const result = await f.cli('init');
    assert.equal(result.code, 1); assert.match(result.stderr, /could not create operator helm.json/);
    await assert.rejects(readFile(join(f.repo, 'helm.json')), { code: 'ENOENT' });
    const original = '{"gates":[]}';
    await writeFile(join(f.repo, 'helm.json'), original);
    const forced = await f.cli('init', '--force');
    assert.equal(forced.code, 1); assert.equal(await readFile(join(f.repo, 'helm.json'), 'utf8'), original);
    const blocker = join(f.root, 'file'); await writeFile(blocker, 'not a directory');
    f.env.HELM_HOME = join(blocker, 'state');
    const mkdirFailure = await f.cli('init', '--force');
    assert.equal(mkdirFailure.code, 1); assert.match(mkdirFailure.stderr, /could not create operator helm.json/);
    assert.equal(await readFile(join(f.repo, 'helm.json'), 'utf8'), original);
  } finally { await chmod(f.home, 0o755); }
});
test('init guesses real package scripts, prints MCP, runs doctor and protects both configs', async (t) => {
  const f = await fixture(t);
  await rm(join(f.home), { recursive: true });
  await writeFile(join(f.repo, 'package.json'), JSON.stringify({ name: 'temp-repo', scripts: { test: 'node --test', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'echo build' } }));
  const result = await f.cli('init');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\.mcp.json snippet:/);
  assert.match(result.stdout, /"serve",\s*"--stdio"/);
  const snippet = result.stdout.match(/\.mcp\.json snippet:\n([\s\S]*?)\nok node:/)?.[1];
  assert.ok(snippet, result.stdout);
  const mcp = JSON.parse(snippet);
  assert.deepEqual(mcp, { mcpServers: { helm: { command: 'helm', args: ['serve', '--stdio'] } } });
  assert.equal(Object.hasOwn(mcp.mcpServers.helm, 'env'), false);
  assert.match(result.stdout, /ok node:/);
  const repoConfig = JSON.parse(await readFile(join(f.repo, 'helm.json'), 'utf8'));
  assert.deepEqual(repoConfig.gates, [{ name: 'install', command: 'npm install' }, ...['test', 'typecheck', 'lint'].map((name) => ({ name, command: `npm run ${name}` }))]);
  const operator = await readFile(join(f.home, 'helm.json'), 'utf8');
  assert.deepEqual(JSON.parse(operator), { spend: { capUsd: 5 }, routing: { policy: { subscriptionOnly: true } } });
  const refused = await f.cli('init'); assert.equal(refused.code, 1); assert.match(refused.stderr, /--force/);
  assert.deepEqual(JSON.parse(await readFile(join(f.repo, 'helm.json'), 'utf8')), repoConfig);
  await writeFile(join(f.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  assert.equal((await f.cli('init', '--force')).code, 0);
  assert.equal(JSON.parse(await readFile(join(f.repo, 'helm.json'), 'utf8')).gates.length, 2);
  assert.equal(await readFile(join(f.home, 'helm.json'), 'utf8'), operator);
  await assert.rejects(readFile(join(f.repo, '.mcp.json')), { code: 'ENOENT' });
});
test('init supports --repo, Swift/Xcode/TODO fallback and API-key operator policy', async (t) => {
  const f = await fixture(t);
  const target = join(f.root, 'target'); await mkdir(target);
  await writeFile(join(target, 'Package.swift'), '// real Swift marker');
  assert.equal((await f.cli('init', '--repo', target)).code, 0);
  assert.deepEqual(JSON.parse(await readFile(join(target, 'helm.json'), 'utf8')).gates, [{ name: 'swift', command: 'swift test' }]);
  await rm(join(target, 'Package.swift')); await mkdir(join(target, 'App.xcodeproj'));
  assert.equal((await f.cli('init', '--repo', target, '--force')).code, 0);
  let config = JSON.parse(await readFile(join(target, 'helm.json'), 'utf8'));
  assert.match(config.gates[0].command, /xcodebuild test/);
  await rm(join(target, 'App.xcodeproj'), { recursive: true });
  assert.equal((await f.cli('init', '--repo', target, '--force')).code, 0);
  config = JSON.parse(await readFile(join(target, 'helm.json'), 'utf8'));
  await assert.rejects(exec('/bin/sh', ['-c', config.gates[0].command]), { code: 1 });
  await rm(join(f.home, 'helm.json')); f.env.OPENROUTER_API_KEY = secret;
  const result = await f.cli('init', '--repo', target, '--force');
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(await readFile(join(f.home, 'helm.json'), 'utf8')).routing.policy.subscriptionOnly, false);
  assert.ok(!result.stdout.includes(secret));
});
test('doctor requires routing.allowed membership and treats an empty allowlist as unrestricted', async (t) => {
  const f = await fixture(t);
  for (const [allowed, code] of [[['codex/other'], 1], [['codex/test-model:medium'], 0], [[], 0]] as const) {
    await writeFile(join(f.home, 'helm.json'), JSON.stringify({ routing: { ...f.config.routing, allowed } }));
    const result = await f.cli('doctor', '--json');
    assert.equal(result.code, code, result.stdout + result.stderr);
    const tier = JSON.parse(result.stdout).tiers['1'];
    assert.deepEqual(tier.available, code === 0 ? ['codex/test-model:medium'] : []);
  }
});
test('doctor warns on empty or unavailable tiers and fails routing only without a usable fallback', async (t) => {
  const f = await fixture(t);
  for (const [usableTier, emptyTier] of [['1', '5'], ['5', '1']]) {
    await writeFile(join(f.home, 'helm.json'), JSON.stringify({ routing: {
      tiers: { [emptyTier!]: ['codex/missing'], [usableTier!]: ['codex/test-model:medium'], 3: [] },
    } }));
    const result = await f.cli('doctor', '--json');
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.find((c: { name: string }) => c.name === `tier ${emptyTier}`).status, 'warn');
    assert.equal(report.checks.find((c: { name: string }) => c.name === 'tier 3').status, 'warn');
    assert.equal(report.checks.find((c: { name: string }) => c.name === `tier ${usableTier}`).status, 'ok');
    assert.ok(!report.checks.some((c: { status: string }) => c.status === 'fail'));
  }
  await writeFile(join(f.home, 'helm.json'), JSON.stringify({ routing: {
    tiers: { 1: ['codex/missing'], 5: ['codex/test-model:medium'] }, allowed: ['codex/missing'],
  } }));
  const result = await f.cli('doctor', '--json');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find((c: { name: string }) => c.name === 'routing').status, 'fail');
  assert.ok(report.checks.filter((c: { name: string }) => c.name.startsWith('tier ')).every((c: { status: string }) => c.status === 'warn'));
});
test('doctor ignores tier keys outside the selector range 1-5', async (t) => {
  const f = await fixture(t);
  for (const tiers of [{ 0: ['codex/test-model:medium'], 6: ['codex/test-model:medium'] },
    { '01': ['codex/test-model:medium'], 1: ['codex/missing'], 7: ['codex/test-model:medium'] }]) {
    await writeFile(join(f.home, 'helm.json'), JSON.stringify({ routing: { tiers } }));
    const result = await f.cli('doctor', '--json');
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.find((c: { name: string }) => c.name === 'routing').status, 'fail');
    assert.ok(Object.keys(report.tiers).every((tier) => ['1', '2', '3', '4', '5'].includes(tier)));
  }
  await writeFile(join(f.home, 'helm.json'), JSON.stringify({ routing: { tiers: { 5: ['codex/test-model:medium'], 6: ['codex/missing'] } } }));
  const result = await f.cli('doctor', '--json');
  assert.equal(result.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout).tiers), ['5']);
});
test('init uses immutable installs for Yarn Berry and frozen lockfiles for classic Yarn', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(join(f.repo, 'yarn.lock'), '# fixture');
  for (const berry of [false, true]) {
    if (berry) await writeFile(join(f.repo, '.yarnrc.yml'), 'nodeLinker: node-modules');
    const result = await f.cli('init', '--force');
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(await readFile(join(f.repo, 'helm.json'), 'utf8'));
    assert.deepEqual(config.gates, [{ name: 'install', command: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile' }, { name: 'test', command: 'yarn run test' }]);
  }
});
test('serve bootstrap, daemon composition and spawned Codex workers do not retain tsx configuration', async (t) => {
  for (const inherited of [false, true]) {
    const f = await fixture(t);
    const startupRecord = join(f.root, 'startup.json'), daemonRecord = join(f.root, 'daemon.json'), workerRecord = join(f.root, 'worker.json');
    const codex = join(f.root, 'env-codex.mjs');
    await writeFile(codex, `#!${process.execPath}
      import { readFileSync, writeFileSync } from 'node:fs';
      readFileSync(0, 'utf8');
      writeFileSync(${JSON.stringify(workerRecord)}, JSON.stringify({ hasTsconfig: Object.hasOwn(process.env, 'TSX_TSCONFIG_PATH') }));
      const args = process.argv.slice(2);
      writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({ status: 'succeeded', summary: 'environment fixture', changedFiles: [], commandsRun: [] }));`);
    await chmod(codex, 0o755);
    const hook = join(f.root, 'serve-env-probe.mjs');
    const runnerUrl = new URL('../src/codex.ts', import.meta.url).href;
    await writeFile(hook, `import { Server } from 'node:http';
      import { writeFileSync } from 'node:fs';
      if (process.argv[1]?.endsWith('/src/cli.ts') && process.argv[2] === 'serve') {
        writeFileSync(${JSON.stringify(startupRecord)}, JSON.stringify({ hasTsconfig: Object.hasOwn(process.env, 'TSX_TSCONFIG_PATH') }));
        // Observe the real serve composition before binding a socket; no TCP is needed.
        Server.prototype.listen = function () {
          Promise.resolve().then(async () => {
            writeFileSync(${JSON.stringify(daemonRecord)}, JSON.stringify({ hasTsconfig: Object.hasOwn(process.env, 'TSX_TSCONFIG_PATH') }));
            const { codexWorkerRunner } = await import(${JSON.stringify(runnerUrl)});
            const outcome = await codexWorkerRunner({ bin: ${JSON.stringify(codex)} }).run({
              workerId: 'env-fixture', role: 'builder', model: 'codex/test-model',
              worktree: ${JSON.stringify(f.repo)}, sessionDir: ${JSON.stringify(join(f.root, 'sessions'))},
              objective: 'environment fixture', acceptance: null, contextPaths: [], allowWorkflows: false, sessionFile: null,
            }, 'environment fixture', { emit() {}, onUsage() {}, onSession() {}, shouldContinue() { return true; } });
            if (outcome.result?.status !== 'succeeded') throw new Error('worker fixture failed');
            process.exit(0);
          }).catch((error) => { console.error(error); process.exit(1); });
          return this;
        };
      }`);
    f.env.NODE_OPTIONS = `--import=${hook}`;
    if (inherited) f.env.TSX_TSCONFIG_PATH = resolve(dirname(launcher), '../tsconfig.json');
    const result = await f.cli('serve', '--http');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(startupRecord, 'utf8')), { hasTsconfig: inherited });
    assert.deepEqual(JSON.parse(await readFile(daemonRecord, 'utf8')), { hasTsconfig: false });
    assert.deepEqual(JSON.parse(await readFile(workerRecord, 'utf8')), { hasTsconfig: false });
  }
});
test('launcher uses Helm tsconfig/cwd while preserving default and relative target repos', async (t) => {
  const f = await fixture(t);
  const hostile = join(f.repo, 'tsconfig.json');
  await writeFile(hostile, '{not valid tsconfig');
  f.env.TSX_TSCONFIG_PATH = hostile;
  await writeFile(join(f.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(join(f.home, 'helm.json'), JSON.stringify(f.config));
  const created = await f.cli('init');
  assert.equal(created.code, 0, created.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(f.repo, 'helm.json'), 'utf8')).gates, [
    { name: 'install', command: 'npm install' }, { name: 'test', command: 'npm run test' },
  ]);
  assert.equal((await f.cli('doctor', '--json')).code, 0);
  const nested = join(f.repo, 'nested repo');
  await mkdir(nested); await writeFile(join(nested, 'Package.swift'), '// fixture');
  assert.equal((await f.cli('init', '--repo', 'nested repo')).code, 0);
  assert.deepEqual(JSON.parse(await readFile(join(nested, 'helm.json'), 'utf8')).gates, [{ name: 'swift', command: 'swift test' }]);
  assert.equal((await f.cli('init', '--repo=nested repo', '--force')).code, 0);
  await writeFile(join(nested, 'helm.json'), 'invalid');
  const explicit = await f.cli('doctor', '--repo=nested repo', '--json');
  assert.equal(explicit.code, 1);
  assert.equal(JSON.parse(explicit.stdout).checks.find((c: { name: string }) => c.name === 'repo-config').status, 'fail');
  assert.equal((await f.cli('doctor', '--json')).code, 0);
  await writeFile(join(f.repo, 'helm.json'), 'invalid');
  const current = await f.cli('doctor', '--json');
  assert.equal(current.code, 1);
  assert.equal(JSON.parse(current.stdout).checks.find((c: { name: string }) => c.name === 'repo-config').status, 'fail');
});
test('init selects the lockfile package manager for install and script gates', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc', lint: 'eslint .' } }));
  for (const [lockfile, manager, command] of [
    ['package-lock.json', 'npm', 'npm ci'],
    ['pnpm-lock.yaml', 'pnpm', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn', 'yarn install --frozen-lockfile'],
    ['', 'npm', 'npm install'],
  ]) {
    if (lockfile) await writeFile(join(f.repo, lockfile), 'fixture lockfile');
    const result = await f.cli('init', '--force');
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(await readFile(join(f.repo, 'helm.json'), 'utf8'));
    assert.deepEqual(config.gates, [{ name: 'install', command }, ...['test', 'typecheck', 'lint'].map((name) => ({ name, command: `${manager} run ${name}` }))]);
    if (lockfile) await rm(join(f.repo, lockfile));
  }
});
test('init ignores tool/subscription tokens and recognizes model-provider API keys', async (t) => {
  const f = await fixture(t);
  const operator = join(f.home, 'helm.json');
  const excluded = ['NPM_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'OTHER_API_KEY'];
  for (const name of excluded) f.env[name] = secret;
  let result = await f.cli('init');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(operator, 'utf8')).routing.policy.subscriptionOnly, true);
  for (const name of excluded) delete f.env[name];
  for (const name of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'HF_TOKEN']) {
    await rm(operator); f.env[name] = secret;
    result = await f.cli('init', '--force');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(operator, 'utf8')).routing.policy.subscriptionOnly, false, name);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    delete f.env[name];
  }
});
test('init reports specific path/package errors without writing configuration or printing input', async (t) => {
  const f = await fixture(t);
  const missing = await f.cli('init', '--repo', join(f.root, 'absent'));
  assert.equal(missing.code, 1); assert.match(missing.stderr, /invalid --repo path/);
  const path = join(f.repo, 'package.json');
  await writeFile(path, `{"secret":"${secret}",broken`);
  const notDirectory = await f.cli('init', '--repo', path);
  assert.equal(notDirectory.code, 1); assert.match(notDirectory.stderr, /invalid --repo path/);
  for (const value of [`{"secret":"${secret}",broken`, 'null', '[]', '{"scripts":42}']) {
    await writeFile(path, value);
    const result = await f.cli('init');
    assert.equal(result.code, 1); assert.match(result.stderr, /invalid package.json/);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    await assert.rejects(readFile(join(f.repo, 'helm.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(f.home, 'helm.json')), { code: 'ENOENT' });
  }
});
test('init exits zero after writing files even when doctor fails', async (t) => {
  const f = await fixture(t);
  await f.script('gh', 'exit 1');
  const result = await f.cli('init');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fail gh:/);
  assert.match(result.stdout, /Files written\. Follow the doctor next steps/);
  assert.match(result.stdout, /next: gh auth login/);
  assert.ok(await readFile(join(f.repo, 'helm.json')));
  assert.ok(await readFile(join(f.home, 'helm.json')));
  assert.equal((await f.cli('doctor', '--json')).code, 1);
});
test('other launcher commands do not load onboarding', async (t) => {
  const f = await fixture(t);
  const hook = join(f.root, 'forbid-onboarding.mjs');
  await writeFile(hook, `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/onboard\\.(ts|js)$/.test(specifier)) throw new Error('onboarding module loaded');
      return next(specifier, context);
    } });`);
  f.env.NODE_OPTIONS = `--import=${hook}`;
  const result = await f.cli('--version');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  const listed = await f.cli('ps', '--json');
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), []);
  const blocked = await f.cli('doctor', '--json');
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /onboarding module loaded/);
});
