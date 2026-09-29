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
function approveScore(answer: { noul?: boolean | number; probabilities?: Record<string, number>; confidence?: number } | undefined): number | null {
  if (!answer) return null;
  if (typeof answer.noul === 'number') return answer.noul;
  if (typeof answer.noul === 'boolean') return answer.noul ? 1 : 0;
  if (typeof answer.probabilities?.true === 'number') return answer.probabilities.true;
  return typeof answer.confidence === 'number' ? answer.confidence : null;
}

export function createReview({ store, github, workspace, jev, settings, now = () => new Date() }: {
  store: Store; github: GitHub; workspace: Workspace; jev: Jev; settings: Settings; now?: () => Date;
}): ReviewService {
  store.sql.exec(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, repoSlug TEXT NOT NULL, number INTEGER NOT NULL, head TEXT NOT NULL,
    patchId TEXT NOT NULL, reviewer TEXT NOT NULL, stated TEXT NOT NULL, jevApprove REAL, verdict TEXT NOT NULL,
    commentUrl TEXT NOT NULL, at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS reviews_pr ON reviews(repoSlug, number, at);`);
  const insert = store.sql.prepare('INSERT INTO reviews (repoSlug, number, head, patchId, reviewer, stated, jevApprove, verdict, commentUrl, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const list = store.sql.prepare('SELECT * FROM reviews WHERE repoSlug = ? AND number = ? ORDER BY at DESC, id DESC');

  async function patchId(repo: string, base: string, head: string): Promise<string> {
    return workspace.patchId(repo, base, head);
  }
  async function record(input: ReviewRecordInput): Promise<ToolOutcome<{ review: ReviewRow }>> {
    const pr = store.getPrByNumber(input.number);
    if (!pr) return refusal('pr not found');
    const worker = store.getWorker(pr.workerId);
    if (!worker) return refusal('pr worker not found');
    const status = await github.prStatus(worker.repoSlug, input.number);
    if (status.head !== input.head) return refusal(`head mismatch: expected ${input.head}, got ${status.head}`);
    const fetched = await github.comment(worker.repoSlug, commentId(input.commentUrl));
    if (!fetched || typeof fetched !== 'object' || typeof fetched.body !== 'string') return refusal('GitHub comment was not found');
    if (issueNumber(fetched) !== input.number) return refusal('comment does not belong to this PR');
    const scoreResult = await jev.ask('review.verdict', {
      project: worker.repoSlug, state: { body: fetched.body.replace(/^(?:APPROVE|REQUEST_CHANGES): ?/gm, ''), stated: input.verdict },
      questions: { verdict: { type: 'noul', instructions: 'Does this code review approve the change for merge (as opposed to requesting changes)?' } },
    });
    const answer = scoreResult.ok ? scoreResult.answers.verdict ?? scoreResult.answers.approve : undefined;
    const score = approveScore(answer);
    const noKey = !scoreResult.ok && scoreResult.reason === 'no key';
    if (noKey) store.appendEvent(pr.workerId, 'review.warning', { project: worker.repoSlug, summary: 'Jev verdict check skipped: no key' });
    const jevAgrees = noKey ? true : score !== null && (input.verdict === 'approve' ? score >= settings.factory.verdictAt : score < settings.factory.verdictAt);
    const hasApproveLine = fetched.body.split(/\r?\n/).some((line) => line.startsWith('APPROVE: '));
    const verdict: ReviewRow['verdict'] = !noKey && !jevAgrees ? 'disputed' : input.verdict === 'approve' && hasApproveLine ? 'approve' : 'changes';
    const stored: ReviewRow = { id: 0, repoSlug: worker.repoSlug, number: input.number, head: input.head, patchId: await patchId(worker.repo, worker.baseSha, input.head), reviewer: input.reviewer, stated: input.verdict, jevApprove: score, verdict, commentUrl: input.commentUrl, at: now().toISOString() };
    const result = insert.run(stored.repoSlug, stored.number, stored.head, stored.patchId, stored.reviewer, stored.stated, stored.jevApprove, stored.verdict, stored.commentUrl, stored.at);
    const saved = row({ ...stored, id: Number(result.lastInsertRowid) });
    if (verdict === 'disputed') store.appendEvent(pr.workerId, 'review.disputed', { project: worker.repoSlug, number: input.number, summary: `review ${input.commentUrl} disagrees with Jev` });
    return { ok: true, review: saved };
  }
  async function guard(input: unknown): Promise<string | null> {
    const value = input as { number?: number; expectedHead?: string };
    const number = value.number;
    const expectedHead = value.expectedHead ?? '';
    if (!number) return null;
    const pr = store.getPrByNumber(number);
    const worker = pr ? store.getWorker(pr.workerId) : undefined;
    if (!pr || !worker) return `no approving review at ${expectedHead}`;
    const status = await github.prStatus(worker.repoSlug, number);
    const currentPatch = await patchId(worker.repo, worker.baseSha, status.head).catch(() => undefined);
    const candidates = (list.all(worker.repoSlug, number) as Record<string, unknown>[]).map(row).filter((review) => review.head === status.head || (currentPatch !== undefined && review.patchId === currentPatch));
    const latest = candidates[0];
    if (!latest || latest.verdict !== 'approve') return `no approving review at ${expectedHead}`;
    if (modelFamily(latest.reviewer) === modelFamily(worker.model)) return `reviewer model family '${modelFamily(latest.reviewer)}' matches the builder's`;
    return null;
  }
  return { record, guard };
}
