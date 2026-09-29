import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Jev, JevQuestion } from './jev.js';
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
export type EnvelopeDecision = Readonly<{ action: string; decision: 'allow' | 'tap' | 'never'; source: 'hard' | 'envelope' | 'jev'; pTap: number | null }>;
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

const KIND_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9-]+)*$/;
const MAX_ACTION_CHARS = 2_000;

function normaliseKind(kind: string): string | undefined {
  const value = kind.trim().toLowerCase();
  return KIND_PATTERN.test(value) ? value : undefined;
}

function branchName(value: string): string | undefined {
  const branch = value.trim().toLowerCase().replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '');
  return /^[a-z0-9._/-]+$/.test(branch) ? branch : undefined;
}

function shellTokens(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const pushToken = () => { if (token) tokens.push(token); token = ''; };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '$' || char === '`') return undefined;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '$' || char === '`' || char === '|' || char === '<' || char === '>') return undefined;
    if (char === ';') { pushToken(); return tokens; }
    if (char === '&') {
      if (command[index + 1] !== '&') return undefined;
      pushToken(); return tokens;
    }
    if (/\s/.test(char)) { pushToken(); continue; }
    token += char;
  }
  if (quote || escaped) return undefined;
  pushToken();
  return tokens;
}

function matchingParen(command: string, open: number): number | undefined {
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let backtick = false;
  let escaped = false;
  for (let index = open; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (backtick) { if (char === '`') backtick = false; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && char === '`') backtick = true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '`') { backtick = true; continue; }
    if (char === '(') depth += 1;
    if (char === ')' && --depth === 0) return index;
  }
  return undefined;
}

function matchingBacktick(command: string, open: number): number | undefined {
  let escaped = false;
  for (let index = open + 1; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '`') return index;
  }
  return undefined;
}

function shellSegments(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = () => { if (current.trim()) segments.push(current.trim()); current = ''; };
  const nested = (inner: string): boolean => {
    const found = shellSegments(inner);
    if (!found) return false;
    flush();
    segments.push(...found);
    return true;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\') { current += char; escaped = true; continue; }
    if (quote) {
      if (char === quote) { current += char; quote = undefined; continue; }
      if (quote === '"' && char === '$' && command[index + 1] === '(') {
        const close = matchingParen(command, index + 1);
        if (close === undefined || !nested(command.slice(index + 2, close))) return undefined;
        index = close;
        continue;
      }
      if (quote === '"' && char === '`') {
        const close = matchingBacktick(command, index);
        if (close === undefined || !nested(command.slice(index + 1, close))) return undefined;
        index = close;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') { current += char; quote = char; continue; }
    if (char === '$') {
      if (command[index + 1] !== '(') return undefined;
      const close = matchingParen(command, index + 1);
      if (close === undefined || !nested(command.slice(index + 2, close))) return undefined;
      index = close;
      continue;
    }
    if (char === '(') {
      const close = matchingParen(command, index);
      if (close === undefined || !nested(command.slice(index + 1, close))) return undefined;
      index = close;
      continue;
    }
    if (char === '`') {
      const close = matchingBacktick(command, index);
      if (close === undefined || !nested(command.slice(index + 1, close))) return undefined;
      index = close;
      continue;
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '\r') {
      flush();
      if ((char === '|' || char === '&') && command[index + 1] === char) index += 1;
      continue;
    }
    current += char;
  }
  if (quote || escaped) return undefined;
  flush();
  return segments;
}

function pushDestination(token: string): string | undefined {
  let ref = token.replace(/^\+/, '');
  const colon = ref.indexOf(':');
  if (colon >= 0) ref = ref.slice(colon + 1);
  if (ref.startsWith('refs/heads/')) ref = ref.slice('refs/heads/'.length);
  return branchName(ref);
}

function pushToProtectedBranch(action: string, protectedBranches: ReadonlySet<string>, branchLookupFailed: boolean): boolean {
  if (!/\b(?:git\s+)?push\b|\bforce-push\b/i.test(action)) return false;
  const tokens = shellTokens(action);
  if (!tokens) return true;
  const pushIndex = tokens.findIndex((token) => /^(?:push|force-push)$/i.test(token));
  if (pushIndex < 0) return true;
  const rawArgs = tokens.slice(pushIndex + 1);
  if (rawArgs.some((token) => /^(?:--all|--mirror|--tags|--delete|-d|-f|--force(?:-with-lease)?)(?:=.*)?$/i.test(token))) return true;
  const args = rawArgs.filter((token) => token !== '--' && !token.startsWith('-'));
  if (args.length === 0) return true;
  const refspecs = args.length === 1 && (/[:/]/.test(args[0]!) || args[0]!.startsWith('+')) ? args : args.slice(1);
  if (refspecs.length === 0) return true;
  if (refspecs.some((refspec) => refspec === 'HEAD' || refspec === '@' || refspec.startsWith(':') || refspec.startsWith('+'))) return true;
  const destinations = refspecs.map(pushDestination);
  if (destinations.some((destination) => destination === undefined)) return true;
  return branchLookupFailed || destinations.some((destination) => protectedBranches.has(destination!));
}

function hardRule(action: string, kind: string, protectedBranches: ReadonlySet<string>, branchLookupFailed: boolean): boolean {
  const text = `${kind} ${action}`;
  if (/\b(?:eval|xargs)\b|\b(?:sh|bash|zsh|dash|ksh)\s+-c(?:\s|$)/i.test(text)) return true;
  if (/\b(?:git\s+)?push\b|\bforce-push\b/i.test(text)) {
    const command = /\b(?:git\s+)?push\b|\bforce-push\b/i.test(action) ? action : `git push ${action}`;
    if (/[$`()]/.test(command)) return true;
    const segments = shellSegments(command);
    if (!segments || segments.some((segment) => pushToProtectedBranch(segment, protectedBranches, branchLookupFailed))) return true;
  }
  if (/--admin\b/i.test(text)) return true;
  const secret = /(?:\.env(?:\.[\w-]+)?\b|secrets?\b|tokens?\b|(?:api|private)[ _-]?keys?\b|credentials?\b)/i.test(text);
  if (secret && /\b(?:read|print|cat|echo|show|display|dump|export|inspect|view|open|get|fetch|load|source|access|retrieve|pull|copy)\b/i.test(text)) return true;
  if (/\b(?:prod|production)\b/i.test(text) && /\b(?:delete|remove|backfill|migrat(?:e|ion)|drop|truncate)\w*\b/i.test(text)) return true;
  if (/\bconvex\.migration\b/i.test(text) && /\b(?:prod|production)\b/i.test(text)) return true;
  if (/\b(?:paid|sign[ -]?up|subscribe|subscription|checkout|payment|billing|plan)\b/i.test(text) && /\b(?:change|update|upgrade|downgrade|cancel|start|create|buy|purchase|pay|set|switch|enable|disable|sign[ -]?up|subscribe)\w*\b/i.test(text)) return true;
  if (/\b(?:provider|vercel|github|clerk|stripe|convex|openai)\b/i.test(text) && /\b(?:account|settings?|team|organization|org|permissions?)\b/i.test(text)) return true;
  const message = /\b(?:message|email|dm|notify|contact|send)\b/i.test(text);
  if (message && (!/\bnick\b/i.test(text) || /\bnick\b.*(?:,|\band\b|&)\s*\w|\w\s*(?:,|\band\b|&)\s*\w+.*\bnick\b/i.test(text))) return true;
  if (/\b(?:raise|increase|bump|expand|extend|lift)\w*\b/i.test(text) && /\b(?:budget|spend|cap|limit)\b/i.test(text)) return true;
  if (/\b(?:edit|modify|change|write|update|add|remove|install|configure|patch|touch|append|rewrite|overwrite|delete)\w*\b/i.test(text) && ((/\b(?:CLAUDE\.md|AGENTS\.md|settings\.json)\b/i.test(text)) || /\bagent settings\b/i.test(text))) return true;
  return false;
}

function tapProbability(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

type EnvelopeCheckOptions = { jev?: Jev; envelopeTapAt: number; log?: (line: string) => void; defaultBranch?: string; workerBaseRef?: string; branchLookupFailed?: boolean };

export async function checkEnvelope(home: string, input: { project: string; actions: readonly string[]; kind?: string; baseRef?: string }, options: EnvelopeCheckOptions): Promise<EnvelopeDecision[]> {
  if (input.actions.length < 1 || input.actions.length > 13) throw new Error('actions must contain 1 to 13 items');
  const value = envelopeValue(home, input.project, options.log);
  const kind = input.kind === undefined ? undefined : normaliseKind(input.kind);
  const deployModes = new Map<string, Envelope['deploy'][string]>();
  for (const [target, mode] of Object.entries(value.deploy)) {
    const normalisedTarget = normaliseKind(target);
    if (normalisedTarget) deployModes.set(normalisedTarget, mode);
  }
  const tapOnly = new Set(value.tapOnly.map(normaliseKind).filter((entry): entry is string => entry !== undefined));
  const target = kind?.startsWith('deploy.') ? kind.slice('deploy.'.length) : undefined;
  const mode = target ? deployModes.get(target) : undefined;
  const protectedBranches = new Set(['main', 'master']);
  for (const candidate of [input.baseRef, options.defaultBranch, options.workerBaseRef]) {
    const branch = candidate ? branchName(candidate) : undefined;
    if (branch) protectedBranches.add(branch);
  }
  const envelopeNever = mode === 'never';
  const envelopeTap = input.kind !== undefined && (!kind || (!tapOnly.has(kind) && !kind.startsWith('deploy.')))
    || (kind !== undefined && tapOnly.has(kind))
    || (kind?.startsWith('deploy.') === true && mode === undefined)
    || mode === 'tap';
  if (envelopeNever) return input.actions.map((action) => ({ action, decision: 'never', source: 'envelope', pTap: null }));
  if (input.actions.some((action) => action.length > MAX_ACTION_CHARS)) return input.actions.map((action) => ({ action, decision: 'tap', source: 'jev', pTap: null }));
  const decisions: Array<EnvelopeDecision | undefined> = input.actions.map((action) => {
    if (hardRule(action, input.kind ?? '', protectedBranches, options.branchLookupFailed === true)) return { action, decision: 'tap', source: 'hard', pTap: null };
    if (envelopeTap) return { action, decision: 'tap', source: 'envelope', pTap: null };
    return undefined;
  });
  const pending = decisions.flatMap((decision, index) => decision ? [] : [index]);
  if (pending.length === 0) return decisions as EnvelopeDecision[];
  const failClosed = (): EnvelopeDecision[] => decisions.map((decision, index) => decision ?? { action: input.actions[index]!, decision: 'tap', source: 'jev', pTap: null }) as EnvelopeDecision[];
  const questions: Record<string, JevQuestion> = Object.fromEntries(pending.map((index, n) => {
    const action = JSON.stringify(input.actions[index]);
    return [`a${n}`, { type: 'noul', instructions: `Proposed supervisor action: ${action}\nDoes this action fall outside the autonomy envelope, so it needs a tap from Nick before it runs? If any rule would require a tap, or the action is irreversible and not clearly allowed, answer true.`, criteria: { true: 'tap required', false: 'clearly allowed by the envelope' } }];
  }));
  let answers: Record<string, { noul?: unknown }> | undefined;
  try {
    const result = await options.jev?.ask('check.envelope', { project: input.project, state: value.rules.join('\n'), questions });
    if (!result?.ok) return failClosed();
    answers = result.answers;
  } catch { return failClosed(); }
  const scores = pending.map((_, n) => tapProbability(answers?.[`a${n}`]?.noul));
  if (scores.some((score) => score === null)) return failClosed();
  pending.forEach((index, n) => { const score = scores[n]!; decisions[index] = { action: input.actions[index]!, decision: score >= options.envelopeTapAt ? 'tap' : 'allow', source: 'jev', pTap: score }; });
  return decisions as EnvelopeDecision[];
}

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
