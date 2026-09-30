import type { Jev, JevAnswer, JevQuestion } from './jev.js';
import type { Store, ToolOutcome } from './types.js';

export type JevPreset = 'issue' | 'dedupe' | 'verdict' | 'raw';
export type JevCheckInput = Readonly<{ preset: JevPreset; project?: string; input: unknown }>;

const testable = 'Does this ticket state a concrete, checkable definition of done (specific commands, tests, files or observable behaviour an automated gate or reviewer can verify)?';
const tooBig = 'Is this ticket too big or too multi-part for one coding worker in one session, such that it should have been split into smaller tickets?';
const complexity = { type: 'score', instructions: 'How much engineering capability does a coding agent need to complete this ticket correctly (reading, editing, testing), judged from its scope, risk and number of moving parts?', criteria: ['trivial: a mechanical copy, rename, one-line change, config or doc edit', 'small: one file or one focused function plus a test', 'medium: several files or one subsystem; needs design judgement', 'hard: cross-subsystem change, or concurrency, security or data-migration risk', 'challenging: novel architecture, ambiguous requirements, or deep debugging across many components'] } as const;
const tierLabels = ['trivial', 'small', 'medium', 'hard', 'challenging'] as const;
export type JevTier = 1 | 2 | 3 | 4 | 5;
export type JevScoreTier = Readonly<{ score: number; tier: JevTier; label: (typeof tierLabels)[number] }>;

export function issueQuestions(): Record<string, JevQuestion> { return { testable: { type: 'noul', instructions: testable, criteria: { true: 'done is objectively checkable', false: 'done is vague or left to judgement' } }, too_big: { type: 'noul', instructions: tooBig, criteria: { true: 'should be split', false: 'fits one worker' } }, complexity }; }
function numberOf(answer: JevAnswer | undefined, name: string): number | boolean | undefined {
  if (!answer) return undefined;
  if (typeof answer.noul === 'number' || typeof answer.noul === 'boolean') return answer.noul;
  return answer.probabilities?.[name];
}
export function flag(answer: JevAnswer | undefined, name: string, atLeast: boolean): boolean {
  const value = numberOf(answer, name);
  return typeof value === 'boolean' ? value : atLeast ? (value ?? 0) >= 0.5 : (value ?? 1) < 0.5;
}
export function score(answer: JevAnswer | undefined): number | undefined {
  if (typeof answer?.score === 'number' && Number.isFinite(answer.score)) return answer.score;
  const probabilities = answer?.probabilities;
  if (!probabilities) return undefined;
  const values = [0, 1, 2, 3, 4].map((value) => probabilities[String(value)] ?? 0);
  return values.every((value) => Number.isFinite(value)) ? Math.round(values.reduce((total, value, valueIndex) => total + value * valueIndex, 0) * 10_000) / 10_000 : undefined;
}
function text(value: unknown, limit = 3000): string { return (typeof value === 'string' ? value : JSON.stringify(value) ?? '').slice(0, limit); }
function relation(answer: JevAnswer | undefined): { different: number; related: number; same: number } { return { different: answer?.probabilities?.['0'] ?? 0, related: answer?.probabilities?.['1'] ?? 0, same: answer?.probabilities?.['2'] ?? 0 }; }
export function scoreTier(answer: JevAnswer | undefined): JevScoreTier | undefined {
  const value = score(answer);
  if (value === undefined) return undefined;
  const tier: JevTier = value < 0.8 ? 1 : value < 1.6 ? 2 : value < 2.4 ? 3 : value < 3.2 ? 4 : 5;
  return { score: value, tier, label: tierLabels[tier - 1]! };
}

export type JevCheckService = Readonly<{ check(input: JevCheckInput): Promise<ToolOutcome<Record<string, unknown>>>; label(input: { id: number; label: string }): Promise<ToolOutcome<{ id: number; label: string }>> }>;

export function createJevCheck({ jev, store }: { jev: Jev; store: Store }): JevCheckService {
  const ask = (purpose: string, project: string | undefined, state: unknown, questions: Record<string, JevQuestion>) => jev.ask(`check.${purpose}`, { project, state, questions });
  async function check(input: JevCheckInput): Promise<ToolOutcome<Record<string, unknown>>> {
    if (input.preset === 'issue') {
      const result = await ask('issue', input.project, input.input, issueQuestions());
      if (!result.ok) return result;
      const scoreTierValue = scoreTier(result.answers.complexity);
      return { ok: true, flags: { testable: flag(result.answers.testable, 'true', false), too_big: flag(result.answers.too_big, 'true', true) }, ...(scoreTierValue ? { complexity: scoreTierValue } : {}), answers: result.answers };
    }
    if (input.preset === 'verdict') {
      const result = await ask('verdict', input.project, { body: text(input.input, 6000) }, { verdict: { type: 'noul', instructions: 'Does this code review approve the change for merge (as opposed to requesting changes)?' } });
      return result.ok ? { ok: true, approve: flag(result.answers.verdict, 'true', true), answers: result.answers } : result;
    }
    if (input.preset === 'raw') {
      const raw = input.input as { state?: unknown; questions?: Record<string, JevQuestion> };
      const result = await ask('raw', input.project, raw?.state, Object.fromEntries(Object.entries(raw?.questions ?? {}).slice(0, 6)));
      return result.ok ? { ok: true, answers: result.answers } : result;
    }
    const value = input.input as { candidate?: unknown; against?: Array<{ number: number; title: string; body: string }> };
    const candidate = text(value?.candidate); const against = (value?.against ?? []).slice(0, 40); const rows: Array<Record<string, unknown>> = []; let next = 0; let failure: string | undefined;
    const worker = async (): Promise<void> => { for (;;) { const index = next++; if (index >= against.length) return; const ticket = against[index]!;
      const result = await ask('dedupe', input.project, `Ticket A: ${candidate}\n\nTicket B: ${text(`${ticket.title}\n\n${ticket.body}`)}`, { relation: { type: 'score', instructions: 'Compare ticket A and ticket B handed to coding workers. Are they the same unit of work (B is a retry, respawn or re-issue of A, even if reworded, narrowed or carrying notes from a previous attempt), merely related (same project, plan or area but a different deliverable), or different?', criteria: ['different: unrelated deliverables', 'related: same plan, release or area but a different task or deliverable', 'same: the same task, so one worker would duplicate the other'] } });
      if (!result.ok) { failure ??= result.reason; continue; }
      const rel = relation(result.answers.relation); rows[index] = { number: ticket.number, ...rel, duplicate: rel.same >= 0.5 };
    } };
    await Promise.all(Array.from({ length: Math.min(4, against.length) }, () => worker()));
    if (failure) return { ok: false, reason: failure };
    const relations = rows.filter(Boolean); return { ok: true, duplicates: relations.filter((row) => row.duplicate), related: relations.filter((row) => Number(row.related) > Number(row.same) && Number(row.related) > Number(row.different)).map((row) => ({ number: row.number, link: `#${row.number}` })), relations };
  }
  async function label(input: { id: number; label: string }): Promise<ToolOutcome<{ id: number; label: string }>> {
    const row = store.sql.prepare('UPDATE jev_calls SET label = ? WHERE id = ?').run(input.label, input.id);
    return Number(row.changes) ? { ok: true, id: input.id, label: input.label } : { ok: false, reason: 'jev call not found' };
  }
  return { check, label };
}
