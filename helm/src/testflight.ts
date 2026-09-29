import type { DeployExec } from './deploy.js';

export type TestFlightTarget = Readonly<{ lane?: string }>;

export async function runTestFlight(target: TestFlightTarget, worktree: string, exec: DeployExec, env: NodeJS.ProcessEnv, redact: (value: unknown) => string): Promise<{ deploymentId: string }> {
  const lane = target.lane ?? 'beta';
  const result = await exec('bundle', ['exec', 'fastlane', lane], { cwd: worktree, env, timeout: 300_000 });
  const output = [result.stdout, result.stderr ?? ''].filter(Boolean).join('\n');
  const lines = output.split(/\r?\n/); if (lines.at(-1) === '') lines.pop();
  const tail = redact(lines.slice(-40).join('\n'));
  if ((result.code ?? 0) !== 0) throw new Error(`fastlane failed\n${tail}`);
  const build = output.match(/(?:build(?:\s+number)?|BUILD_NUMBER)\D+(\d+)/i)?.[1];
  if (!build) throw new Error('fastlane did not report a build number');
  return { deploymentId: build };
}
