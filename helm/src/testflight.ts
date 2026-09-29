import type { DeployExec } from './deploy.js';

export type TestFlightTarget = Readonly<{ lane?: string; timeoutMin?: number }>;

// Fastfile lanes should print `HELM_BUILD_NUMBER=<digits>` after the build is selected.
export async function runTestFlight(target: TestFlightTarget, worktree: string, exec: DeployExec, env: NodeJS.ProcessEnv, redact: (value: unknown) => string): Promise<{ deploymentId: string | null }> {
  const lane = target.lane ?? 'beta';
  const result = await exec('bundle', ['exec', 'fastlane', lane], { cwd: worktree, env, timeout: (target.timeoutMin ?? 60) * 60_000 });
  const output = [result.stdout, result.stderr ?? ''].filter(Boolean).join('\n');
  const lines = output.split(/\r?\n/); if (lines.at(-1) === '') lines.pop();
  const tail = redact(lines.slice(-40).join('\n'));
  if ((result.code ?? 0) !== 0) throw new Error(`fastlane failed\n${tail}`);
  const marker = lines.find((line) => /^HELM_BUILD_NUMBER=\d+$/.test(line.trim()))?.trim().slice('HELM_BUILD_NUMBER='.length);
  const build = marker ?? output.match(/^\s*Build number:\s*(\d+)\s*$/mi)?.[1] ?? output.match(/^\s*build_number\s*=>\s*(\d+)\s*$/mi)?.[1] ?? null;
  return { deploymentId: build };
}
