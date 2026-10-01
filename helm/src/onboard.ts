/** Local onboarding. Diagnostics never create state or start a daemon. */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { findEnvKeys, getProviders } from '@earendil-works/pi-ai/compat';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadConfig } from './config.js';
import { defaultCodexBin } from './codex.js';
import { defaultClaudeBin } from './claude.js';
import { readSettingsFile } from './settings.js';
import { createModelCatalog, parseCodexModelSlugs } from './routing/catalog.js';
import { appliedPolicy } from './routing/policy.js';
import { candidateUnavailableReason } from './routing/select.js';
import { repoConfigSchema } from './repoconfig.js';
type Check = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; next: string };
const exec = promisify(execFile);
const apiKeysPresent = () => Boolean(process.env.GOOGLE_API_KEY?.trim()) || getProviders().some((provider) =>
  findEnvKeys(provider)?.some((key) => (key.endsWith('_API_KEY') || key === 'HF_TOKEN') && Boolean(process.env[key]?.trim())));
export class OnboardingError extends Error {}
const jsonFile = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('invalid JSON file'); } };
export async function doctor(repo = process.cwd()) {
  const home = loadConfig().home, checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string, next: string) => checks.push({ name, status, detail, next });
  const probe = async (file: string, args: string[]) => { try { return (await exec(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout; } catch { return undefined; } };
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  add('node', (major > 22 || major === 22 && minor >= 22) && await probe(process.execPath, ['-e', "require('node:sqlite')"]) !== undefined ? 'ok' : 'fail', 'Node >= 22.22.0 with node:sqlite', 'nvm install 22.22.0');
  add('git', await probe('git', ['--version']) !== undefined ? 'ok' : 'fail', 'git available', 'brew install git');
  add('gh', await probe('gh', ['auth', 'status']) !== undefined ? 'ok' : 'fail', 'GitHub authentication', 'gh auth login');
  try { if (!statSync(home).isDirectory()) throw new Error(); accessSync(home, constants.W_OK); add('home', 'ok', 'HELM_HOME exists and is writable', 'helm doctor'); }
  catch { add('home', 'fail', 'HELM_HOME missing or not writable', 'helm init'); }
  const codexBin = defaultCodexBin(), claudeBin = defaultClaudeBin();
  const codexPresent = await probe(codexBin, ['--version']) !== undefined;
  const codex = codexPresent && await probe(codexBin, ['login', 'status']) !== undefined;
  const claude = await probe(claudeBin, ['--version']) !== undefined;
  let piModels: string[] = [];
  try {
    const auth = existsSync(join(getAgentDir(), 'auth.json')) ? jsonFile(join(getAgentDir(), 'auth.json')) : {};
    // In-memory, non-resolving credentials prevent locks, token refresh and auth-file writes.
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error('read only'); }, delete: async () => { throw new Error('read only'); } } });
    piModels = runtime.getModels().filter((m) => findEnvKeys(m.provider)?.length || runtime.getProviderAuthStatus(m.provider).configured || (auth?.[m.provider]?.type === 'api_key' && auth[m.provider].key) || (auth?.[m.provider]?.type === 'oauth' && auth[m.provider].refresh)).map((m) => `${m.provider}/${m.id}`);
  } catch { /* unavailable configuration stays unavailable */ }
  const lanes = { codex, claude, pi: piModels.length > 0 };
  add('codex', codex ? 'ok' : 'warn', codexPresent ? 'CLI present; login checked' : 'CLI unavailable', codexPresent ? 'codex login' : 'npm install -g @openai/codex');
  add('claude', claude ? 'ok' : 'warn', claude ? 'CLI present' : 'CLI unavailable', 'npm install -g @anthropic-ai/claude-code');
  add('pi', lanes.pi ? 'ok' : 'warn', lanes.pi ? 'configured provider credentials found' : 'no configured provider credentials', 'pi login');
  const file = readSettingsFile(home), settings = file.settings;
  add('config', file.error ? 'fail' : file.signature === 'missing' ? 'warn' : 'ok', file.error ? 'operator helm.json invalid' : file.signature === 'missing' ? 'operator helm.json missing; defaults used' : 'operator helm.json valid', file.error ? 'vi "${HELM_HOME:-$HOME/.helm}/helm.json"' : 'helm init');
  if (existsSync(join(repo, 'helm.json')) && resolve(repo) !== resolve(home)) {
    try { repoConfigSchema.parse(jsonFile(join(repo, 'helm.json'))); add('repo-config', 'ok', 'repo helm.json valid', 'helm doctor'); }
    catch { add('repo-config', 'fail', 'repo helm.json invalid', 'vi helm.json'); }
  }
  const slugs = codex ? await probe(codexBin, ['debug', 'models']) : undefined;
  let codexModels: string[] = []; try { codexModels = parseCodexModelSlugs(JSON.parse(slugs ?? '{}')); } catch { /* failed probe */ }
  const catalog = createModelCatalog({ claudeLaneRegistered: true, probe: { codex: (id) => codex && codexModels.includes(id), claude: () => claude, pi: (provider, id) => piModels.includes(`${provider}/${id}`) } });
  const tiers: Record<string, { models: string[]; available: string[] }> = {};
  if (settings) for (const [tier, models] of Object.entries(settings.routing.tiers)) {
    if (!['1', '2', '3', '4', '5'].includes(tier)) continue;
    const available = (await Promise.all(models.map(async (m) =>
      await candidateUnavailableReason(settings, appliedPolicy(settings, {}), catalog, m) === undefined ? m : undefined))).filter((m): m is string => m !== undefined);
    tiers[tier] = { models, available };
    add(`tier ${tier}`, available.length ? 'ok' : 'warn', available.length ? 'available model found' : 'no available allowed model; routing can fall back to another tier', 'vi "${HELM_HOME:-$HOME/.helm}/helm.json"');
  }
  if (settings && !Object.values(tiers).some((tier) => tier.available.length > 0)) add('routing', 'fail', 'no routing tier has a usable model', 'vi "${HELM_HOME:-$HOME/.helm}/helm.json"');
  const servePath = join(home, 'serve.json');
  if (!existsSync(servePath)) add('daemon', 'warn', 'serve.json absent', 'helm serve --stdio');
  else {
    let alive = false, authenticated = false, stale = false;
    try {
      const metadata = jsonFile(servePath);
      if (!Number.isInteger(metadata.pid) || metadata.pid <= 0 || !Number.isInteger(metadata.port) || metadata.port < 1 || metadata.port > 65535 || typeof metadata.token !== 'string' || !metadata.token) throw new Error();
      try { process.kill(metadata.pid, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; stale = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (alive) { const res = await fetch(`http://127.0.0.1:${metadata.port}/tools/daemon.control`, { method: 'POST', headers: { authorization: `Bearer ${metadata.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }), signal: AbortSignal.timeout(3000), redirect: 'error' }); authenticated = res.ok && (await res.json() as { ok?: boolean }).ok === true; }
    } catch { /* metadata and remote error bodies are never printed */ }
    add('daemon-pid', alive ? 'ok' : stale ? 'warn' : 'fail', 'serve.json present; pid checked', stale ? 'start the daemon: helm serve' : 'helm doctor');
    if (!stale) add('daemon-status', authenticated ? 'ok' : 'fail', 'authenticated status checked', 'helm doctor');
  }
  const ok = !checks.some((c) => c.status === 'fail');
  return { ok, checks, lanes, tiers, nextCommand: (checks.find((c) => c.status === 'fail') ?? checks.find((c) => c.status === 'warn' && ['config', 'daemon', 'daemon-pid'].includes(c.name)))?.next ?? `helm spawn --repo '${resolve(repo).replaceAll("'", "'\\''")}' --objective "Describe your task"` };
}
export async function init(repo: string, force = false): Promise<string> {
  repo = resolve(repo); const home = resolve(loadConfig().home), path = join(repo, 'helm.json');
  if (repo === home) throw new OnboardingError('target repo must differ from HELM_HOME');
  let files: string[];
  try { files = readdirSync(repo); }
  catch { throw new OnboardingError('invalid --repo path: expected an existing readable directory'); }
  if (existsSync(path) && !force) throw new OnboardingError('repo helm.json exists; use --force to overwrite');
  const gates: Array<{ name: string; command: string }> = [];
  if (files.includes('package.json')) {
    let scripts: Record<string, unknown>;
    try {
      const pkg = jsonFile(join(repo, 'package.json'));
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) ||
          (pkg.scripts !== undefined && (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)))) throw new Error();
      scripts = pkg.scripts ?? {};
    } catch { throw new OnboardingError('invalid package.json: expected a JSON object with an optional scripts object'); }
    const manager = files.includes('package-lock.json') ? 'npm' : files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : 'npm';
    const install = files.includes('package-lock.json') ? 'npm ci' : manager === 'npm' ? 'npm install' : manager === 'yarn' && files.includes('.yarnrc.yml') ? 'yarn install --immutable' : `${manager} install --frozen-lockfile`;
    gates.push({ name: 'install', command: install });
    for (const name of ['test', 'typecheck', 'lint']) if (typeof scripts[name] === 'string') gates.push({ name, command: `${manager} run ${name}` });
  } else if (files.includes('Package.swift')) gates.push({ name: 'swift', command: 'swift test' });
  else gates.push({ name: 'TODO', command: `echo '${files.some((f) => /\.(xcodeproj|xcworkspace)$/.test(f)) ? 'TODO: configure xcodebuild test with your scheme and destination' : 'TODO: configure a project test gate'}'; exit 1` });
  try { mkdirSync(home, { recursive: true }); writeFileSync(join(home, 'helm.json'), `${JSON.stringify({ spend: { capUsd: 5 }, routing: { policy: { subscriptionOnly: !apiKeysPresent() } } }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new OnboardingError('could not create operator helm.json'); }
  writeFileSync(path, `${JSON.stringify({ gates }, null, 2)}\n`, { flag: force ? 'w' : 'wx' });
  return JSON.stringify({ mcpServers: { helm: { command: 'helm', args: ['serve', '--stdio'] } } }, null, 2);
}
export async function onboard(command: 'doctor' | 'init', args: string[]): Promise<void> {
  const options: Record<string, { type: 'string' | 'boolean' }> = {
    repo: { type: 'string' }, [command === 'init' ? 'force' : 'json']: { type: 'boolean' },
  };
  const { values } = parseArgs({ args, options });
  const repo = typeof values.repo === 'string' ? values.repo : process.cwd();
  if (command === 'init') console.log(`.mcp.json snippet:\n${await init(repo, values.force === true)}`);
  const report = await doctor(repo);
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else { for (const c of report.checks) console.log(`${c.status} ${c.name}: ${c.detail}`); console.log(`lanes: ${JSON.stringify(report.lanes)}\ntiers: ${JSON.stringify(report.tiers)}\nnext: ${report.nextCommand}`); }
  if (command === 'init' && !report.ok) console.log('Files written. Follow the doctor next steps above before starting workers.');
  process.exitCode = command === 'init' || report.ok ? 0 : 1;
}
