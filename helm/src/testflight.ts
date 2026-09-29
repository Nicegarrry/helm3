import type { DeployExec } from './deploy.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type TestFlightTarget = Readonly<{ platform?: string; lane?: string; timeoutMin?: number }>;

// Fastfile lanes should print `HELM_BUILD_NUMBER=<digits>` after the build is selected.
export async function runTestFlight(target: TestFlightTarget, worktree: string, exec: DeployExec, env: NodeJS.ProcessEnv, redact: (value: unknown) => string): Promise<{ deploymentId: string | null }> {
  if (!existsSync(join(worktree, 'Gemfile.lock'))) throw new Error('Gemfile.lock is required for TestFlight deploys');
  const timeout = (target.timeoutMin ?? 60) * 60_000;
  const minimalEnv: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME']) if (env[key]) minimalEnv[key] = env[key];
  const bundle = await exec('bundle', ['install', '--deployment'], { cwd: worktree, env: minimalEnv, timeout });
  if ((bundle.code ?? 0) !== 0) {
    const output = [bundle.stdout, bundle.stderr ?? ''].filter(Boolean).join('\n');
    throw new Error(`bundle install failed\n${redact(output.split(/\r?\n/).slice(-40).join('\n'))}`);
  }
  const valid = /^[a-z][a-z0-9_]*$/;
  const lane = target.lane ?? 'beta';
  if (target.platform !== undefined && !valid.test(target.platform)) throw new Error('invalid TestFlight platform');
  if (!valid.test(lane)) throw new Error('invalid TestFlight lane');
  const laneArgs = target.platform === undefined ? [lane] : [target.platform, lane];
  const result = await exec('bundle', ['exec', 'fastlane', ...laneArgs], { cwd: worktree, env, timeout });
  const output = [result.stdout, result.stderr ?? ''].filter(Boolean).join('\n');
  const lines = output.split(/\r?\n/); if (lines.at(-1) === '') lines.pop();
  const tail = redact(lines.slice(-40).join('\n'));
  if ((result.code ?? 0) !== 0) throw new Error(`fastlane failed\n${tail}`);
  const marker = lines.find((line) => /^HELM_BUILD_NUMBER=\d+$/.test(line.trim()))?.trim().slice('HELM_BUILD_NUMBER='.length);
  const build = marker ?? output.match(/^\s*Build number:\s*(\d+)\s*$/mi)?.[1] ?? output.match(/^\s*build_number\s*=>\s*(\d+)\s*$/mi)?.[1] ?? null;
  return { deploymentId: build };
}
