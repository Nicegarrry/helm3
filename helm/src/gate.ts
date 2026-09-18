/** Run checks as child processes, capture output. See DESIGN.md. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateCheck, GateRunner } from './types.js';

type CheckResult = { name: string; command: string; exitCode: number | null; outputPath: string; durationMs: number };

type ExecFileError = NodeJS.ErrnoException & { code?: number | string; signal?: string | null; killed?: boolean };

function runCheck(cwd: string, check: GateCheck, logDir: string, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const outputPath = join(logDir, `${check.name}.log`);
    execFile('/bin/sh', ['-c', check.command], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const err = error as ExecFileError | null;
      // Exit code is null when the process was killed by a signal (e.g. timeout).
      const exitCode = err === null ? 0 : typeof err.code === 'number' ? err.code : null;
      writeFile(outputPath, `$ ${check.command}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`)
        .catch(() => {})
        .finally(() => resolve({ name: check.name, command: check.command, exitCode, outputPath, durationMs }));
    });
  });
}

export function gateRunner(): GateRunner {
  return {
    async run(cwd: string, checks: readonly GateCheck[], logDir: string, opts?: { timeoutMs?: number }) {
      await mkdir(logDir, { recursive: true });
      const timeoutMs = opts?.timeoutMs ?? 900000;
      const results: CheckResult[] = [];
      for (const check of checks) {
        const result = await runCheck(cwd, check, logDir, timeoutMs);
        results.push(result);
      }
      const passed = results.every((result) => result.exitCode === 0);
      return { passed, checks: results };
    },

    async defaultChecks(repo: string): Promise<GateCheck[]> {
      const helmJsonPath = join(repo, 'helm.json');
      if (existsSync(helmJsonPath)) {
        try {
          const raw = JSON.parse(await readFile(helmJsonPath, 'utf8')) as { gates?: { name: string; command: string }[] };
          if (Array.isArray(raw.gates) && raw.gates.length > 0) {
            return raw.gates.map((gate) => ({ name: gate.name, command: gate.command }));
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
