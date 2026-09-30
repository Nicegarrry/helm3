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

export type ModelCatalog = Readonly<{
  availability(model: string): Promise<{ available: boolean; reason?: string }>;
  check(settings: Settings, now?: Date): Promise<RoutingCheckReport>;
}>;

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

async function defaultCodexProbe(modelId: string): Promise<boolean> {
  try {
    await exec('codex', ['exec', '-m', modelId, '--help'], { timeout: 10_000 });
    return true;
  } catch { return false; }
}

async function defaultCodexModels(): Promise<readonly string[]> {
  try {
    const { stdout } = await exec('codex', ['models', '--json'], { timeout: 10_000 });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((model) => typeof model === 'string' ? [`codex/${model}`] : model && typeof model === 'object' && typeof (model as Record<string, unknown>).id === 'string' ? [`codex/${String((model as Record<string, unknown>).id)}`] : []);
  } catch { return []; }
}

async function defaultPiProbe(provider: string, modelId: string): Promise<boolean> {
  try {
    const { defaultModelRuntime } = await import('../worker.js');
    return Boolean((await defaultModelRuntime()).getModel(provider, modelId));
  } catch { return false; }
}

async function defaultClaudeProbe(): Promise<boolean> {
  try { await exec('which', ['claude'], { timeout: 2_000 }); return true; } catch { return false; }
}

export function createModelCatalog(options: { getSettings?: () => Settings; probe?: CatalogProbe; claudeLaneRegistered?: boolean }): ModelCatalog {
  const cache = new Map<string, Promise<{ available: boolean; reason?: string }>>();
  const probe = options.probe ?? {};
  const getSettings = options.getSettings ?? (() => { throw new Error('routing catalog settings are not configured'); });

  async function availability(model: string): Promise<{ available: boolean; reason?: string }> {
    const cached = cache.get(model);
    if (cached) return cached;
    const pending = (async () => {
      if (model.startsWith('claude/')) {
        if (!options.claudeLaneRegistered) return { available: false, reason: 'no worker lane for claude' };
        const available = await (probe.claude ?? defaultClaudeProbe)();
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
    cache.set(model, pending);
    return pending;
  }

  async function modelsForLane(lane: RoutingLane): Promise<readonly string[]> {
    if (probe.models) return probe.models(lane);
    if (lane === 'codex') return defaultCodexModels();
    if (lane === 'pi') {
      return [...new Set([
        ...piModelsFromJson(readJson(join(homedir(), '.pi', 'agent', 'models.json'))),
        ...piBuiltInModels(),
      ])];
    }
    return [];
  }

  return {
    availability,
    async check(settings, now = new Date()) {
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
