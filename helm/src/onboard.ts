/** Local onboarding. Diagnostics never create state or start a daemon. */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { findEnvKeys } from '@earendil-works/pi-ai/compat';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadConfig } from './config.js';
import { defaultCodexBin } from './codex.js';
import { defaultClaudeBin } from './claude.js';
import { readSettingsFile } from './settings.js';
import { createModelCatalog, laneForModel, parseCodexModelSlugs } from './routing/catalog.js';
import { appliedPolicy, policyAllows } from './routing/policy.js';
import { repoConfigSchema } from './repoconfig.js';
type Check = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string; next: string };
const exec = promisify(execFile);
const apiKeysPresent = () => Object.entries(process.env).some(([key, value]) => /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN)$/.test(key) && value?.trim());
const jsonFile = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('invalid JSON file'); } };
export async function doctor(repo = process.cwd()) {
  const home = loadConfig().home, checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string, next: string) => checks.push({ name, status, detail, next });
  const probe = async (file: string, args: string[]) => { try { return (await exec(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout; } catch { return undefined; } };
  add('node', Number(process.versions.node.split('.')[0]) >= 22 && await probe(process.execPath, ['-e', "require('node:sqlite')"]) !== undefined ? 'ok' : 'fail', 'Node >= 22 with node:sqlite', 'nvm install 22');
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
    const available = (await Promise.all(models.map(async (m) => policyAllows(appliedPolicy(settings, {}), m) && lanes[laneForModel(m)] && (await catalog.availability(m)).available ? m : undefined))).filter((m): m is string => m !== undefined);
    tiers[tier] = { models, available };
    add(`tier ${tier}`, available.length ? 'ok' : 'fail', available.length ? 'available model found' : 'no available allowed model', 'vi "${HELM_HOME:-$HOME/.helm}/helm.json"');
  }
  if (settings && !Object.keys(tiers).length) add('routing', 'fail', 'no routing tiers configured', 'vi "${HELM_HOME:-$HOME/.helm}/helm.json"');
  const servePath = join(home, 'serve.json');
  if (!existsSync(servePath)) add('daemon', 'warn', 'serve.json absent', 'helm serve --stdio');
  else {
    let alive = false, authenticated = false;
    try {
      const metadata = jsonFile(servePath);
      if (!Number.isInteger(metadata.pid) || metadata.pid <= 0 || !Number.isInteger(metadata.port) || metadata.port < 1 || metadata.port > 65535 || typeof metadata.token !== 'string' || !metadata.token) throw new Error();
      try { process.kill(metadata.pid, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; }
      if (alive) { const res = await fetch(`http://127.0.0.1:${metadata.port}/tools/daemon.control`, { method: 'POST', headers: { authorization: `Bearer ${metadata.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'status' }), signal: AbortSignal.timeout(3000), redirect: 'error' }); authenticated = res.ok && (await res.json() as { ok?: boolean }).ok === true; }
    } catch { /* metadata and remote error bodies are never printed */ }
    add('daemon-pid', alive ? 'ok' : 'fail', 'serve.json present; pid checked', 'helm doctor');
    add('daemon-status', authenticated ? 'ok' : 'fail', 'authenticated status checked', 'helm doctor');
  }
  const ok = !checks.some((c) => c.status === 'fail');
  return { ok, checks, lanes, tiers, nextCommand: (checks.find((c) => c.status === 'fail') ?? checks.find((c) => c.status === 'warn' && ['config', 'daemon'].includes(c.name)))?.next ?? 'helm spawn --repo . --objective "Describe your task"' };
}
export async function init(repo: string, force = false): Promise<string> {
  repo = resolve(repo); const home = resolve(loadConfig().home), path = join(repo, 'helm.json');
  if (repo === home) throw new Error('target repo must differ from HELM_HOME');
  if (existsSync(path) && !force) throw new Error('repo helm.json exists; use --force to overwrite');
  const files = readdirSync(repo), gates: Array<{ name: string; command: string }> = [];
  if (files.includes('package.json')) {
    const scripts = jsonFile(join(repo, 'package.json')).scripts ?? {};
    gates.push({ name: 'install', command: 'npm ci' });
    for (const name of ['test', 'typecheck', 'lint']) if (typeof scripts[name] === 'string') gates.push({ name, command: `npm run ${name}` });
  } else if (files.includes('Package.swift')) gates.push({ name: 'swift', command: 'swift test' });
  else gates.push({ name: 'TODO', command: `echo '${files.some((f) => /\.(xcodeproj|xcworkspace)$/.test(f)) ? 'TODO: configure xcodebuild test with your scheme and destination' : 'TODO: configure a project test gate'}'; exit 1` });
  writeFileSync(path, `${JSON.stringify({ gates }, null, 2)}\n`, { flag: force ? 'w' : 'wx' });
  mkdirSync(home, { recursive: true });
  try { writeFileSync(join(home, 'helm.json'), `${JSON.stringify({ spend: { capUsd: 5 }, routing: { policy: { subscriptionOnly: !apiKeysPresent() } } }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('could not create operator helm.json'); }
  return JSON.stringify({ mcpServers: { helm: { command: 'helm', args: ['serve', '--stdio'] } } }, null, 2);
}
export async function onboard(command: 'doctor' | 'init', args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: command === 'init' ? { repo: { type: 'string' }, force: { type: 'boolean' } } : { json: { type: 'boolean' } } });
  const repo = typeof values.repo === 'string' ? values.repo : process.cwd();
  if (command === 'init') console.log(`.mcp.json snippet:\n${await init(repo, values.force === true)}`);
  const report = await doctor(repo);
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else { for (const c of report.checks) console.log(`${c.status} ${c.name}: ${c.detail}`); console.log(`lanes: ${JSON.stringify(report.lanes)}\ntiers: ${JSON.stringify(report.tiers)}\nnext: ${report.nextCommand}`); }
  process.exitCode = report.ok ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) onboard(process.argv[2] as 'doctor' | 'init', process.argv.slice(3)).catch((e) => { console.error(e instanceof Error && /^(repo helm.json exists|target repo must differ)/.test(e.message) ? e.message : 'onboarding failed; check paths, permissions and JSON configuration'); process.exitCode = 1; });
