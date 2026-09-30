/** Run checks as child processes, capture output. See DESIGN.md. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateCheck, GateRunner } from './types.js';
import { loadRepoConfig } from './repoconfig.js';
import { cleanupNodeModules } from './hygiene.js';
import { disposeGateSandbox, isInstallCommand, prepareGateSandbox, prepareUnsandboxedGate, sandboxExecutable, sandboxUnavailableReason } from './sandbox.js';

type CheckResult = { name: string; command: string; exitCode: number | null; outputPath: string; durationMs: number };

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

async function runCheck(cwd: string, check: GateCheck, outputSlug: string, logDir: string, timeoutMs: number, options: { sandbox: boolean; allowUnsandboxed: boolean; operatorHome?: string }): Promise<CheckResult> {
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
    sandbox = options.sandbox && sandboxExecutable()
      ? await prepareGateSandbox({ cwd, allowNetwork: isInstallCommand(check.command), operatorHome: options.operatorHome })
      : await prepareUnsandboxedGate();
    if (sandbox.executable && sandbox.profilePath && /^(1|true)$/i.test(process.env.HELM_DEBUG_SANDBOX ?? '')) {
      await copyFile(sandbox.profilePath, join(logDir, `${outputSlug}.profile.sb`)).catch(() => {});
    }
  } catch (error) {
    return writeResult('', error instanceof Error ? error.message : String(error), null);
  }

  const execute = (child: NonNullable<typeof sandbox>): Promise<{ error: ExecFileError | null; stdout: string; stderr: string }> => new Promise((resolve) => {
      const executable = child.executable ?? '/bin/sh';
      const args = child.executable ? ['-f', child.profilePath!, '/bin/sh', '-c', check.command] : ['-c', check.command];
      execFile(executable, args, { cwd, env: child.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ error: error as ExecFileError | null, stdout, stderr });
      });
    });

  try {
    let result = await execute(sandbox);
    if (sandbox.executable && options.allowUnsandboxed && String(result.error?.code) === '71' && /sandbox_apply/i.test(result.stderr)) {
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
    async run(cwd: string, checks: readonly GateCheck[], logDir: string, opts?: { timeoutMs?: number; nodeModulesRoot?: string; sandbox?: boolean; onNodeModulesError?: (message: string) => void }) {
      await mkdir(logDir, { recursive: true });
      const timeoutMs = opts?.timeoutMs ?? 900000;
      const results: CheckResult[] = [];
      const usedSlugs = new Map<string, number>();
      try {
        for (const check of checks) {
          const base = slugifyCheckName(check.name);
          const seen = usedSlugs.get(base) ?? 0;
          usedSlugs.set(base, seen + 1);
          const outputSlug = seen === 0 ? base : `${base}-${seen}`;
          const result = await runCheck(cwd, check, outputSlug, logDir, timeoutMs, {
            sandbox: opts?.sandbox !== false,
            allowUnsandboxed: options.allowUnsandboxed === true,
            operatorHome: options.operatorHome,
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
