import { createHash } from 'node:crypto';
import type { GitHub, GitHubComment, Store, ToolOutcome, Workspace } from './types.js';
import { reviewRecordInput } from './types.js';
import type { Settings } from './settings.js';
import type { Jev } from './jev.js';
import { registerWakeKind } from './supervise.js';
import { modelFamily } from './helm.js';
import type { z } from 'zod';

export type ReviewRecordInput = z.infer<typeof reviewRecordInput>;
export type ReviewRow = Readonly<{
  id: number; repoSlug: string; number: number; head: string; patchId: string; reviewer: string;
  stated: 'approve' | 'request_changes'; jevApprove: number | null; verdict: 'approve' | 'changes' | 'disputed'; commentUrl: string; at: string;
}>;
export type ReviewService = Readonly<{
  record(input: ReviewRecordInput): Promise<ToolOutcome<{ review: ReviewRow }>>;
  guard(input: unknown): Promise<string | null>;
}>;

registerWakeKind('review.disputed', (event, project, now) => ({
  id: `wake-review-${createHash('sha1').update(`${event.seq}:${now}`).digest('hex').slice(0, 12)}`,
  project, kind: 'review.disputed', workerId: event.workerId,
  summary: String(event.data.summary ?? 'review verdict disputed'), command: false, createdAt: now,
}));

function refusal(reason: string): ToolOutcome<never> { return { ok: false, reason }; }
function row(value: Record<string, unknown>): ReviewRow {
  return {
    id: Number(value.id), repoSlug: String(value.repoSlug), number: Number(value.number), head: String(value.head), patchId: String(value.patchId),
    reviewer: String(value.reviewer), stated: value.stated as ReviewRow['stated'], jevApprove: value.jevApprove === null ? null : Number(value.jevApprove),
    verdict: value.verdict as ReviewRow['verdict'], commentUrl: String(value.commentUrl), at: String(value.at),
  };
}
function commentId(url: string): number {
  const match = url.match(/(?:issuecomment-|\/comments\/)(\d+)/) ?? url.match(/(\d+)$/);
  if (!match) throw new Error('commentUrl does not contain a GitHub comment id');
  return Number(match[1]);
}
function issueNumber(comment: GitHubComment): number | undefined {
  const value = comment.issueNumber ?? Number(comment.issueUrl?.match(/\/issues\/(\d+)(?:$|\/)/)?.[1]);
  return Number.isInteger(value) ? value : undefined;
}
function approveScore(answer: { noul?: boolean | number } | undefined): number | null {
  if (!answer) return null;
  if (typeof answer.noul === 'number') return answer.noul;
  if (typeof answer.noul === 'boolean') return answer.noul ? 1 : 0;
  return null;
}
/** True when `offset` is quoted text: after an odd number of quote marks on its line, on a '>' line, or inside an open code fence. */
export function isQuoted(text: string, offset: number): boolean {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const fences = text.slice(0, start).match(/^[\t ]*(?:```|~~~)/gm)?.length ?? 0;
  return fences % 2 === 1 || /^[\t ]*>/.test(text.slice(start)) || (text.slice(start, offset).match(/["“”]/g)?.length ?? 0) % 2 === 1;
}
export function verdictLine(body: string): 'approve' | 'changes' {
  const text = body.trimEnd();
  const start = text.lastIndexOf('\n') + 1;
  return text.startsWith('APPROVE: ', start) && !isQuoted(text, start) ? 'approve' : 'changes';
}

function patchBase(store: Store, repoSlug: string, number: number, fallback: string): string {
  try {
    const row = store.sql.prepare('SELECT m.baseSha FROM merge_queue q JOIN merge_queue_meta m ON m.id = q.id WHERE q.repoSlug = ? AND q.number = ?').get(repoSlug, number) as { baseSha?: string } | undefined;
    return row?.baseSha ?? fallback;
  } catch {
    return fallback;
  }
}

export function createReview({ store, github, workspace, jev, settings, now = () => new Date() }: {
  store: Store; github: GitHub; workspace: Workspace; jev: Jev; settings: Settings; now?: () => Date;
}): ReviewService {
  const table = store.sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reviews'").get();
  if (!table) {
    store.sql.exec(`CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repoSlug TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL,
      patchId TEXT NOT NULL, reviewer TEXT NOT NULL, stated TEXT NOT NULL, jevApprove REAL, verdict TEXT NOT NULL,
      commentUrl TEXT NOT NULL, at TEXT NOT NULL
    )`);
  } else {
    const columns = store.sql.prepare('PRAGMA table_info(reviews)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'repoSlug')) {
      store.sql.exec('BEGIN IMMEDIATE');
      try {
        store.sql.exec(`
          DROP TABLE IF EXISTS reviews_v2;
          CREATE TABLE reviews_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT, repoSlug TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL,
            patchId TEXT NOT NULL, reviewer TEXT NOT NULL, stated TEXT NOT NULL, jevApprove REAL, verdict TEXT NOT NULL,
            commentUrl TEXT NOT NULL, at TEXT NOT NULL
          );
        `);
        const rows = store.sql.prepare('SELECT id, number, head, patchId, reviewer, stated, jevApprove, verdict, commentUrl, at FROM reviews').all() as Array<Record<string, unknown>>;
        const prs = store.sql.prepare('SELECT repoSlug, number FROM prs').all() as Array<{ repoSlug: string; number: number }>;
        const insert = store.sql.prepare('INSERT INTO reviews_v2 (id, repoSlug, number, head, patchId, reviewer, stated, jevApprove, verdict, commentUrl, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const row of rows) {
          const commentRepo = String(row.commentUrl).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+/i)?.[1];
          const prRepo = prs.find((pr) => pr.number === Number(row.number))?.repoSlug;
          const repoSlug = commentRepo ?? prRepo ?? `unknown/review-${String(row.id)}`;
          insert.run(Number(row.id), repoSlug, Number(row.number), String(row.head), String(row.patchId), String(row.reviewer), String(row.stated), row.jevApprove === null ? null : Number(row.jevApprove), String(row.verdict), String(row.commentUrl), String(row.at));
        }
        store.sql.exec('DROP TABLE reviews; ALTER TABLE reviews_v2 RENAME TO reviews; COMMIT');
      } catch (error) {
        try { store.sql.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
        throw error;
      }
    }
  }
  store.sql.exec('CREATE INDEX IF NOT EXISTS reviews_pr ON reviews(repoSlug, number, at);');
  const insert = store.sql.prepare('INSERT INTO reviews (repoSlug, number, head, patchId, reviewer, stated, jevApprove, verdict, commentUrl, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const list = store.sql.prepare('SELECT * FROM reviews WHERE repoSlug = ? AND number = ? ORDER BY at DESC, id DESC');

  async function patchId(repo: string, base: string, head: string): Promise<string> {
    return workspace.patchId(repo, base, head);
  }
  async function record(input: ReviewRecordInput): Promise<ToolOutcome<{ review: ReviewRow }>> {
    const resolved = store.resolvePrByNumber(input.number, input.project ?? input.repoSlug);
    if (!resolved.pr) return refusal(resolved.reason ?? 'pr not found');
    const pr = resolved.pr;
    const worker = store.getWorker(pr.workerId);
    if (!worker) return refusal('pr worker not found');
    const status = await github.prStatus(worker.repoSlug, input.number);
    if (status.head !== input.head) return refusal(`head mismatch: expected ${input.head}, got ${status.head}`);
    const fetched = await github.comment(worker.repoSlug, commentId(input.commentUrl));
    if (!fetched || typeof fetched !== 'object' || typeof fetched.body !== 'string') return refusal('GitHub comment was not found');
    if (issueNumber(fetched) !== input.number) return refusal('comment does not belong to this PR');
    const scoreResult = await jev.ask('review.verdict', {
      project: worker.repoSlug, state: { body: fetched.body.replace(/^(?:APPROVE|REQUEST_CHANGES): ?/gm, '') },
      questions: { verdict: { type: 'noul', instructions: 'Does this code review approve the change for merge (as opposed to requesting changes)?' } },
    });
    const answer = scoreResult.ok ? scoreResult.answers.verdict ?? scoreResult.answers.approve : undefined;
    const score = approveScore(answer);
    const noKey = !scoreResult.ok && scoreResult.reason === 'no key';
    if (noKey) store.appendEvent(pr.workerId, 'review.warning', { project: worker.repoSlug, summary: 'Jev verdict check skipped: no key' });
    const jevAgrees = noKey || score === null || (input.verdict === 'approve' ? score >= settings.factory.verdictAt : score < settings.factory.verdictAt);
    const lineVerdict = verdictLine(fetched.body);
    const verdict: ReviewRow['verdict'] = !noKey && !jevAgrees ? 'disputed' : input.verdict === 'approve' && lineVerdict === 'approve' ? 'approve' : 'changes';
    const stored: ReviewRow = { id: 0, repoSlug: worker.repoSlug, number: input.number, head: input.head, patchId: await patchId(worker.repo, patchBase(store, worker.repoSlug, input.number, worker.baseSha), input.head), reviewer: input.reviewer, stated: input.verdict, jevApprove: score, verdict, commentUrl: input.commentUrl, at: now().toISOString() };
    const result = insert.run(stored.repoSlug, stored.number, stored.head, stored.patchId, stored.reviewer, stored.stated, stored.jevApprove, stored.verdict, stored.commentUrl, stored.at);
    const saved = row({ ...stored, id: Number(result.lastInsertRowid) });
    if (verdict === 'disputed') store.appendEvent(pr.workerId, 'review.disputed', { project: worker.repoSlug, number: input.number, summary: `review ${input.commentUrl} disagrees with Jev` });
    return { ok: true, review: saved };
  }
  async function guard(input: unknown): Promise<string | null> {
    const value = input as { project?: string; repoSlug?: string; number?: number; expectedHead?: string };
    const number = value.number;
    const expectedHead = value.expectedHead ?? '';
    if (!number) return null;
    const resolved = store.resolvePrByNumber(number, value.project ?? value.repoSlug);
    if (!resolved.pr) return resolved.reason ?? `no approving review at ${expectedHead}`;
    const pr = resolved.pr;
    const worker = store.getWorker(pr.workerId);
    if (!worker) return `no approving review at ${expectedHead}`;
    const status = await github.prStatus(worker.repoSlug, number);
    const currentPatch = await patchId(worker.repo, patchBase(store, worker.repoSlug, number, worker.baseSha), status.head).catch(() => undefined);
    const candidates = (list.all(worker.repoSlug, number) as Record<string, unknown>[]).map(row).filter((review) => review.head === status.head || (currentPatch !== undefined && review.patchId === currentPatch));
    const latest = candidates[0];
    if (!latest || latest.verdict !== 'approve') return `no approving review at ${expectedHead}`;
    if (modelFamily(latest.reviewer) === modelFamily(worker.model)) return `reviewer model family '${modelFamily(latest.reviewer)}' matches the builder's`;
    return null;
  }
  return { record, guard };
}
