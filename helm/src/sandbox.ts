/** macOS Seatbelt profiles and the minimal environment used by gate commands. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export type GateSandbox = Readonly<{
  executable: string;
  env: NodeJS.ProcessEnv;
  home: string;
  tempDir: string;
  profilePath: string;
}>;

export type GateSandboxOptions = Readonly<{
  cwd: string;
  allowNetwork: boolean;
  operatorHome?: string;
  denyLocalPorts?: readonly number[];
  denyLocalSocketPaths?: readonly string[];
}>;

export type InstallManager = 'npm' | 'pnpm' | 'yarn';

export const DEFAULT_DENY_LOCAL_PORTS = [4747, 4748, 4749, 4750] as const;

const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const exec = promisify(execFile);

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}` + '"';
}

function subpath(path: string): string {
  return `(subpath ${quote(path)})`;
}

function literal(path: string): string {
  return `(literal ${quote(path)})`;
}

function regex(value: string): string {
  return `(regex ${quote(value)})`;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function validPorts(ports: readonly number[]): number[] {
  return [...new Set(ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535))];
}

function ancestors(paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const path of paths) {
    let current = resolve(path);
    while (true) {
      result.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return unique(result);
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/** The deny list shared by every worker-facing macOS sandbox. */
export function credentialPaths(home: string): readonly string[] {
  return [
    join(home, '.config'),
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.netrc'),
    join(home, '.npmrc'),
    join(home, '.yarnrc'),
    join(home, '.yarnrc.yml'),
    join(home, '.docker'),
    join(home, '.kube'),
    join(home, '.stripe'),
    join(home, '.convex'),
    join(home, '.codex'),
    join(home, '.pi'),
    join(home, '.claude'),
    join(home, '.claude.json'),
    join(home, '.appstoreconnect'),
    join(home, 'Library', 'Keychains'),
    join(home, 'Library', 'Application Support'),
    join(home, '.helm'),
  ];
}

/** Build a versioned, inspectable SBPL profile for one gate step. */
export function buildSandboxProfile(options: {
  cwd: string;
  tempDir: string;
  operatorHomes: readonly string[];
  gateHome?: string;
  toolchainPaths?: readonly string[];
  npmCachePaths?: readonly string[];
  gitDir?: string;
  gitDirs?: readonly string[];
  denyLocalPorts?: readonly number[];
  denyLocalSocketPaths?: readonly string[];
  allowNetwork: boolean;
}): string {
  const cwd = resolve(options.cwd);
  const tempDir = resolve(options.tempDir);
  const gitDirs = unique([options.gitDir ?? '', ...(options.gitDirs ?? [])].filter(Boolean));
  const readOnlyExceptions = unique([
    cwd,
    ...gitDirs,
    tempDir,
    ...(options.gateHome ? [options.gateHome] : []),
    ...(options.toolchainPaths ?? []),
    ...(options.npmCachePaths ?? []),
  ]);
  const homes = unique(options.operatorHomes);
  const denyLocalPorts = validPorts(options.denyLocalPorts ?? DEFAULT_DENY_LOCAL_PORTS);
  const denyLocalSocketPaths = unique(options.denyLocalSocketPaths ?? []);
  const metadataPaths = ancestors([
    ...homes,
    ...readOnlyExceptions,
    ...homes.map((home) => join(home, '.config', 'git')),
  ]);
  const lines = [
    '(version 1)',
    '(import "system.sb")',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    `(allow file-read* ${subpath('/')})`,
    `(allow file-write* ${subpath(cwd)})`,
    `(allow file-write* ${subpath(tempDir)})`,
    `(deny file-write* ${subpath(join(cwd, '.git'))})`,
    options.allowNetwork ? '(allow network*)' : '(deny network*)',
  ];

  if (!options.allowNetwork) {
    for (const path of [tempDir, cwd]) {
      lines.push(`(allow network* (local unix-socket ${subpath(path)}))`);
      lines.push(`(allow network* (remote unix-socket ${subpath(path)}))`);
    }
    lines.push('(allow network* (local ip "localhost:*"))');
    lines.push('(allow network* (remote ip "localhost:*"))');
    for (const port of denyLocalPorts) lines.push(`(deny network-outbound (remote ip "localhost:${port}"))`);
    for (const path of denyLocalSocketPaths) lines.push(`(deny network-outbound (remote unix-socket ${subpath(path)}))`);
  }

  for (const home of homes) {
    // The operator HOME is deny-by-default. Later rules re-open only the
    // worktree, git metadata, toolchain, git config, and cache paths needed by
    // a gate; system paths remain readable through the root read grant above.
    lines.push(`(deny file-read* ${subpath(home)})`);
    for (const path of credentialPaths(home)) {
      if (path.endsWith(join('', '.yarnrc'))) {
        lines.push(`(deny file-read* ${literal(path)})`);
        lines.push(`(deny file-read* ${literal(`${path}.yml`)})`);
        lines.push(`(deny file-read* ${regex(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*`)})`);
      } else {
        lines.push(`(deny file-read* ${subpath(path)})`);
      }
    }
    lines.push(`(allow file-read* ${subpath(join(home, '.config', 'git'))})`);
  }

  // Denying file-read* also blocks lstat/realpath traversal. Re-open metadata
  // only for protected homes and every directory needed to reach a read-only
  // exception; contents remain governed by the rules above and below.
  for (const path of metadataPaths) lines.push(`(allow file-read-metadata ${literal(path)})`);

  // A worktree can live below ~/.helm, and its .git file can point at a real git dir.
  // These are read-only exceptions; the write rules above still exclude .git.
  for (const path of readOnlyExceptions) lines.push(`(allow file-read* ${subpath(path)})`);
  for (const gitDir of gitDirs) lines.push(`(deny file-write* ${subpath(gitDir)})`);
  return `${lines.join('\n')}\n`;
}

export function operatorHomePaths(operatorHome?: string): string[] {
  return unique([homedir(), resolve(operatorHome ?? homedir())]);
}

export async function worktreeGitDirs(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'], { cwd, timeout: 10_000 });
    const paths = stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean).map((path) => isAbsolute(path) ? path : resolve(cwd, path));
    return unique(await Promise.all(paths.map((path) => canonicalPath(path))));
  } catch {
    return [];
  }
}

export function minimalGateEnv(home: string, tempDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? FALLBACK_PATH,
    HOME: home,
    LANG: process.env.LANG ?? 'C',
    TMPDIR: tempDir,
    CI: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'gc.auto',
    GIT_CONFIG_VALUE_0: '0',
    GIT_CONFIG_KEY_1: 'maintenance.auto',
    GIT_CONFIG_VALUE_1: 'false',
  };
}

export function sandboxExecutable(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  return existsSync('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : undefined;
}

export function sandboxUnavailableReason(allowUnsandboxed: boolean): string | undefined {
  if (sandboxExecutable()) return undefined;
  if (allowUnsandboxed) return undefined;
  return `sandbox-exec is unavailable on ${process.platform}; refusing to run gate commands (set settings.gates.allowUnsandboxed=true only for a trusted host)`;
}

/** Recognize only a direct package-manager install command; shell chains never gain network. */
export function installManager(command: string): InstallManager | undefined {
  if (/\b--offline(?:\s|$)/i.test(command)) return undefined;
  if (!/^\s*(?:npm\s+(?:ci|install)|pnpm\s+(?:install|i)|yarn\s+install)(?:\s+[^;&|<>`$]*)?\s*$/i.test(command)) return undefined;
  if (/^\s*npm\s+/i.test(command)) return 'npm';
  if (/^\s*pnpm\s+/i.test(command)) return 'pnpm';
  return 'yarn';
}

async function canonicalPaths(paths: readonly string[]): Promise<string[]> {
  const values = await Promise.all(paths.map(async (path) => [resolve(path), await canonicalPath(path)]));
  return unique(values.flat());
}

async function toolchainPaths(pathValue: string): Promise<string[]> {
  const entries = pathValue.split(delimiter).map((entry) => entry.trim()).filter(Boolean).filter(isAbsolute);
  const paths = await canonicalPaths(entries);
  for (const entry of entries) {
    if (/(?:^|\/)\.nvm\/versions\/node\/[^/]+\/bin\/?$/i.test(entry)) paths.push(resolve(entry, '..'));
    for (const tool of ['node', 'npm', 'pnpm', 'yarn', 'git', 'cargo']) {
      const target = await realpath(join(entry, tool)).catch(() => undefined);
      if (target) paths.push(target, dirname(target));
    }
  }
  return unique(paths);
}

export async function prepareGateSandbox(options: GateSandboxOptions): Promise<GateSandbox> {
  const executable = sandboxExecutable();
  if (!executable) throw new Error(`sandbox-exec is unavailable on ${process.platform}`);
  const tempDir = await mkdtemp(join(tmpdir(), 'helm-gate-'));
  try {
    const home = join(tempDir, 'home');
    await mkdir(home, { recursive: true });
    // macOS exposes temporary paths through /var, while Seatbelt matches the
    // canonical /private/var paths. Generate rules for the paths the kernel
    // evaluates, or temporary worktrees and credential fixtures bypass them.
    const [profileCwd, profileTempDir, profileHome, ...profileOperatorHomes] = await Promise.all([
      canonicalPath(options.cwd),
      canonicalPath(tempDir),
      canonicalPath(home),
      ...operatorHomePaths(options.operatorHome).map((path) => canonicalPath(path)),
    ]);
    const toolchains = await toolchainPaths(process.env.PATH ?? FALLBACK_PATH);
    const npmCaches = await canonicalPaths(profileOperatorHomes.map((operatorHome) => join(operatorHome, '.npm')));
    const profile = buildSandboxProfile({
      cwd: profileCwd,
      tempDir: profileTempDir,
      operatorHomes: profileOperatorHomes,
      gateHome: profileHome,
      toolchainPaths: toolchains,
      npmCachePaths: npmCaches,
      gitDirs: await worktreeGitDirs(profileCwd),
      denyLocalPorts: options.denyLocalPorts,
      denyLocalSocketPaths: await Promise.all((options.denyLocalSocketPaths ?? []).map((path) => canonicalPath(path))),
      allowNetwork: options.allowNetwork,
    });
    const profilePath = join(tempDir, 'profile.sb');
    await writeFile(profilePath, profile, 'utf8');
    return { executable, env: minimalGateEnv(home, tempDir), home, tempDir, profilePath };
  } catch (error) {
    await disposeGateSandbox(tempDir);
    throw error;
  }
}

export async function prepareUnsandboxedGate(): Promise<Omit<GateSandbox, 'executable' | 'profilePath'> & { executable?: undefined; profilePath?: undefined }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'helm-gate-'));
  const home = join(tempDir, 'home');
  await mkdir(home, { recursive: true });
  return { env: minimalGateEnv(home, tempDir), home, tempDir };
}

export async function disposeGateSandbox(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}
