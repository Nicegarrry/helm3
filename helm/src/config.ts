/** $HELM_HOME, spend cap, worker/gate limits. See DESIGN.md. */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HelmConfig } from './types.js';

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HelmConfig {
  const home = env.HELM_HOME && env.HELM_HOME.trim() !== '' ? env.HELM_HOME : join(homedir(), '.helm');
  return Object.freeze({
    home,
    spendCapUsd: num(env.HELM_SPEND_CAP_USD, 0),
    maxWorkers: num(env.HELM_MAX_WORKERS, 3),
    gateTimeoutMs: num(env.HELM_GATE_TIMEOUT_MS, 900000),
  });
}

/** Create the home directory tree. Lazy: called by whoever needs it to exist. */
export function ensureHome(config: HelmConfig): void {
  for (const dir of [config.home, join(config.home, 'worktrees'), join(config.home, 'logs'), join(config.home, 'sessions')]) {
    mkdirSync(dir, { recursive: true });
  }
}
