/** $HELM_HOME, spend cap, worker/gate limits. See DESIGN.md. */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HelmConfig } from './types.js';
import type { Settings } from './settings.js';
export type SpendSource = 'settings' | 'env' | 'default';
export type EffectiveSpend = Readonly<{ capUsd: number; warnUsd: number; maxWorkers: number; sources: Readonly<{ capUsd: SpendSource; warnUsd: SpendSource; maxWorkers: SpendSource }>; warning?: string }>;

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNum(value: string | undefined): number | undefined { if (value === undefined || value.trim() === '') return undefined; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HelmConfig {
  const home = env.HELM_HOME && env.HELM_HOME.trim() !== '' ? env.HELM_HOME : join(homedir(), '.helm');
  return Object.freeze({
    home,
    spendCapUsd: num(env.HELM_SPEND_CAP_USD, 0),
    spendWarnUsd: num(env.HELM_SPEND_WARN_USD, 0),
    maxWorkers: num(env.HELM_MAX_WORKERS, 3),
    gateTimeoutMs: num(env.HELM_GATE_TIMEOUT_MS, 900000),
    spendEnv: {
      capUsd: optionalNum(env.HELM_SPEND_CAP_USD),
      warnUsd: optionalNum(env.HELM_SPEND_WARN_USD),
      maxWorkers: optionalNum(env.HELM_MAX_WORKERS),
    },
  });
}
export function effectiveSpend(config: HelmConfig, settings: Pick<Settings, 'spend'>): EffectiveSpend {
  const c = settings.spend ?? {}, e = config.spendEnv ?? {};
  const capUsd = c.capUsd ?? e.capUsd ?? config.spendCapUsd, maxWorkers = c.maxWorkers ?? e.maxWorkers ?? config.maxWorkers;
  const capSource: SpendSource = c.capUsd !== undefined ? 'settings' : e.capUsd !== undefined ? 'env' : 'default';
  const maxWorkersSource: SpendSource = c.maxWorkers !== undefined ? 'settings' : e.maxWorkers !== undefined ? 'env' : 'default';
  const warnUsd = c.warnUsd ?? e.warnUsd ?? (config.spendWarnUsd && config.spendWarnUsd > 0 ? config.spendWarnUsd : capUsd > 0 ? Math.round(capUsd * 0.8 * 100) / 100 : 0);
  const warnSource: SpendSource = c.warnUsd !== undefined ? 'settings' : e.warnUsd !== undefined ? 'env' : 'default';
  const mismatches = [c.capUsd !== undefined && e.capUsd !== undefined && c.capUsd !== e.capUsd ? `HELM_SPEND_CAP_USD=${e.capUsd} vs settings.spend.capUsd=${c.capUsd}` : undefined, c.warnUsd !== undefined && e.warnUsd !== undefined && c.warnUsd !== e.warnUsd ? `HELM_SPEND_WARN_USD=${e.warnUsd} vs settings.spend.warnUsd=${c.warnUsd}` : undefined, c.maxWorkers !== undefined && e.maxWorkers !== undefined && c.maxWorkers !== e.maxWorkers ? `HELM_MAX_WORKERS=${e.maxWorkers} vs settings.spend.maxWorkers=${c.maxWorkers}` : undefined].filter((value): value is string => value !== undefined);
  return {
    capUsd, warnUsd, maxWorkers,
    sources: { capUsd: capSource, warnUsd: warnSource, maxWorkers: maxWorkersSource },
    ...(mismatches.length > 0 ? { warning: `environment spend setting differs from helm.json: ${mismatches.join('; ')}` } : {}),
  };
}
/** Create the home directory tree. Lazy: called by whoever needs it to exist. */
export function ensureHome(config: HelmConfig): void {
  for (const dir of [config.home, join(config.home, 'worktrees'), join(config.home, 'logs'), join(config.home, 'sessions')]) {
    mkdirSync(dir, { recursive: true });
  }
}
