/** Daemon-level v4 settings and env-file loading. */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const JEV_DEFAULTS = { shadow: true, model: 'jev-latest', triageHumanAt: 0.3, attentionAt: 0.4, timeoutMs: 5000 };
const WAKE_DEFAULTS = { minIntervalSec: 120, maxPerHour: 20 };
const WATCH_DEFAULTS = { tickSec: 60, silenceMin: 15, sameRefusal: 5, attentionEverySec: 180, cooldownMin: 15 };
const BUDGET_DEFAULTS = { defaultCapUsd: 25, defaultCodexTokens: 20_000_000 };
const FACTORY_DEFAULTS = { claims: 'block' as const, claimsAt: 0.7, verdictAt: 0.5, retryMax: 2, envelopeTapAt: 0.5, tapTtlMin: 60 };
const QUEUE_DEFAULTS = { tickSec: 30, checksTimeoutMin: 30 };
const CAPACITY_DEFAULTS = {
  sampleSec: 5,
  reserveGb: 2,
  gbPerUnit: 1,
  units: { light: 1, medium: 2, heavy: 4 },
  pressureWarnPenalty: 1,
  pressureCriticalPenalty: 2,
  simulatorPenalty: 1,
  processHeadroomMinPct: 0.15,
  waitMilestoneMin: 10,
};
const SELECT_DEFAULTS = { skillDirs: ['~/code/skills'], skillAllow: [], autoAt: 0.7, lessons: 'shadow' as const };
const ROUTING_TIERS_DEFAULTS: Record<string, string[]> = {
  1: ['openrouter/qwen/qwen3.8-flash', 'openrouter/deepseek/deepseek-v4.1-flash', 'codex/gpt-6-luna:medium', 'codex/gpt-5.6-luna:medium'],
  2: ['google/gemini-3.8-flash', 'codex/gpt-6-luna:high', 'codex/gpt-5.6-luna:high'],
  3: ['claude/sonnet:high', 'codex/gpt-5.6-terra:high'],
  4: ['codex/gpt-6.1-sol:medium', 'codex/gpt-5.6-sol:medium', 'claude/opus:medium'],
  5: ['codex/gpt-6-astra:high', 'claude/opus:high', 'claude/fable:high', 'codex/gpt-6.1-sol:high', 'codex/gpt-5.6-sol:high'],
};
const ROUTING_DEFAULTS = {
  tiers: ROUTING_TIERS_DEFAULTS,
  allowed: Object.values(ROUTING_TIERS_DEFAULTS).flat(), minClean: 0.5, minN: 8,
  policy: { subscriptionOnly: false }, checkDays: 7,
};
const DISCORD_DEFAULTS = { projects: {}, digestSec: 60, maxPerHour: 20 };
const DEPLOY_DEFAULTS = { smokeEnv: [] as string[] };
const HYGIENE_DEFAULTS = { keepNodeModules: false, gcSec: 600, worktreeTtlHours: 24, minFreeGb: 15 };

const settingsSchema = z.object({
  jev: z.object({
    shadow: z.boolean().default(true),
    model: z.string().default('jev-latest'),
    triageHumanAt: z.number().default(0.3),
    attentionAt: z.number().default(0.4),
    timeoutMs: z.number().default(5000),
  }).default(JEV_DEFAULTS),
  wake: z.object({
    minIntervalSec: z.number().default(120),
    maxPerHour: z.number().default(20),
  }).default(WAKE_DEFAULTS),
  watch: z.object({
    tickSec: z.number().default(60),
    silenceMin: z.number().default(15),
    sameRefusal: z.number().default(5),
    attentionEverySec: z.number().default(180),
    cooldownMin: z.number().default(15),
  }).default(WATCH_DEFAULTS),
  supervisor: z.object({
    command: z.string().optional(),
    envelope: z.string().optional(),
  }).default({}),
  budgets: z.object({
    defaultCapUsd: z.number().default(25),
    defaultCodexTokens: z.number().int().default(20_000_000),
  }).default(BUDGET_DEFAULTS),
  spend: z.object({ capUsd: z.number().nonnegative().optional(), warnUsd: z.number().nonnegative().optional(), maxWorkers: z.number().int().nonnegative().optional() }).default({}),
  factory: z.object({
    claims: z.enum(['off', 'shadow', 'block']).default('block'),
    claimsAt: z.number().default(0.7),
    verdictAt: z.number().default(0.5),
    retryMax: z.number().int().default(2),
    envelopeTapAt: z.number().default(0.5),
    tapTtlMin: z.number().int().default(60),
  }).default(FACTORY_DEFAULTS),
  queue: z.object({
    tickSec: z.number().default(30),
    checksTimeoutMin: z.number().default(30),
  }).default(QUEUE_DEFAULTS),
  capacity: z.object({
    sampleSec: z.number().positive().default(5),
    reserveGb: z.number().nonnegative().default(4),
    gbPerUnit: z.number().positive().default(2),
    units: z.object({
      light: z.number().positive().default(1),
      medium: z.number().positive().default(2),
      heavy: z.number().positive().default(4),
    }).default(CAPACITY_DEFAULTS.units),
    pressureWarnPenalty: z.number().nonnegative().default(1),
    pressureCriticalPenalty: z.number().nonnegative().default(2),
    simulatorPenalty: z.number().nonnegative().default(1),
    processHeadroomMinPct: z.number().min(0).max(1).default(0.15),
    waitMilestoneMin: z.number().positive().default(10),
  }).default(CAPACITY_DEFAULTS),
  memory: z.object({
    dir: z.string().optional(),
    cg: z.object({ url: z.string(), keyEnv: z.string(), enabled: z.boolean().default(false) }).optional(),
  }).default({}),
  select: z.object({
    skillDirs: z.array(z.string()).default(['~/code/skills']),
    skillAllow: z.array(z.string()).default([]),
    autoAt: z.number().default(0.7),
    lessons: z.enum(['off', 'shadow', 'on']).default('shadow'),
  }).default(SELECT_DEFAULTS),
  routing: z.object({
    tiers: z.record(z.string(), z.array(z.string().min(1))).default(ROUTING_DEFAULTS.tiers),
    allowed: z.array(z.string()).default(ROUTING_DEFAULTS.allowed),
    minClean: z.number().default(0.5),
    minN: z.number().int().default(8),
    policy: z.object({
      lanes: z.array(z.enum(['codex', 'pi', 'claude'])).optional(),
      subscriptionOnly: z.boolean().default(false),
    }).default(ROUTING_DEFAULTS.policy),
    checkDays: z.number().positive().default(7),
  }).default(ROUTING_DEFAULTS),
  discord: z.object({
    projects: z.record(z.string(), z.object({ webhookEnv: z.string() })).default({}),
    digestSec: z.number().default(60),
    maxPerHour: z.number().default(20),
    globalWebhookEnv: z.string().optional(),
    tapWebhookEnv: z.string().optional(),
  }).default(DISCORD_DEFAULTS),
  deploy: z.object({ smokeEnv: z.array(z.string()).default([]) }).default(DEPLOY_DEFAULTS),
  gates: z.object({ allowUnsandboxed: z.boolean().default(false) }).optional(),
  hygiene: z.object({
    keepNodeModules: z.boolean().default(false),
    gcSec: z.number().int().positive().default(600),
    worktreeTtlHours: z.number().positive().default(24),
    minFreeGb: z.number().positive().default(15),
  }).default(HYGIENE_DEFAULTS),
});

type ParsedSettings = z.infer<typeof settingsSchema>;
export type Settings = Omit<ParsedSettings, 'deploy' | 'capacity' | 'routing' | 'gates'> & {
  deploy?: ParsedSettings['deploy'];
  capacity?: ParsedSettings['capacity'];
  gates?: ParsedSettings['gates'];
  routing: Omit<ParsedSettings['routing'], 'policy' | 'checkDays'> & {
    policy?: { lanes?: ('codex' | 'pi' | 'claude')[]; subscriptionOnly?: boolean };
    checkDays?: number;
  };
};

function normalizeSettings(value: ParsedSettings | Settings, capacity?: ParsedSettings['capacity']): Settings {
  // Keep the newly added section available by property access without changing
  // the legacy enumerable shape consumed by older callers and snapshots.
  Object.defineProperty(value, 'capacity', { value: capacity ?? value.capacity, enumerable: false, configurable: true });
  return value as Settings;
}

const DEFAULT_SETTINGS = normalizeSettings(settingsSchema.parse({}));
/** A routing block without `allowed` allows every configured tier candidate. */
function withRoutingDefaults(settings: Settings, raw: unknown): Settings {
  const routingRaw = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).routing : undefined;
  if (routingRaw && typeof routingRaw === 'object' && !Array.isArray(routingRaw) && !Object.hasOwn(routingRaw, 'allowed')) {
    return { ...settings, routing: { ...settings.routing, allowed: Object.values(settings.routing.tiers).flat() } };
  }
  return settings;
}
export function loadSettings(home: string): Settings { const result = readSettingsFile(home); if (result.error) console.error(`invalid ${join(home, 'helm.json')}; using defaults`); return result.settings ?? DEFAULT_SETTINGS; }
function fileSignature(path: string): string { try { const stat = statSync(path); return `${stat.mtimeMs}:${stat.size}:${stat.ino}`; } catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable'; } }
export type SettingsFile = Readonly<{ signature: string; settings?: Settings; error?: string }>;
export function readSettingsFile(home: string): SettingsFile {
  const path = join(home, 'helm.json');
  try { const raw: unknown = JSON.parse(readFileSync(path, 'utf8')); const parsed = settingsSchema.safeParse(raw); if (!parsed.success) return { signature: fileSignature(path), error: 'schema validation failed' }; const settings = withRoutingDefaults(parsed.data as Settings, raw); return { signature: fileSignature(path), settings: normalizeSettings(settings, parsed.data.capacity) }; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { signature: 'missing', settings: DEFAULT_SETTINGS } : { signature: fileSignature(path), error: 'invalid JSON' }; }
}
export type SpendSettingsUpdate = Readonly<{ capUsd?: number; warnUsd?: number; maxWorkers?: number }>;
/** Merge spend settings into helm.json and replace it with a same-directory atomic rename. */
export function updateSpendSettings(home: string, update: SpendSettingsUpdate): Settings {
  mkdirSync(home, { recursive: true }); const path = join(home, 'helm.json'); let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid ${path}; expected an object`);
    raw = { ...(parsed as Record<string, unknown>) };
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const spend = raw.spend && typeof raw.spend === 'object' && !Array.isArray(raw.spend) ? { ...(raw.spend as Record<string, unknown>) } : {}; for (const [key, value] of Object.entries(update)) if (value !== undefined) spend[key] = value; raw.spend = spend; const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, 'utf8'); renameSync(temporary, path); }
  catch (err) { try { unlinkSync(temporary); } catch { /* best effort */ } throw err; }
  return loadSettings(home);
}
export function loadEnvFile(path: string): Record<string, string> {
  try {
    const values: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      if (!key) continue;
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}
