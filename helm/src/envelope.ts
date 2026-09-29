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
export type TapRow = Readonly<{ id: string; project: string; kind: string; action: string; actionHash: string; codeHash: string; grantMac: string | null; state: 'pending' | 'granted' | 'used' | 'denied' | 'expired'; attempts: number; requestedAt: string; grantedAt: string | null; usedAt: string | null; expiresAt: string }>;

export function actionHash(action: string): string { return digest(action); }
export function budgetTapAction(input: { project: string; label: string; capUsd: number; codexTokens: number }): string {
  return `${BUDGET_TAP_ACTION}:${input.project}:${input.label}:${input.capUsd}:${input.codexTokens}`;
}

export function ensureTapTable(store: Store): void {
  store.sql.exec(`CREATE TABLE IF NOT EXISTS taps (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
    actionHash TEXT NOT NULL, codeHash TEXT NOT NULL, grantMac TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL,
    requestedAt TEXT NOT NULL, grantedAt TEXT, usedAt TEXT, expiresAt TEXT NOT NULL
  )`);
  const columns = store.sql.prepare('PRAGMA table_info(taps)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'grantMac')) store.sql.exec('ALTER TABLE taps ADD COLUMN grantMac TEXT');
}

export function expireTapsOnStartup(store: Store): Set<string> {
  ensureTapTable(store);
  const rows = store.sql.prepare("SELECT id FROM taps WHERE state IN ('pending', 'granted')").all() as Array<{ id: string }>;
  store.sql.exec("UPDATE taps SET state = 'expired' WHERE state IN ('pending', 'granted')");
  return new Set(rows.map((row) => row.id));
}

function tapRow(row: Record<string, unknown>): TapRow {
  return { id: String(row.id), project: String(row.project), kind: String(row.kind), action: String(row.action), actionHash: String(row.actionHash), codeHash: String(row.codeHash), grantMac: row.grantMac ? String(row.grantMac) : null, state: row.state as TapRow['state'], attempts: Number(row.attempts), requestedAt: String(row.requestedAt), grantedAt: row.grantedAt ? String(row.grantedAt) : null, usedAt: row.usedAt ? String(row.usedAt) : null, expiresAt: String(row.expiresAt) };
}

export async function requestTap(store: Store, input: { project: string; kind: string; action: string }, options: { ttlMin: number; post: (content: string) => Promise<TapPostResult>; pepper: Buffer; now?: () => Date; randomInt?: (min: number, max: number) => number }): Promise<{ ok: true; id: string; expiresAt: string } | { ok: false; reason: string }> {
  ensureTapTable(store);
  const now = options.now ?? (() => new Date());
  const requestedAt = now();
  const id = `t-${randomBytes(8).toString('hex')}`;
  const expiresAt = new Date(requestedAt.getTime() + options.ttlMin * 60_000).toISOString();
  const code = String((options.randomInt ?? randomInt)(100_000, 1_000_000));
  const message = `Tap needed for ${input.project}: ${input.action}. Tell your supervisor: tap ${id} ${code}`;
  if (message.length > 2_000) return { ok: false, reason: 'tap action too long' };
  store.sql.prepare('INSERT INTO taps (id, project, kind, action, actionHash, codeHash, state, attempts, requestedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, input.project, input.kind, input.action, actionHash(input.action), tapCodeHash(options.pepper, id, code), 'pending', requestedAt.toISOString(), expiresAt);
  try {
    const posted = await options.post(message);
    if (!posted.ok) throw new Error(posted.reason === 'no tap channel configured' || posted.reason === 'tap channel must differ from the milestone channel' ? posted.reason : 'tap channel post failed');
  } catch (error) {
    store.sql.prepare('DELETE FROM taps WHERE id = ?').run(id);
    const reason = error instanceof Error ? error.message : '';
    return { ok: false, reason: reason === 'no tap channel configured' || reason === 'tap channel must differ from the milestone channel' ? reason : 'tap channel post failed' };
  }
  return { ok: true, id, expiresAt };
}

export function confirmTap(store: Store, input: { id: string; code: string }, pepper: Buffer, now = new Date(), restartExpired: ReadonlySet<string> = new Set<string>()): { ok: true; granted: true } | { ok: false; reason: string } {
  ensureTapTable(store);
  const row = store.sql.prepare('SELECT * FROM taps WHERE id = ?').get(input.id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, reason: 'tap not found' };
  const tap = tapRow(row);
  if (tap.state === 'expired' && restartExpired.has(tap.id)) return { ok: false, reason: 'tap expired (daemon restarted); request a new tap' };
  if (tap.state !== 'pending') return { ok: false, reason: `tap is ${tap.state}` };
  if (Date.parse(tap.expiresAt) <= now.getTime()) {
    store.sql.prepare("UPDATE taps SET state = 'expired' WHERE id = ? AND state = 'pending'").run(tap.id);
    return { ok: false, reason: 'tap expired' };
  }
  const expected = Buffer.from(tap.codeHash, 'hex');
  const actual = Buffer.from(tapCodeHash(pepper, tap.id, input.code), 'hex');
  if (!timingSafeEqual(expected, actual)) {
    const changed = store.sql.prepare("UPDATE taps SET attempts = attempts + 1, state = CASE WHEN attempts + 1 >= 3 THEN 'denied' ELSE 'pending' END WHERE id = ? AND state = 'pending' AND expiresAt > ?").run(tap.id, now.toISOString());
    if (Number(changed.changes) !== 1) return { ok: false, reason: 'tap is no longer pending' };
    const current = store.sql.prepare('SELECT state FROM taps WHERE id = ?').get(tap.id) as { state: TapRow['state'] };
    return { ok: false, reason: current.state === 'denied' ? 'tap denied' : 'incorrect tap code' };
  }
  const changed = store.sql.prepare("UPDATE taps SET state = 'granted', grantMac = ?, grantedAt = ? WHERE id = ? AND state = 'pending' AND expiresAt > ?").run(tapGrantMac(pepper, tap), now.toISOString(), tap.id, now.toISOString());
  if (Number(changed.changes) !== 1) return { ok: false, reason: 'tap is no longer pending' };
  return { ok: true, granted: true };
}

export function consumeTap(store: Store, project: string, kind: string, expectedActionHash: string, pepper: Buffer, tapId?: string, now = new Date()): string | null {
  ensureTapTable(store);
  const row = (tapId
    ? store.sql.prepare('SELECT * FROM taps WHERE id = ?').get(tapId)
    : store.sql.prepare("SELECT * FROM taps WHERE project = ? AND kind = ? AND actionHash = ? AND state = 'granted' ORDER BY grantedAt ASC LIMIT 1").get(project, kind, expectedActionHash)) as Record<string, unknown> | undefined;
  if (!row) return 'tap not found';
  const tap = tapRow(row);
  if (tap.project !== project || tap.kind !== kind || tap.actionHash !== expectedActionHash) return 'tap does not match requested action';
  if (tap.state !== 'granted') return `tap is ${tap.state}`;
  const actualGrantMac = Buffer.from(tapGrantMac(pepper, tap), 'hex');
  const storedGrantMac = Buffer.from(tap.grantMac ?? '', 'hex');
  if (storedGrantMac.length !== actualGrantMac.length || !timingSafeEqual(storedGrantMac, actualGrantMac)) return 'tap not validly granted';
  if (Date.parse(tap.expiresAt) <= now.getTime()) {
    store.sql.prepare("UPDATE taps SET state = 'expired' WHERE id = ? AND state = 'granted'").run(tap.id);
    return 'tap expired';
  }
  const result = store.sql.prepare("UPDATE taps SET state = 'used', grantMac = NULL, usedAt = ? WHERE id = ? AND state = 'granted' AND expiresAt > ?").run(now.toISOString(), tap.id, now.toISOString());
  return Number(result.changes) === 1 ? null : 'tap is no longer granted';
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
function tapGrantMac(pepper: Buffer, tap: Pick<TapRow, 'id' | 'project' | 'kind' | 'actionHash'>): string { return createHmac('sha256', pepper).update(`${tap.id}:${tap.project}:${tap.kind}:${tap.actionHash}:granted`).digest('hex'); }
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
