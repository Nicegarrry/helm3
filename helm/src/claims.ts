import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Jev, JevAnswer, JevQuestion } from './jev.js';
import type { Settings } from './settings.js';
import type { Store, ToolOutcome, Workspace } from './types.js';

const exec = promisify(execFile);
const MAX_BATCH_DIFF = 70_000;
const EXCLUDES = [
  ':(exclude,glob)**/package-lock.json',
  ':(exclude,glob)**/npm-shrinkwrap.json',
  ':(exclude,glob)**/yarn.lock',
  ':(exclude,glob)**/pnpm-lock.yaml',
  ':(exclude,glob)**/bun.lockb',
  ':(exclude,glob)**/Cargo.lock',
  ':(exclude,glob)**/Gemfile.lock',
  ':(exclude,glob)**/poetry.lock',
  ':(exclude,glob)**/composer.lock',
  ':(exclude,glob)**/go.sum',
  ':(exclude,glob)**/__snapshots__/**',
  ':(exclude,glob)**/*.snap',
];
const supports = 'The diff contains changes that make the claim true.';
const contradicts = 'The diff touches the relevant code but it differs from the claim (different name, value, file, count, or the opposite change).';
const saysNothing = 'The diff contains no evidence about this claim either way.';
const processClaim = /^(?:(?:all\s+\d+\s+)?(?:tests?|test suite|type-?check|lint|build|checks?)\s+(?:pass(?:es|ed)?|succeed(?:s|ed)?|are green|is green)|committed|no push performed|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint))\s*[.!?]?$/i;

export type ClaimsCheckInput = Readonly<{ workerId: string }>;
export type ClaimsService = Readonly<{
  check(input: ClaimsCheckInput): Promise<ToolOutcome<Record<string, unknown>>>;
  guard(input: unknown): Promise<string | null>;
}>;
export type ClaimsGit = (cwd: string, args: readonly string[]) => Promise<string>;

function defaultGit(cwd: string, args: readonly string[]): Promise<string> {
  return exec('git', [...args], { cwd, maxBuffer: 128 * 1024 * 1024 }).then(({ stdout }) => stdout);
}

function question(claim: string): JevQuestion {
  return { type: 'choice', instructions: `A coding agent summarised its own change and claimed: ${JSON.stringify(claim.slice(0, 300))}\nJudging ONLY from the git diff in the state, what does the diff say about this claim?`, criteria: { supports, contradicts, says_nothing: saysNothing } };
}
function sentences(summary: string): string[] { return summary.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean).slice(0, 8); }
function pathsFromClaim(claim: string, files: readonly string[], fallback: readonly string[]): string[] {
  const named = files.filter((file) => claim.includes(file));
  const usableFallback = fallback.filter((file) => files.includes(file));
  return named.length ? named : (usableFallback.length ? usableFallback : [...files]);
}
function answerFor(answer: JevAnswer | undefined): { choice: string; supports: number; probabilities: Record<string, number> } {
  const probabilities = answer?.probabilities ?? {};
  return { choice: answer?.choice ?? '', supports: probabilities.supports ?? 0, probabilities };
}

export function createClaims({ jev, store, settings, workspace, git = defaultGit, now = () => new Date() }: {
  jev: Jev;
  store: Store;
  settings: Settings;
  workspace?: Pick<Workspace, 'head'>;
  git?: ClaimsGit;
  now?: () => Date;
}): ClaimsService {
  store.sql.exec(`CREATE TABLE IF NOT EXISTS claims_checks (
    workerId TEXT NOT NULL, head TEXT NOT NULL, passed INTEGER,
    detail JSON NOT NULL, jevCallId INTEGER, at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS claims_checks_worker_head ON claims_checks(workerId, head);`);

  async function currentHead(workerId: string): Promise<{ row: NonNullable<ReturnType<Store['getWorker']>>; head: string }> {
    const row = store.getWorker(workerId);
    if (!row) throw new Error('worker not found');
    const head = workspace ? await workspace.head(row.worktree) : row.head;
    if (!head) throw new Error('worker has no current head');
    if (!store.listGates(workerId).some((gate) => gate.head === head && gate.passed)) throw new Error(`no passing gate at head ${head}`);
    return { row, head };
  }
  function latestJevCall(): number | null {
    try {
      const row = store.sql.prepare('SELECT id FROM jev_calls ORDER BY id DESC LIMIT 1').get() as { id?: number } | undefined;
      return typeof row?.id === 'number' ? row.id : null;
    } catch { return null; }
  }
  async function diff(row: NonNullable<ReturnType<Store['getWorker']>>, head: string, paths?: readonly string[]): Promise<{ text: string; files: string[] }> {
    const scope = paths?.length ? paths : ['.'];
    const text = await git(row.worktree, ['diff', '--no-ext-diff', row.baseSha, head, '--', ...scope, ...EXCLUDES]);
    const files = paths?.length ? [...paths] : (await git(row.worktree, ['diff', '--name-only', '--no-ext-diff', row.baseSha, head, '--', '.', ...EXCLUDES])).split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
    return { text, files };
  }
  async function check(input: ClaimsCheckInput): Promise<ToolOutcome<Record<string, unknown>>> {
    if (settings.factory.claims === 'off') return { ok: true, passed: true, warning: 'claims checks are off' };
    let current: Awaited<ReturnType<typeof currentHead>>;
    try { current = await currentHead(input.workerId); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    const { row, head } = current;
    const result = row.result;
    const claims = (result?.claims?.length ? [...result.claims] : sentences(result?.summary ?? '')).map((claim) => claim.trim()).filter(Boolean);
    const changedFiles: string[] = result?.changedFiles ?? [];
    const full = await diff(row, head);
    const missingFiles = changedFiles.filter((file) => !full.files.includes(file));
    const detail: Record<string, unknown> = { claims, changedFiles, diffChars: full.text.length, missingFiles, answers: {} };
    const calls: number[] = [];
    const answers: Record<string, ReturnType<typeof answerFor>> = {};
    const ask = async (claimList: string[], diffText: string): Promise<void> => {
      const questions = Object.fromEntries(claimList.map((claim, index) => [`claim${index}`, question(claim)]));
      const response = await jev.ask('claims', { workerId: input.workerId, project: row.repoSlug, state: { diff: diffText }, questions });
      const callId = response.callId ?? latestJevCall();
      if (callId !== null) calls.push(callId);
      if (!response.ok) throw new Error(response.reason);
      claimList.forEach((claim, index) => { answers[claim] = answerFor(response.answers[`claim${index}`]); });
    };
    try {
      if (claims.length > 0 && full.text.length <= MAX_BATCH_DIFF) await ask(claims, full.text);
      else if (claims.length > 0) for (const claim of claims) await ask([claim], (await diff(row, head, pathsFromClaim(claim, full.files, changedFiles))).text);
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      detail.warning = warning;
      detail.answers = answers;
      detail.jevCallIds = calls;
      const noKey = warning === 'no key';
      store.sql.prepare('INSERT INTO claims_checks (workerId, head, passed, detail, jevCallId, at) VALUES (?, ?, ?, ?, ?, ?)').run(input.workerId, head, noKey ? null : 0, JSON.stringify(detail), calls[0] ?? latestJevCall(), now().toISOString());
      return noKey ? { ok: true, passed: true, warning } : { ok: false, reason: warning };
    }
    detail.answers = answers;
    detail.jevCallIds = calls;
    const checkableClaims = claims.filter((claim) => {
      const answer = answers[claim];
      return !(processClaim.test(claim) && answer?.choice === 'says_nothing');
    });
    detail.checkableClaims = checkableClaims;
    if (checkableClaims.length === 0) {
      detail.reason = 'no checkable claims';
      store.sql.prepare('INSERT INTO claims_checks (workerId, head, passed, detail, jevCallId, at) VALUES (?, ?, 0, ?, ?, ?)').run(input.workerId, head, JSON.stringify(detail), calls[0] ?? null, now().toISOString());
      return { ok: false, reason: 'no checkable claims' };
    }
    const failedClaims = checkableClaims.filter((claim) => answers[claim]!.supports < settings.factory.claimsAt);
    const passed = missingFiles.length === 0 && failedClaims.length === 0;
    detail.failedClaims = failedClaims;
    store.sql.prepare('INSERT INTO claims_checks (workerId, head, passed, detail, jevCallId, at) VALUES (?, ?, ?, ?, ?, ?)').run(input.workerId, head, passed ? 1 : 0, JSON.stringify(detail), calls[0] ?? null, now().toISOString());
    return { ok: true, passed, head, ...(failedClaims.length ? { failedClaims } : {}), ...(missingFiles.length ? { missingFiles } : {}), ...(settings.factory.claims === 'shadow' ? { warning: 'claims checks are shadow-only' } : {}) };
  }
  async function guard(input: unknown): Promise<string | null> {
    if (settings.factory.claims !== 'block') return null;
    const value = input as { number?: number; expectedHead?: string };
    const pr = typeof value.number === 'number' ? store.getPrByNumber(value.number) : undefined;
    if (!pr) return 'claims check requires a pull request worker';
    if (!store.getWorker(pr.workerId) || !value.expectedHead) return 'claims check requires a worker and head';
    const row = store.sql.prepare('SELECT passed FROM claims_checks WHERE workerId = ? AND head = ? AND passed IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1').get(pr.workerId, value.expectedHead) as { passed?: number } | undefined;
    if (row) return row.passed === 1 ? null : `no passing claims check at head ${value.expectedHead}`;
    const unknown = store.sql.prepare('SELECT 1 FROM claims_checks WHERE workerId = ? AND head = ? AND passed IS NULL LIMIT 1').get(pr.workerId, value.expectedHead);
    if (!unknown) return `no passing claims check at head ${value.expectedHead}`;
    store.appendEvent(pr.workerId, 'claims.warning', { workerId: pr.workerId, head: value.expectedHead, reason: 'no jev key; claims unchecked' });
    return null;
  }
  return { check, guard };
}
