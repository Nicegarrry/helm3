/** Run checks as child processes, capture output. See DESIGN.md. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { GateCheck, GateRunner } from './types.js';
import { loadRepoConfig } from './repoconfig.js';
import { cleanupNodeModules } from './hygiene.js';
import { disposeGateSandbox, installManager, prepareGateSandbox, prepareUnsandboxedGate, sandboxExecutable, sandboxUnavailableReason, type InstallManager } from './sandbox.js';

type CheckResult = { name: string; command: string; exitCode: number | null; outputPath: string; durationMs: number };
type PreparedGateCheck = GateCheck & { allowNetwork?: boolean };
type EscapingSymlink = { path: string; nodeModules: boolean };

type ExecFileError = NodeJS.ErrnoException & { code?: number | string; signal?: string | null; killed?: boolean };

/** Read the sandbox opt-out from the recorded base branch only. Missing/invalid base policy is fail-closed. */
export async function sandboxEnabled(repo: string, sha: string): Promise<boolean> {
  try {
    return (await loadRepoConfig(repo, sha, false)).gate?.sandbox !== false;
  } catch {
    return true;
  }
}

/** `check.name` is attacker/author-controlled free text used to build a log file path; sanitize it before it ever reaches `outputPath` (F8). */
function slugifyCheckName(name: string): string {
  let slug = name.replace(/[^A-Za-z0-9._-]+/g, '-');
  slug = slug.replace(/-{2,}/g, '-');
  slug = slug.replace(/^\.+/, '');
  slug = slug.replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'check';
}

function withIgnoreScripts(command: string): string {
  if (/\b--ignore-scripts(?:\s|$)/i.test(command)) return command;
  const prefix = /^\s*(?:npm\s+(?:ci|install)|pnpm\s+(?:install|i)|yarn\s+install)/i.exec(command);
  if (!prefix) return command;
  const end = (prefix.index ?? 0) + prefix[0].length;
  return `${command.slice(0, end)} --ignore-scripts${command.slice(end)}`;
}

async function hasPrepareScript(cwd: string): Promise<boolean> {
  try {
    const packageJson = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    return typeof packageJson.scripts?.prepare === 'string';
  } catch {
    return false;
  }
}

function offlineLifecycleCommand(manager: InstallManager, prepare: boolean): string {
  if (manager === 'yarn') return `yarn install --offline --ignore-scripts=false${prepare ? ' && yarn run prepare --offline' : ''}`;
  return `${manager} rebuild --offline${prepare ? ` && ${manager} run prepare --if-present --offline` : ''}`;
}

/** Turn a package install into a networked dependency-only step and an offline lifecycle step. */
export async function expandInstallChecks(cwd: string, checks: readonly GateCheck[]): Promise<PreparedGateCheck[]> {
  const prepare = await hasPrepareScript(cwd);
  const expanded: PreparedGateCheck[] = [];
  for (const check of checks) {
    const manager = installManager(check.command);
    if (!manager) {
      expanded.push({ name: check.name, command: check.command });
      continue;
    }
    expanded.push({ name: check.name, command: withIgnoreScripts(check.command), allowNetwork: true });
    expanded.push({ name: `${check.name} (offline scripts)`, command: offlineLifecycleCommand(manager, prepare) });
  }
  return expanded;
}

function withGateCache(command: string, tempDir: string): string {
  const manager = installManager(command);
  if (!manager) return command;
  const flag = manager === 'npm' ? '--cache' : manager === 'pnpm' ? '--store-dir' : '--cache-folder';
  if (new RegExp(`(?:^|\\s)${flag}(?:\\s|=)`, 'i').test(command)) return command;
  return `${command} ${flag} ${JSON.stringify(join(tempDir, `${manager}-cache`))}`;
}

function insideOrEqual(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child.length === 0 || (!child.startsWith('..') && !child.startsWith('/'));
}

async function escapingSymlinks(worktree: string): Promise<EscapingSymlink[]> {
  const root = await realpath(worktree);
  const found: EscapingSymlink[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          if (!insideOrEqual(root, await realpath(path))) found.push({ path, nodeModules: entry.name === 'node_modules' });
        } catch { /* a broken link cannot escape through its current target */ }
        continue;
      }
      if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(worktree);
  return found;
}

async function unlinkNodeModulesSymlink(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function refuseEscapingSymlinks(worktree: string, logDir: string): Promise<{ result: CheckResult; reason: string } | undefined> {
  let found: EscapingSymlink[];
  try { found = await escapingSymlinks(worktree); } catch { return undefined; }
  if (found.length === 0) return undefined;
  const first = found[0]!;
  const reason = `worktree contains a symlink escaping the worktree: ${first.path}`;
  const removed = (await Promise.all(found.filter((link) => link.nodeModules).map(async (link) => (await unlinkNodeModulesSymlink(link.path)) ? link.path : undefined)))
    .filter((path): path is string => Boolean(path));
  const note = removed.length > 0 ? `\nunlinked escaping node_modules symlink: ${removed.join(', ')}` : '';
  const outputPath = join(logDir, 'gate-refused.log');
  await writeFile(outputPath, `${reason}${note}\n`).catch(() => {});
  return { reason, result: { name: 'gate.refused', command: 'symlink preflight', exitCode: 1, outputPath, durationMs: 0 } };
}

async function runCheck(cwd: string, check: PreparedGateCheck, outputSlug: string, logDir: string, timeoutMs: number, options: { sandbox: boolean; allowUnsandboxed: boolean; operatorHome?: string; onUnsandboxed?: (reason: string) => void }): Promise<CheckResult> {
  const start = Date.now();
  const outputPath = join(logDir, `${outputSlug}.log`);
  let sandbox: Awaited<ReturnType<typeof prepareGateSandbox>> | Awaited<ReturnType<typeof prepareUnsandboxedGate>> | undefined;
  const writeResult = async (stdout: string, stderr: string, exitCode: number | null): Promise<CheckResult> => {
    const durationMs = Date.now() - start;
    await writeFile(outputPath, `$ ${check.command}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`).catch(() => {});
    return { name: check.name, command: check.command, exitCode, outputPath, durationMs };
  };

  try {
    const unavailable = sandboxUnavailableReason(options.allowUnsandboxed);
    if (unavailable && (options.sandbox || process.platform !== 'darwin')) throw new Error(unavailable);
    const executable = sandboxExecutable();
    if (options.sandbox && !executable && options.allowUnsandboxed) {
      options.onUnsandboxed?.(`sandbox-exec is unavailable on ${process.platform}; running gate unsandboxed because allowUnsandboxed is enabled`);
    }
    sandbox = options.sandbox && executable
      ? await prepareGateSandbox({ cwd, allowNetwork: check.allowNetwork === true, operatorHome: options.operatorHome })
      : await prepareUnsandboxedGate();
    if (sandbox.executable && sandbox.profilePath && /^(1|true)$/i.test(process.env.HELM_DEBUG_SANDBOX ?? '')) {
      await copyFile(sandbox.profilePath, join(logDir, `${outputSlug}.profile.sb`)).catch(() => {});
    }
  } catch (error) {
    return writeResult('', error instanceof Error ? error.message : String(error), null);
  }

  const execute = (child: NonNullable<typeof sandbox>): Promise<{ error: ExecFileError | null; stdout: string; stderr: string }> => new Promise((resolve) => {
      const executable = child.executable ?? '/bin/sh';
      const command = child.executable ? withGateCache(check.command, child.tempDir) : check.command;
      const args = child.executable ? ['-f', child.profilePath!, '/bin/sh', '-c', command] : ['-c', command];
      execFile(executable, args, { cwd, env: child.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ error: error as ExecFileError | null, stdout, stderr });
      });
    });

  try {
    let result = await execute(sandbox);
    const applyFailure = sandbox.executable && result.error !== null && (String(result.error.code) === '71' || /sandbox_apply/i.test(`${result.stderr}\n${result.error.message ?? ''}`));
    if (applyFailure && options.allowUnsandboxed) {
      const reason = `sandbox-exec failed to apply profile${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`;
      options.onUnsandboxed?.(reason);
      await disposeGateSandbox(sandbox.tempDir);
      sandbox = await prepareUnsandboxedGate();
      result = await execute(sandbox);
    }
    // Exit code is null when the process was killed by a signal (e.g. timeout).
    const exitCode = result.error === null ? 0 : typeof result.error.code === 'number' ? result.error.code : null;
    return writeResult(result.stdout, result.stderr, exitCode);
  } finally {
    await disposeGateSandbox(sandbox.tempDir);
  }
}

export function gateRunner(options: { keepNodeModules?: boolean; allowUnsandboxed?: boolean; operatorHome?: string } = {}): GateRunner {
  return {
    async run(cwd: string, checks: readonly GateCheck[], logDir: string, opts?: { timeoutMs?: number; nodeModulesRoot?: string; sandbox?: boolean; onNodeModulesError?: (message: string) => void; onUnsandboxed?: (reason: string) => void; onRefused?: (reason: string) => void }) {
      await mkdir(logDir, { recursive: true });
      const timeoutMs = opts?.timeoutMs ?? 900000;
      const results: CheckResult[] = [];
      const usedSlugs = new Map<string, number>();
      const refusal = await refuseEscapingSymlinks(cwd, logDir);
      if (refusal) {
        opts?.onRefused?.(refusal.reason);
        return { passed: false, checks: [refusal.result] };
      }
      try {
        for (const check of await expandInstallChecks(cwd, checks)) {
          const base = slugifyCheckName(check.name);
          const seen = usedSlugs.get(base) ?? 0;
          usedSlugs.set(base, seen + 1);
          const outputSlug = seen === 0 ? base : `${base}-${seen}`;
          const result = await runCheck(cwd, check, outputSlug, logDir, timeoutMs, {
            sandbox: opts?.sandbox !== false,
            allowUnsandboxed: options.allowUnsandboxed === true,
            operatorHome: options.operatorHome,
            onUnsandboxed: opts?.onUnsandboxed,
          });
          results.push(result);
        }
      } finally {
        await cleanupNodeModules(cwd, options.keepNodeModules, { allowedRoot: opts?.nodeModulesRoot, onError: opts?.onNodeModulesError });
      }
      const passed = results.every((result) => result.exitCode === 0);
      return { passed, checks: results };
    },

    async defaultChecks(repo: string, sha?: string): Promise<GateCheck[]> {
      if (sha || existsSync(join(repo, 'helm.json'))) {
        try {
          const config = await loadRepoConfig(repo, sha);
          if (config.gates.length > 0) {
            return config.gates.map((gate) => ({ name: gate.name, command: gate.command }));
          }
        } catch {
          // fall through to package.json
        }
      }
      const packageJsonPath = join(repo, 'package.json');
      if (existsSync(packageJsonPath)) {
        try {
          const raw = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
          const scripts = raw.scripts ?? {};
          const checks: GateCheck[] = [];
          if (scripts.test) checks.push({ name: 'test', command: 'npm test' });
          if (scripts.typecheck) checks.push({ name: 'typecheck', command: 'npm run typecheck' });
          if (scripts.lint) checks.push({ name: 'lint', command: 'npm run lint' });
          return checks;
        } catch {
          return [];
        }
      }
      return [];
    },
  };
}
