/** macOS Seatbelt profiles and the minimal environment used by gate commands. */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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
}>;

const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const GIT_DIR_PREFIX = /^gitdir:\s*(.+)$/;

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
  gitDir?: string;
  gitDirs?: readonly string[];
  allowNetwork: boolean;
}): string {
  const cwd = resolve(options.cwd);
  const tempDir = resolve(options.tempDir);
  const gitDirs = unique([options.gitDir ?? '', ...(options.gitDirs ?? [])].filter(Boolean));
  const readOnlyExceptions = unique([cwd, ...gitDirs, tempDir]);
  const homes = unique(options.operatorHomes);
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

  // The temporary HOME lives below tempDir. Grant tempDir before adding the
  // credential denies so the latter remains the last matching read rule for
  // the generated HOME's credential paths.
  lines.push(`(allow file-read* ${subpath(tempDir)})`);

  for (const home of homes) {
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

  // A worktree can live below ~/.helm, and its .git file can point at a real git dir.
  // These are read-only exceptions; the write rules above still exclude .git.
  for (const path of readOnlyExceptions.filter((path) => path !== tempDir)) lines.push(`(allow file-read* ${subpath(path)})`);
  for (const gitDir of gitDirs) lines.push(`(deny file-write* ${subpath(gitDir)})`);
  return `${lines.join('\n')}\n`;
}

function worktreeGitDirs(cwd: string): string[] {
  try {
    const dotGit = join(cwd, '.git');
    const stat = readFileSync(dotGit, 'utf8');
    const match = GIT_DIR_PREFIX.exec(stat.trim());
    if (!match) return [dotGit];
    const gitDir = isAbsolute(match[1]!) ? resolve(match[1]!) : resolve(cwd, match[1]!);
    return [gitDir, resolve(gitDir, '..', '..')];
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
    const [profileCwd, profileTempDir, profileHome, operatorHome] = await Promise.all([
      canonicalPath(options.cwd),
      canonicalPath(tempDir),
      canonicalPath(home),
      canonicalPath(resolve(options.operatorHome ?? homedir())),
    ]);
    const profile = buildSandboxProfile({
      cwd: profileCwd,
      tempDir: profileTempDir,
      operatorHomes: unique([operatorHome, profileHome]),
      gitDirs: worktreeGitDirs(profileCwd),
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

export function isInstallCommand(command: string): boolean {
  return /\bnpm\s+ci\b/i.test(command);
}
