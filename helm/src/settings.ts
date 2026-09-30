/** Daemon-level v4 settings and env-file loading. */
import { readFileSync } from 'node:fs';
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
  reserveGb: 4,
  gbPerUnit: 2,
  units: { light: 1, medium: 2, heavy: 4 },
  pressureWarnPenalty: 1,
  pressureCriticalPenalty: 2,
  simulatorPenalty: 1,
  waitMilestoneMin: 10,
};
const SELECT_DEFAULTS = { skillDirs: ['~/code/skills'], skillAllow: [], autoAt: 0.7, lessons: 'shadow' as const };
const ROUTING_DEFAULTS = {
  table: { trivial: 'codex/gpt-5.6-luna:medium', small: 'codex/gpt-5.6-luna:medium', medium: 'codex/gpt-5.6-luna:medium', large: 'codex/gpt-5.6-luna:high' },
  allowed: ['codex/gpt-5.6-luna:medium', 'codex/gpt-5.6-luna:high'], minClean: 0.5, minN: 8,
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
    table: z.record(z.string(), z.string()).default(ROUTING_DEFAULTS.table),
    allowed: z.array(z.string()).default(ROUTING_DEFAULTS.allowed),
    minClean: z.number().default(0.5),
    minN: z.number().int().default(8),
  }).default(ROUTING_DEFAULTS),
  discord: z.object({
    projects: z.record(z.string(), z.object({ webhookEnv: z.string() })).default({}),
    digestSec: z.number().default(60),
    maxPerHour: z.number().default(20),
    tapWebhookEnv: z.string().optional(),
  }).default(DISCORD_DEFAULTS),
  deploy: z.object({ smokeEnv: z.array(z.string()).default([]) }).default(DEPLOY_DEFAULTS),
  hygiene: z.object({
    keepNodeModules: z.boolean().default(false),
    gcSec: z.number().int().positive().default(600),
    worktreeTtlHours: z.number().positive().default(24),
    minFreeGb: z.number().positive().default(15),
  }).default(HYGIENE_DEFAULTS),
});

type ParsedSettings = z.infer<typeof settingsSchema>;
export type Settings = Omit<ParsedSettings, 'deploy' | 'capacity'> & { deploy?: ParsedSettings['deploy']; capacity?: ParsedSettings['capacity'] };

function normalizeSettings(value: ParsedSettings): Settings {
  // Keep the newly added section available by property access without changing
  // the legacy enumerable shape consumed by older callers and snapshots.
  Object.defineProperty(value, 'capacity', { value: value.capacity, enumerable: false, configurable: true });
  return value;
}

const DEFAULT_SETTINGS = normalizeSettings(settingsSchema.parse({}));

export function loadSettings(home: string): Settings {
  const path = join(home, 'helm.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SETTINGS;
    console.error(`invalid ${path}; using defaults`);
    return DEFAULT_SETTINGS;
  }
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`invalid ${path}; using defaults`);
    return DEFAULT_SETTINGS;
  }
  return normalizeSettings(parsed.data);
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
