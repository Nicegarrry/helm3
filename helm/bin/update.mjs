// Standalone release installer: it must survive the daemon whose code it is replacing.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, readlinkSync, readdirSync, statSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const script = fileURLToPath(import.meta.url);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, data) => {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  renameSync(temp, path);
};
export function digestRelease(root) {
  const hash = createHash('sha256');
  const visit = (dir, relative = '', parents = new Set()) => {
    const canonical = realpathSync(dir);
    if (parents.has(canonical)) throw new Error(`release contains a symlink cycle: ${relative}`);
    const ancestors = new Set([...parents, canonical]);
    hash.update(`directory:${relative}\0`);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name), name = join(relative, entry.name);
      if (entry.isSymbolicLink()) hash.update(`link:${name}\0${readlinkSync(path)}\0`);
      const info = statSync(path);
      if (info.isDirectory()) visit(path, name, ancestors);
      else if (info.isFile()) { const data = readFileSync(path); hash.update(`file:${name}\0${data.length}\0`); hash.update(data); }
      else throw new Error(`release contains unsupported entry: ${name}`);
    }
  };
  visit(root);
  return hash.digest('hex');
}

export async function control(port, input) {
  const res = await fetch(`http://127.0.0.1:${port}/tools/daemon.control`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
  });
  const result = await res.json();
  if (!result.ok || result.protocol !== 1) throw new Error(result.reason ?? 'daemon has no safe upgrade protocol; arrange a quiet-window installation');
  return result;
}

export function stageRelease(home, repo, ref, validate = validateRelease) {
  mkdirSync(home, { recursive: true });
  const id = randomUUID();
  const lock = join(home, 'upgrade.lock');
  mkdirSync(lock);
  try {
    write(join(lock, 'owner.json'), { id, pid: process.pid, operation: 'stage' });
    return stageLocked(home, repo, ref, validate);
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
function releaseLock(home, id) {
  const lock = join(home, 'upgrade.lock');
  if (existsSync(join(lock, 'owner.json')) && read(join(lock, 'owner.json')).id === id) rmSync(lock, { recursive: true });
}
function validateRelease(root, env) {
  execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: root, env, stdio: 'inherit' });
  for (const command of ['typecheck', 'test']) execFileSync('npm', ['run', command], { cwd: join(root, 'helm'), env, stdio: 'inherit' });
}
function stageLocked(home, repo, ref, validate) {
  const revision = execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const releases = join(home, 'releases');
  mkdirSync(releases, { recursive: true });
  const root = mkdtempSync(join(releases, 'staging-'));
  const scratch = mkdtempSync(join(tmpdir(), 'helm-stage-'));
  try {
    const archive = join(scratch, 'source.tar');
    execFileSync('git', ['-C', repo, 'archive', '--format=tar', '-o', archive, revision]);
    execFileSync('tar', ['-xf', archive, '-C', root]);
    const pkg = read(join(root, 'helm', 'package.json'));
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('invalid release version');
    if (!existsSync(join(root, 'helm', 'src', 'lifecycle.ts'))) throw new Error('target release lacks safe upgrade support');
    write(join(root, 'helm', 'release.json'), { revision, version: pkg.version });
    const env = { ...process.env, HELM_HOME: join(scratch, 'test-home'), HELM_UPGRADE_ID: '' };
    validate(root, env);
    const destination = join(releases, `${pkg.version}-${revision.slice(0, 12)}-${randomUUID().slice(0, 8)}`);
    renameSync(root, destination);
    const staged = { root: destination, version: pkg.version, revision, digest: digestRelease(destination) };
    write(join(home, 'staged-release.json'), staged);
    return staged;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function launchUpgrade(home, port, source, timeoutMs) {
  const staged = read(join(home, 'staged-release.json'));
  const lock = join(home, 'upgrade.lock');
  const id = randomUUID();
  mkdirSync(lock);
  let log, child;
  try {
    write(join(lock, 'owner.json'), { id, pid: process.pid, operation: 'apply' });
    log = openSync(join(home, 'upgrade.log'), 'a');
    child = spawn(process.execPath, [script, 'apply', home, id], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, HELM_HOME: home } });
    child.on('error', (err) => {
      try { write(join(home, 'upgrade.json'), { id, phase: 'failed', error: err.message }); }
      catch (failure) { console.error(failure); }
      try { releaseLock(home, id); } catch (failure) { console.error(failure); }
    });
    write(join(lock, 'owner.json'), { id, pid: child.pid, operation: 'apply' });
    write(join(home, 'upgrade.json'), { id, helperPid: child.pid, phase: 'draining', source: { bootId: source.bootId }, port, staged, timeoutMs });
    child.unref();
  } catch (err) {
    if (child?.pid) child.kill('SIGTERM'); // Only the helper created here, before handover ownership was published.
    rmSync(lock, { recursive: true, force: true });
    throw err;
  } finally { if (log !== undefined) closeSync(log); }
}

export async function applyUpgrade(home, id) {
  const journal = join(home, 'upgrade.json');
  let job;
  for (let i = 0; i < 100; i++) {
    job = existsSync(journal) ? read(journal) : null;
    if (job?.id === id && job.helperPid === process.pid) break;
    await sleep(50);
  }
  if (job?.id !== id || job.helperPid !== process.pid) throw new Error('upgrade ownership was not established');
  const save = (phase, extra = {}) => { job = { ...job, phase, ...extra }; write(journal, job); };
  let stopped = false;
  try {
    if (digestRelease(job.staged.root) !== job.staged.digest) throw new Error('staged release changed after validation');
    let status = await control(job.port, { action: 'status' });
    if (status.bootId !== job.source.bootId) throw new Error('daemon identity changed; refusing handover');
    status = await control(job.port, { action: 'drain', expectedBootId: job.source.bootId });
    const deadline = Date.now() + job.timeoutMs;
    while (status.phase !== 'ready') {
      if (Date.now() >= deadline) { save('timed_out', { blockers: status.blockers }); return; }
      await sleep(200);
      status = await control(job.port, { action: 'status' });
      if (status.bootId !== job.source.bootId) throw new Error('daemon identity changed while draining');
    }
    if (digestRelease(job.staged.root) !== job.staged.digest) throw new Error('staged release changed while draining');
    save('stopping', { handoverStarted: true });
    stopped = true; // An interrupted response does not prove shutdown was absent.
    await control(job.port, { action: 'shutdown', expectedBootId: job.source.bootId });
    // The old process releases its ownership lock only after closing HTTP and SQLite.
    for (let i = 0; existsSync(join(home, 'daemon.lock')); i++) {
      if (i >= 150) throw new Error('old daemon has not released ownership; no new daemon started');
      await sleep(100);
    }
    save('starting');
    const cli = join(job.staged.root, 'helm', 'src', 'cli.ts');
    const log = openSync(join(home, 'daemon.log'), 'a');
    let startError;
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'serve', '--http', '--port', String(job.port)], {
      cwd: join(job.staged.root, 'helm'), detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, HELM_HOME: home, HELM_UPGRADE_ID: id },
    });
    closeSync(log);
    child.on('error', (err) => { startError = err; });
    child.unref();
    for (let i = 0; i < 150; i++) {
      if (startError || child.exitCode !== null) throw startError ?? new Error(`new daemon exited ${child.exitCode}`);
      try { status = await control(job.port, { action: 'status' }); } catch { status = null; }
      if (status?.pid === child.pid && status.version === job.staged.version && status.revision === job.staged.revision && status.phase === 'ready') break;
      if (i === 149) throw new Error('new daemon health/identity check failed; admissions remain closed');
      await sleep(100);
    }
    write(join(home, 'current-release.json'), job.staged);
    save('healthy');
    await control(job.port, { action: 'resume', upgradeId: id, expectedBootId: status.bootId });
    save('completed');
  } catch (err) { save('failed', { error: `${err.message}${stopped ? '; inspect daemon.log before manual recovery' : '; old daemon left running'}` }); }
  finally { releaseLock(home, id); }
}

async function main(args) {
  if (args[0] === 'apply') return applyUpgrade(args[1], args[2]);
  const { values } = parseArgs({ args, options: { stage: { type: 'string' }, repo: { type: 'string' }, 'when-idle': { type: 'boolean' }, timeout: { type: 'string' } } });
  if (values.stage && values['when-idle']) throw new Error('stage and apply are separate commands');
  const home = resolve(process.env.HELM_HOME || join(homedir(), '.helm'));
  if (values.stage) { console.log(JSON.stringify(stageRelease(home, resolve(values.repo ?? process.cwd()), values.stage), null, 2)); return; }
  if (!values['when-idle']) throw new Error('usage: helm update --stage <git-ref> [--repo path] | --when-idle [--timeout ms]');
  const live = read(join(home, 'serve.json'));
  console.log(JSON.stringify(await control(live.port, { action: 'upgrade', timeoutMs: Number(values.timeout ?? 600000) }), null, 2));
}
if (process.argv[1] && realpathSync(process.argv[1]) === script) main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1; });
