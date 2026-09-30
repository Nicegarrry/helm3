/** $HELM_HOME, spend cap, worker/gate limits. See DESIGN.md. */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HelmConfig, SpendLimitName, SpendLimitRow, SpendLimitSource, SpendLimitState, Store } from './types.js';
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
export type SpendLimitInput = Partial<Record<SpendLimitName, number>>;
export type EffectiveSpendReader = (() => EffectiveSpend) & { applySpendSet(input: SpendLimitInput, at: string, tapId: string | null): void };
function rowsSpend(rows: readonly SpendLimitRow[], fallback: EffectiveSpend): EffectiveSpend { const byName = new Map(rows.map((row) => [row.name, row])); const value = (name: SpendLimitName) => byName.get(name)?.value ?? fallback[name]; const source = (name: SpendLimitName) => byName.get(name)?.source ?? fallback.sources[name]; return { capUsd: value('capUsd'), warnUsd: value('warnUsd'), maxWorkers: value('maxWorkers'), sources: { capUsd: source('capUsd'), warnUsd: source('warnUsd'), maxWorkers: source('maxWorkers') } }; }
const limitRows = (spend: EffectiveSpend, at: string, source: (name: SpendLimitName) => SpendLimitSource, tapId: string | null = null): SpendLimitRow[] => spendNames.map((name) => ({ name, value: spend[name], source: source(name), at, tapId }));
const spendMetric = (name: SpendLimitName, value: number): number => name === 'warnUsd' ? value : infinityValue(value);
const spendValueRaises = (name: SpendLimitName, next: number, current: number): boolean => spendMetric(name, next) > spendMetric(name, current);
const lowerSpendValue = (name: SpendLimitName, left: number, right: number): number => spendMetric(name, left) <= spendMetric(name, right) ? left : right;
const spendValues = (rows: readonly SpendLimitRow[]): Record<SpendLimitName, number> => Object.fromEntries(rows.map((row) => [row.name, row.value])) as Record<SpendLimitName, number>;
const spendLimitChecksum = (rows: readonly SpendLimitRow[]): string => JSON.stringify(spendNames.map((name) => { const row = rows.find((candidate) => candidate.name === name); return [name, row?.value, row?.source, row?.at, row?.tapId]; }));
const spendState = (rows: readonly SpendLimitRow[], at: string): SpendLimitState => ({ checksum: spendLimitChecksum(rows), rows, at });
const fileSpendValue = (settings: Settings | undefined, name: SpendLimitName): number | undefined => settings?.spend?.[name];
function startupRows(bootstrap: EffectiveSpend, actual: readonly SpendLimitRow[], state: SpendLimitState | undefined, at: string): SpendLimitRow[] {
  const actualByName = new Map(actual.map((row) => [row.name, row]));
  const knownByName = new Map((state?.rows ?? actual).map((row) => [row.name, row]));
  return spendNames.map((name) => {
    const actualRow = actualByName.get(name), knownRow = knownByName.get(name);
    const value = state && knownRow ? lowerSpendValue(name, actualRow?.value ?? bootstrap[name], knownRow.value) : actualRow?.value ?? bootstrap[name];
    const template = actualRow && actualRow.value === value ? actualRow : knownRow;
    return { name, value, source: template?.source ?? bootstrap.sources[name], at: template?.at ?? at, tapId: template?.tapId ?? null };
  });
}
export function createEffectiveSpendReader(config: HelmConfig, store: Store, initial: Settings = loadSettings(config.home), now = () => new Date()): EffectiveSpendReader {
  const file = readSettingsFile(config.home), bootstrap = effectiveSpend(config, file.settings ?? initial), actualRows = store.getSpendLimits(), previousState = store.getSpendLimitState(), at = now().toISOString();
  const tampered = previousState !== undefined && spendLimitChecksum(actualRows) !== previousState.checksum;
  let rows = startupRows(bootstrap, actualRows, previousState, at);
  const fileChanges: Array<{ name: SpendLimitName; value: number }> = [];
  for (const name of spendNames) {
    const desired = fileSpendValue(file.settings, name), current = rows.find((row) => row.name === name)!.value;
    if (desired !== undefined && !spendValueRaises(name, desired, current) && spendValueRaises(name, current, desired)) {
      rows = rows.map((row) => row.name === name ? { ...row, value: desired, source: 'file', at, tapId: null } : row);
      fileChanges.push({ name, value: desired });
    }
  }
  const actualChecksum = spendLimitChecksum(actualRows), finalChecksum = spendLimitChecksum(rows);
  if (previousState === undefined || actualChecksum !== previousState.checksum || finalChecksum !== actualChecksum) { store.setSpendLimits(rows); store.setSpendLimitState(spendState(rows, at)); }
  store.appendEvent('project:global', 'spend.changed', { project: 'global', source: 'startup', values: spendValues(rows), ...(tampered ? { previous: spendValues(previousState!.rows), tampered: true } : {}) }, at);
  let cached = rowsSpend(rows, bootstrap), lastSignature = file.error ? '' : file.signature, previousFileSpend = file.settings?.spend ?? {}, warning = bootstrap.warning;
  const read = (() => {
    const readSpend = (): EffectiveSpend => {
      const currentFile = readSettingsFile(config.home);
      if (currentFile.signature === lastSignature) return warning ? { ...cached, warning } : cached;
      lastSignature = currentFile.signature;
      if (currentFile.error) { store.appendEvent('project:global', 'spend.warning', { project: 'global', reason: 'invalid helm.json; retaining last good spend limits', detail: currentFile.error }); return warning ? { ...cached, warning } : cached; }
      const nextFileSpend = currentFile.settings?.spend ?? {}, names = spendNames.filter((name) => previousFileSpend[name] !== undefined || nextFileSpend[name] !== undefined), nextRows = [...rows], lowered: Array<{ name: SpendLimitName; value: number }> = [];
      for (const name of names) {
        const desired = nextFileSpend[name] ?? 0, current = nextRows.find((row) => row.name === name)!.value;
        if (spendValueRaises(name, desired, current)) store.appendEvent('project:global', 'spend.changed', { project: 'global', name, value: desired, effective: current, ignored: true, reason: 'raise requires helm cap with a tap' });
        else if (spendValueRaises(name, current, desired)) { const index = nextRows.findIndex((row) => row.name === name); nextRows[index] = { ...nextRows[index]!, value: desired, source: 'file', at: now().toISOString(), tapId: null }; lowered.push({ name, value: desired }); }
      }
      if (lowered.length > 0) { rows = nextRows; const changedAt = now().toISOString(); store.setSpendLimits(rows); store.setSpendLimitState(spendState(rows, changedAt)); for (const change of lowered) store.appendEvent('project:global', 'spend.changed', { project: 'global', name: change.name, value: change.value, source: 'file' }, changedAt); }
      cached = rowsSpend(rows, cached); previousFileSpend = nextFileSpend; warning = effectiveSpend(config, currentFile.settings ?? initial).warning;
      return warning ? { ...cached, warning } : cached;
    };
    return readSpend;
  })() as EffectiveSpendReader;
  read.applySpendSet = (input, changedAt, tapId) => {
    rows = rows.map((row) => input[row.name] === undefined ? row : { ...row, value: input[row.name]!, source: 'spend.set', at: changedAt, tapId });
    cached = rowsSpend(rows, cached); store.setSpendLimits(rows); store.setSpendLimitState(spendState(rows, changedAt));
    const currentFile = readSettingsFile(config.home); lastSignature = currentFile.signature; previousFileSpend = currentFile.settings?.spend ?? {}; warning = effectiveSpend(config, currentFile.settings ?? initial).warning;
  };
  for (const change of fileChanges) store.appendEvent('project:global', 'spend.changed', { project: 'global', name: change.name, value: change.value, source: 'file' }, at);
  return read;
}
/** Create the home directory tree. Lazy: called by whoever needs it to exist. */
export function ensureHome(config: HelmConfig): void {
  for (const dir of [config.home, join(config.home, 'worktrees'), join(config.home, 'logs'), join(config.home, 'sessions')]) {
    mkdirSync(dir, { recursive: true });
  }
}
