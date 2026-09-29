import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Store } from './types.js';

export const DEFAULT_RULES = 'Work only in the assigned worktree. Outside the autonomy envelope: production data or migrations, spending money, deleting data, secrets, merging or force-pushing main, and provider settings.';
const DEFAULT_DEPLOY = { prod: 'tap' as const, staging: 'tap' as const, preview: 'tap' as const };
const DEFAULT_TAP_ONLY = ['deploy.prod', 'convex.migration', 'dependency.major', 'external.message', 'skill.merge', 'merge.unreviewed'];
const envelopeSchema = z.object({
  rules: z.array(z.string().min(1)),
  budget: z.object({ maxSprintUsd: z.number().nonnegative(), maxSprintCodexTokens: z.number().int().nonnegative() }),
  deploy: z.record(z.string(), z.enum(['auto', 'tap', 'never'])),
  tapOnly: z.array(z.string().min(1)),
}).strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export type EnvelopeView = Readonly<{ rules: string[]; summary: string; hash: string }>;
export const defaultEnvelope = (): Envelope => ({ rules: [DEFAULT_RULES], budget: { maxSprintUsd: 25, maxSprintCodexTokens: 20_000_000 }, deploy: { ...DEFAULT_DEPLOY }, tapOnly: [...DEFAULT_TAP_ONLY] });

function projectPath(home: string, project: string): string {
  const match = /^([^/]+)\/([^/]+)$/.exec(project);
  const valid = match && [match[1], match[2]].every((part): part is string => typeof part === 'string' && part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/.test(part));
  if (!valid) throw new Error(`invalid project: ${project}; expected owner/name`);
  const projectsRoot = resolve(home, 'projects');
  const path = resolve(projectsRoot, `${match[1]}__${match[2]}`, 'envelope.json');
  if (!path.startsWith(`${projectsRoot}${sep}`)) throw new Error(`invalid project path: ${project}`);
  return path;
}
export function envelopePath(home: string, project: string): string { return projectPath(home, project); }
function digest(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function summary(value: Envelope): string { return `budget $${value.budget.maxSprintUsd}/${value.budget.maxSprintCodexTokens} tokens; deploy ${Object.entries(value.deploy).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}; tap-only ${value.tapOnly.join(', ') || 'none'}`; }

export function readEnvelope(home: string, project: string, log: (line: string) => void = console.error): EnvelopeView {
  let path: string;
  try { path = envelopePath(home, project); } catch { const value = defaultEnvelope(); return { rules: value.rules, summary: summary(value), hash: digest(JSON.stringify(value)) }; }
  let raw: string | undefined;
  try { raw = readFileSync(path, 'utf8'); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`invalid envelope ${path}; using defaults`); }
  const parsed = raw === undefined ? undefined : (() => { try { return envelopeSchema.safeParse(JSON.parse(raw)); } catch { return undefined; } })();
  const value = parsed?.success ? parsed.data : defaultEnvelope();
  if (raw !== undefined && !parsed?.success) log(`invalid envelope ${path}; using defaults`);
  return { rules: value.rules, summary: summary(value), hash: digest(raw ?? JSON.stringify(value)) };
}

function envelopeValue(home: string, project: string, log: (line: string) => void = console.error): Envelope {
  const path = envelopePath(home, project);
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (parsed.success) return parsed.data;
  } catch { /* fall through to the safe default */ }
  if (existsSync(path)) log(`invalid envelope ${path}; using defaults`);
  return defaultEnvelope();
}

export function envelopeBudgetGuard(home: string, input: { project: string; capUsd: number; codexTokens?: number }, consumeTap: () => boolean = () => false): string | null {
  const value = envelopeValue(home, input.project);
  if (input.codexTokens === undefined) return `codexTokens required; max ${value.budget.maxSprintCodexTokens}`;
  if (consumeTap()) return null;
  if (input.capUsd > value.budget.maxSprintUsd) return `budget.open exceeds envelope maxSprintUsd limit (${value.budget.maxSprintUsd})`;
  if (input.codexTokens > value.budget.maxSprintCodexTokens) return `budget.open exceeds envelope maxSprintCodexTokens limit (${value.budget.maxSprintCodexTokens})`;
  return null;
}

export function createEnvelopeTicker(options: { store: Store; home: string; log?: (line: string) => void }): () => Promise<void> {
  const seen = new Map<string, string>();
  return async () => {
    const root = resolve(options.home, 'projects');
    let projects: string[] = [];
    try { projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return; }
    for (const encoded of projects) {
      const project = encoded.replace('__', '/');
      let path: string;
      try { path = envelopePath(options.home, project); } catch { continue; }
      const hash = existsSync(path) ? digest(readFileSync(path)) : 'default';
      if (seen.has(project) && seen.get(project) !== hash) options.store.appendEvent(`project:${project}`, 'envelope.changed', { project, hash });
      seen.set(project, hash);
    }
  };
}
