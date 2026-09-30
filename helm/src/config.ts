/** $HELM_HOME, spend cap, worker/gate limits. See DESIGN.md. */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HelmConfig, SpendLimitName, SpendLimitRow, SpendLimitSource, Store } from './types.js';
import { loadSettings, readSettingsFile, type Settings } from './settings.js';
export type SpendSource = SpendLimitSource;
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
  const c = settings.spend ?? {}, e = config.spendEnv ?? {}, capUsd = c.capUsd ?? e.capUsd ?? config.spendCapUsd, maxWorkers = c.maxWorkers ?? e.maxWorkers ?? config.maxWorkers;
  const capSource: SpendSource = c.capUsd !== undefined ? 'settings' : e.capUsd !== undefined ? 'env' : 'default', maxWorkersSource: SpendSource = c.maxWorkers !== undefined ? 'settings' : e.maxWorkers !== undefined ? 'env' : 'default';
  const warnUsd = c.warnUsd ?? e.warnUsd ?? (config.spendWarnUsd && config.spendWarnUsd > 0 ? config.spendWarnUsd : capUsd > 0 ? Math.round(capUsd * 0.8 * 100) / 100 : 0), warnSource: SpendSource = c.warnUsd !== undefined ? 'settings' : e.warnUsd !== undefined ? 'env' : 'default';
  const mismatches = [c.capUsd !== undefined && e.capUsd !== undefined && c.capUsd !== e.capUsd ? `HELM_SPEND_CAP_USD=${e.capUsd} vs settings.spend.capUsd=${c.capUsd}` : undefined, c.warnUsd !== undefined && e.warnUsd !== undefined && c.warnUsd !== e.warnUsd ? `HELM_SPEND_WARN_USD=${e.warnUsd} vs settings.spend.warnUsd=${c.warnUsd}` : undefined, c.maxWorkers !== undefined && e.maxWorkers !== undefined && c.maxWorkers !== e.maxWorkers ? `HELM_MAX_WORKERS=${e.maxWorkers} vs settings.spend.maxWorkers=${c.maxWorkers}` : undefined].filter((value): value is string => value !== undefined);
  return { capUsd, warnUsd, maxWorkers, sources: { capUsd: capSource, warnUsd: warnSource, maxWorkers: maxWorkersSource }, ...(mismatches.length > 0 ? { warning: `environment spend setting differs from helm.json: ${mismatches.join('; ')}` } : {}) };
}
const spendNames: SpendLimitName[] = ['capUsd', 'warnUsd', 'maxWorkers'];
const infinityValue = (value: number): number => value === 0 ? Number.POSITIVE_INFINITY : value;
export const spendLimitRaises = (next: number, current: number): boolean => infinityValue(next) > infinityValue(current);
function rowsSpend(rows: readonly SpendLimitRow[], fallback: EffectiveSpend): EffectiveSpend { const byName = new Map(rows.map((row) => [row.name, row])); const value = (name: SpendLimitName) => byName.get(name)?.value ?? fallback[name]; const source = (name: SpendLimitName) => byName.get(name)?.source ?? fallback.sources[name]; return { capUsd: value('capUsd'), warnUsd: value('warnUsd'), maxWorkers: value('maxWorkers'), sources: { capUsd: source('capUsd'), warnUsd: source('warnUsd'), maxWorkers: source('maxWorkers') } }; }
const limitRows = (spend: EffectiveSpend, at: string, source: (name: SpendLimitName) => SpendLimitSource, tapId: string | null = null): SpendLimitRow[] => spendNames.map((name) => ({ name, value: spend[name], source: source(name), at, tapId }));
export function createEffectiveSpendReader(config: HelmConfig, store: Store, initial: Settings = loadSettings(config.home), now = () => new Date()): () => EffectiveSpend {
  const file = readSettingsFile(config.home), bootstrap = effectiveSpend(config, file.settings ?? initial);
  let rows = store.getSpendLimits();
  if (rows.length === 0) { rows = limitRows(bootstrap, now().toISOString(), (name) => bootstrap.sources[name]); store.setSpendLimits(rows); }
  let cached = rowsSpend(rows, bootstrap), lastSignature = rows.length > 0 || file.error ? '' : file.signature, previousFileSpend = file.settings?.spend ?? {}, warning = bootstrap.warning;
  return () => {
    const currentFile = readSettingsFile(config.home);
    if (currentFile.signature === lastSignature) return warning ? { ...cached, warning } : cached;
    lastSignature = currentFile.signature;
    if (currentFile.error) { store.appendEvent('project:global', 'spend.warning', { project: 'global', reason: 'invalid helm.json; retaining last good spend limits', detail: currentFile.error }); return warning ? { ...cached, warning } : cached; }
    const nextFileSpend = currentFile.settings?.spend ?? {}, names = spendNames.filter((name) => previousFileSpend[name] !== undefined || nextFileSpend[name] !== undefined), next = { ...cached }, nextSources = { ...cached.sources };
    for (const name of names) {
      const desired = nextFileSpend[name] ?? 0;
      const raises = name === 'warnUsd' ? desired > cached[name] : spendLimitRaises(desired, cached[name]);
      if (raises) {
        store.appendEvent('project:global', 'spend.changed', { project: 'global', name, value: desired, effective: cached[name], ignored: true, reason: 'raise requires helm cap with a tap' });
      } else if (name === 'warnUsd' ? cached[name] > desired : spendLimitRaises(cached[name], desired)) { next[name] = desired; nextSources[name] = 'settings'; store.appendEvent('project:global', 'spend.changed', { project: 'global', name, value: desired, source: 'file' }); }
    }
    cached = { ...next, sources: nextSources }; previousFileSpend = nextFileSpend; warning = effectiveSpend(config, currentFile.settings ?? initial).warning;
    return warning ? { ...cached, warning } : cached;
  };
}
/** Create the home directory tree. Lazy: called by whoever needs it to exist. */
export function ensureHome(config: HelmConfig): void {
  for (const dir of [config.home, join(config.home, 'worktrees'), join(config.home, 'logs'), join(config.home, 'sessions')]) {
    mkdirSync(dir, { recursive: true });
  }
}
