/** Daemon-level v4 settings and env-file loading. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const JEV_DEFAULTS = { shadow: true, model: 'jev-latest', triageHumanAt: 0.3, attentionAt: 0.4, timeoutMs: 5000 };
const WAKE_DEFAULTS = { minIntervalSec: 120, maxPerHour: 20 };
const WATCH_DEFAULTS = { tickSec: 60, silenceMin: 15, sameRefusal: 5, attentionEverySec: 180, cooldownMin: 15 };
const DISCORD_DEFAULTS = { projects: {}, digestSec: 60, maxPerHour: 20 };

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
  discord: z.object({
    projects: z.record(z.string(), z.object({ webhookEnv: z.string() })).default({}),
    digestSec: z.number().default(60),
    maxPerHour: z.number().default(20),
  }).default(DISCORD_DEFAULTS),
});

export type Settings = z.infer<typeof settingsSchema>;

const DEFAULT_SETTINGS = settingsSchema.parse({});

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
  return parsed.data;
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
