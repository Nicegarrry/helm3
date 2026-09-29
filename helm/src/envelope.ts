import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
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
export const BUDGET_TAP_ACTION = 'budget.open';
export type TapPostResult = { ok: true } | { ok: false; reason: string };
export type TapRow = Readonly<{ id: string; project: string; kind: string; action: string; actionHash: string; codeHash: string; state: 'pending' | 'granted' | 'used' | 'denied' | 'expired'; attempts: number; requestedAt: string; grantedAt: string | null; usedAt: string | null; expiresAt: string }>;
export type TapMemory = { project: string; kind: string; actionHash: string; codeMac: string; attempts: number; expiresAt: string; state: 'pending' | 'granted' };

export function actionHash(action: string): string { return digest(action); }
export function budgetTapAction(input: { project: string; label: string; capUsd: number; codexTokens: number }): string {
  return `${BUDGET_TAP_ACTION}:${input.project}:${input.label}:${input.capUsd}:${input.codexTokens}`;
}

export function ensureTapTable(store: Store): void {
  store.sql.exec(`CREATE TABLE IF NOT EXISTS taps (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
    actionHash TEXT NOT NULL, codeHash TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL,
    requestedAt TEXT NOT NULL, grantedAt TEXT, usedAt TEXT, expiresAt TEXT NOT NULL
  )`);
}

export function expireTapsOnStartup(store: Store): void {
  ensureTapTable(store);
  store.sql.exec("UPDATE taps SET state = 'expired' WHERE state IN ('pending', 'granted')");
}

export async function requestTap(store: Store, input: { project: string; kind: string; action: string }, options: { taps: Map<string, TapMemory>; ttlMin: number; post: (content: string) => Promise<TapPostResult>; pepper: Buffer; now?: () => Date; randomInt?: (min: number, max: number) => number }): Promise<{ ok: true; id: string; expiresAt: string } | { ok: false; reason: string }> {
  ensureTapTable(store);
  const now = options.now ?? (() => new Date());
  const requestedAt = now();
  const id = `t-${randomBytes(8).toString('hex')}`;
  const expiresAt = new Date(requestedAt.getTime() + options.ttlMin * 60_000).toISOString();
  const code = String((options.randomInt ?? randomInt)(100_000, 1_000_000));
  const codeMac = tapCodeHash(options.pepper, id, code);
  const message = `Tap needed for ${input.project}: ${input.action}. Tell your supervisor: tap ${id} ${code}`;
  if (message.length > 2_000) return { ok: false, reason: 'tap action too long' };
  options.taps.set(id, { project: input.project, kind: input.kind, actionHash: actionHash(input.action), codeMac, attempts: 0, expiresAt, state: 'pending' });
  try {
    store.sql.prepare('INSERT INTO taps (id, project, kind, action, actionHash, codeHash, state, attempts, requestedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(id, input.project, input.kind, input.action, actionHash(input.action), codeMac, 'pending', requestedAt.toISOString(), expiresAt);
    const posted = await options.post(message);
    if (!posted.ok) throw new Error(posted.reason === 'no tap channel configured' || posted.reason === 'tap channel must differ from the milestone channel' ? posted.reason : 'tap channel post failed');
  } catch (error) {
    options.taps.delete(id);
    store.sql.prepare('DELETE FROM taps WHERE id = ?').run(id);
    const reason = error instanceof Error ? error.message : '';
    return { ok: false, reason: reason === 'no tap channel configured' || reason === 'tap channel must differ from the milestone channel' ? reason : 'tap channel post failed' };
  }
  return { ok: true, id, expiresAt };
}

export function confirmTap(store: Store, taps: Map<string, TapMemory>, input: { id: string; code: string }, pepper: Buffer, now = new Date()): { ok: true; granted: true } | { ok: false; reason: string } {
  ensureTapTable(store);
  const tap = taps.get(input.id);
  if (!tap) return { ok: false, reason: 'unknown or expired tap (daemon restarted?)' };
  if (tap.state !== 'pending') return { ok: false, reason: `tap is ${tap.state}` };
  if (Date.parse(tap.expiresAt) <= now.getTime()) {
    taps.delete(input.id);
    store.sql.prepare("UPDATE taps SET state = 'expired' WHERE id = ?").run(input.id);
    return { ok: false, reason: 'tap expired' };
  }
  const expected = Buffer.from(tap.codeMac, 'hex');
  const actual = Buffer.from(tapCodeHash(pepper, input.id, input.code), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    tap.attempts += 1;
    if (tap.attempts >= 3) {
      taps.delete(input.id);
      store.sql.prepare("UPDATE taps SET attempts = ?, state = 'denied' WHERE id = ?").run(tap.attempts, input.id);
      return { ok: false, reason: 'tap denied' };
    }
    store.sql.prepare("UPDATE taps SET attempts = ? WHERE id = ?").run(tap.attempts, input.id);
    return { ok: false, reason: 'incorrect tap code' };
  }
  tap.state = 'granted';
  store.sql.prepare("UPDATE taps SET state = 'granted', grantedAt = ?, attempts = ? WHERE id = ?").run(now.toISOString(), tap.attempts, input.id);
  return { ok: true, granted: true };
}

export function consumeTap(store: Store, taps: Map<string, TapMemory>, project: string, kind: string, expectedActionHash: string, tapId?: string, now = new Date()): string | null {
  ensureTapTable(store);
  const selected = tapId
    ? [tapId, taps.get(tapId)] as const
    : [...taps.entries()].find(([, entry]) => entry.project === project && entry.kind === kind && entry.actionHash === expectedActionHash && entry.state === 'granted');
  const id = selected?.[0];
  const tap = selected?.[1];
  if (!tap || !id) return 'unknown or expired tap (daemon restarted?)';
  if (tap.project !== project || tap.kind !== kind || tap.actionHash !== expectedActionHash) return 'tap does not match requested action';
  if (tap.state !== 'granted') return `tap is ${tap.state}`;
  if (Date.parse(tap.expiresAt) <= now.getTime()) {
    taps.delete(id);
    store.sql.prepare("UPDATE taps SET state = 'expired' WHERE id = ?").run(id);
    return 'tap expired';
  }
  taps.delete(id);
  store.sql.prepare("UPDATE taps SET state = 'used', usedAt = ? WHERE id = ?").run(now.toISOString(), id);
  return null;
}

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
function tapCodeHash(pepper: Buffer, id: string, code: string): string { return createHmac('sha256', pepper).update(`${id}:${code}`).digest('hex'); }
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

export function envelopeBudgetGuard(home: string, input: { project: string; label?: string; capUsd: number; codexTokens?: number; tapId?: string }, consumeTap: ((project: string, kind: string, expectedActionHash: string, tapId?: string) => string | null | boolean) | (() => boolean) = () => false): string | null {
  const value = envelopeValue(home, input.project);
  if (input.codexTokens === undefined) return `codexTokens required; max ${value.budget.maxSprintCodexTokens}`;
  const limitReason = input.capUsd > value.budget.maxSprintUsd
    ? `budget.open exceeds envelope maxSprintUsd limit (${value.budget.maxSprintUsd})`
    : input.codexTokens > value.budget.maxSprintCodexTokens
      ? `budget.open exceeds envelope maxSprintCodexTokens limit (${value.budget.maxSprintCodexTokens})` : null;
  if (!limitReason) return null;
  if (input.tapId) {
    const result = consumeTap(input.project, BUDGET_TAP_ACTION, actionHash(budgetTapAction({ project: input.project, label: input.label ?? '', capUsd: input.capUsd, codexTokens: input.codexTokens })), input.tapId);
    if (result === null || result === true) return null;
    return typeof result === 'string' ? result : limitReason;
  }
  return limitReason;
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
