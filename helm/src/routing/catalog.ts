import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import type { Settings } from '../settings.js';
import { laneForModel, type RoutingLane } from './policy.js';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

export type CatalogUnavailable = Readonly<{ tier: number; model: string; reason: string }>;
export type CatalogExtra = Readonly<{ lane: RoutingLane; model: string }>;
export type RoutingCheckReport = Readonly<{
  checkedAt: string;
  unavailable?: readonly CatalogUnavailable[];
  extraModels?: readonly CatalogExtra[];
}>;

export type CatalogProbe = Readonly<{
  codex?: (modelId: string) => boolean | Promise<boolean>;
  pi?: (provider: string, modelId: string) => boolean | Promise<boolean>;
  claude?: () => boolean | Promise<boolean>;
  models?: (lane: RoutingLane) => readonly string[] | Promise<readonly string[]>;
}>;

export type CatalogSources = Readonly<{
  codexModels?: () => readonly string[] | Promise<readonly string[]>;
  piModels?: () => readonly string[] | Promise<readonly string[]>;
  claudeAvailable?: () => boolean | Promise<boolean>;
}>;

export type ModelCatalog = Readonly<{
  availability(model: string): Promise<{ available: boolean; reason?: string }>;
  refresh?(settings: Settings): Promise<void>;
  check(settings: Settings, now?: Date): Promise<RoutingCheckReport>;
}>;

export const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;

function modelParts(model: string): { provider: string; id: string } | undefined {
  const separator = model.indexOf('/');
  if (separator <= 0) return undefined;
  return { provider: model.slice(0, separator), id: model.slice(separator + 1).replace(/:[^:]+$/, '') };
}

function tierModels(settings: Settings): string[] {
  return Object.values(settings.routing.tiers).flat();
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function piModelsFromJson(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const result: string[] = [];
  const providers = (value as Record<string, unknown>).providers;
  const source = providers && typeof providers === 'object' && !Array.isArray(providers) ? providers as Record<string, unknown> : value as Record<string, unknown>;
  for (const [provider, raw] of Object.entries(source)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const models = (raw as Record<string, unknown>).models;
    if (Array.isArray(models)) {
      for (const model of models) {
        if (typeof model === 'string') result.push(`${provider}/${model}`);
        else if (model && typeof model === 'object' && typeof (model as Record<string, unknown>).id === 'string') result.push(`${provider}/${(model as Record<string, unknown>).id}`);
      }
    }
    const overrides = (raw as Record<string, unknown>).modelOverrides;
    if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
      for (const model of Object.keys(overrides)) result.push(`${provider}/${model}`);
    }
  }
  return result;
}

function piBuiltInModels(): string[] {
  try {
    const packageJson = require.resolve('@earendil-works/pi-ai/package.json');
    const dataDir = join(dirname(packageJson), 'dist', 'providers', 'data');
    if (!existsSync(dataDir)) return [];
    const result: string[] = [];
    for (const file of readdirSync(dataDir)) {
      if (!file.endsWith('.json')) continue;
      const value = readJson(join(dataDir, file));
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
        const provider = raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).provider === 'string'
          ? String((raw as Record<string, unknown>).provider) : file.replace(/\.json$/, '');
        result.push(`${provider}/${id}`);
      }
    }
    return result;
  } catch { return []; }
}

export function parseCodexModelSlugs(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const models = (value as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (typeof model === 'string') return [model];
    return model && typeof model === 'object' && typeof (model as Record<string, unknown>).slug === 'string'
      ? [String((model as Record<string, unknown>).slug)] : [];
  });
}

async function defaultCodexProbe(modelId: string): Promise<boolean> {
  const { stdout } = await exec('codex', ['debug', 'models'], { timeout: 10_000 });
  const slugs = parseCodexModelSlugs(JSON.parse(stdout) as unknown);
  return slugs.includes(modelId);
}

async function defaultCodexModels(): Promise<readonly string[]> {
  const { stdout } = await exec('codex', ['debug', 'models'], { timeout: 10_000 });
  return parseCodexModelSlugs(JSON.parse(stdout) as unknown).map((slug) => `codex/${slug}`);
}

async function defaultPiProbe(provider: string, modelId: string): Promise<boolean> {
  const { defaultModelRuntime } = await import('../worker.js');
  return Boolean((await defaultModelRuntime()).getModel(provider, modelId));
}

async function defaultClaudeProbe(): Promise<boolean> {
  try { await exec('which', ['claude'], { timeout: 2_000 }); return true; } catch { return false; }
}

export function createModelCatalog(options: { getSettings?: () => Settings; probe?: CatalogProbe; sources?: CatalogSources; home?: string; claudeLaneRegistered?: boolean }): ModelCatalog {
  type Result = { available: boolean; reason?: string };
  type Entry = { at: number; result: Result };
  const cache = new Map<string, Entry>();
  const pending = new Map<string, Promise<Result>>();
  const laneCache = new Map<RoutingLane, { at: number; models: readonly string[] }>();
  const lanePending = new Map<RoutingLane, Promise<readonly string[]>>();
  const probe = options.probe ?? {};
  const sources = options.sources ?? {};
  const home = options.home ?? homedir();
  const getSettings = options.getSettings ?? (() => { throw new Error('routing catalog settings are not configured'); });

  async function availability(model: string, force = false): Promise<Result> {
    const current = Date.now();
    const cached = cache.get(model);
    if (!force && cached && current - cached.at < CATALOG_CACHE_TTL_MS) return cached.result;
    const active = pending.get(model);
    if (active) return active;
    const operation = (async () => {
      if (model.startsWith('claude/')) {
        if (!options.claudeLaneRegistered) return { available: false, reason: 'no worker lane for claude' };
        const available = await (sources.claudeAvailable ?? probe.claude ?? defaultClaudeProbe)();
        return available ? { available: true } : { available: false, reason: 'claude binary is unavailable' };
      }
      const parts = modelParts(model);
      if (!parts) return { available: false, reason: 'model has no provider lane' };
      if (model.startsWith('codex/')) {
        const available = await (probe.codex ?? defaultCodexProbe)(parts.id);
        return available ? { available: true } : { available: false, reason: 'Codex CLI did not accept this model id' };
      }
      const available = await (probe.pi ?? defaultPiProbe)(parts.provider, parts.id);
      return available ? { available: true } : { available: false, reason: 'Pi model cannot be resolved' };
    })();
    pending.set(model, operation);
    try {
      const result = await operation;
      cache.set(model, { at: Date.now(), result });
      return result;
    } catch (error) {
      if (cached) {
        cache.set(model, { at: 0, result: cached.result });
        return cached.result;
      }
      return { available: false, reason: `probe failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      pending.delete(model);
    }
  }

  async function modelsForLane(lane: RoutingLane, force = false): Promise<readonly string[]> {
    const current = Date.now();
    const cached = laneCache.get(lane);
    if (!force && cached && current - cached.at < CATALOG_CACHE_TTL_MS) return cached.models;
    const active = lanePending.get(lane);
    if (active) return active;
    const operation = (async () => {
      if (probe.models) return probe.models(lane);
      if (lane === 'codex') return sources.codexModels ? sources.codexModels() : defaultCodexModels();
      if (lane === 'pi') return sources.piModels ? sources.piModels() : [...new Set([
        ...piModelsFromJson(readJson(join(home, '.pi', 'agent', 'models.json'))),
        ...piBuiltInModels(),
      ])];
      return [];
    })();
    lanePending.set(lane, operation);
    try {
      const result = await operation;
      laneCache.set(lane, { at: Date.now(), models: result });
      return result;
    } catch (error) {
      if (cached) {
        laneCache.set(lane, { at: 0, models: cached.models });
        return cached.models;
      }
      return [];
    } finally {
      lanePending.delete(lane);
    }
  }

  async function refresh(settings: Settings): Promise<void> {
    await Promise.all(tierModels(settings).map((model) => availability(model, true)));
    await Promise.all((['codex', 'pi', 'claude'] as const).map((lane) => modelsForLane(lane, true)));
  }

  return {
    availability,
    refresh,
    async check(settings, now = new Date()) {
      await refresh(settings);
      const candidates = tierModels(settings);
      const unavailable: CatalogUnavailable[] = [];
      for (const [index, model] of candidates.entries()) {
        const result = await availability(model);
        if (!result.available) unavailable.push({ tier: Object.entries(settings.routing.tiers).find(([, models]) => models.includes(model))?.[0] ? Number(Object.entries(settings.routing.tiers).find(([, models]) => models.includes(model))![0]) : index + 1, model, reason: result.reason ?? 'unavailable' });
      }
      const routed = new Set(candidates.map((model) => model.replace(/:[^:]+$/, '')));
      const extraModels: CatalogExtra[] = [];
      for (const lane of ['codex', 'pi', 'claude'] as const) {
        for (const model of await modelsForLane(lane)) {
          if (!routed.has(model.replace(/:[^:]+$/, ''))) extraModels.push({ lane, model });
        }
      }
      return {
        checkedAt: now.toISOString(),
        ...(unavailable.length ? { unavailable } : {}),
        ...(extraModels.length ? { extraModels } : {}),
      };
    },
  };
}

export { laneForModel };
