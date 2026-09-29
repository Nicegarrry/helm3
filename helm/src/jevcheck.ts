import type { Jev, JevAnswer, JevQuestion } from './jev.js';
import type { Store, ToolOutcome } from './types.js';

export type JevPreset = 'issue' | 'dedupe' | 'verdict' | 'raw';
export type JevCheckInput = Readonly<{ preset: JevPreset; project?: string; input: unknown }>;

const testable = 'Does this ticket state a concrete, checkable definition of done (specific commands, tests, files or observable behaviour an automated gate or reviewer can verify)?';
const tooBig = 'Is this ticket too big or too multi-part for one coding worker in one session…?';
const complexity = ['trivial', 'small', 'medium', 'large'];

function issueQuestions(): Record<string, JevQuestion> {
  return { testable: { type: 'noul', instructions: testable }, too_big: { type: 'noul', instructions: tooBig }, complexity: { type: 'score', instructions: 'How complex is this ticket for one coding worker in one session?', criteria: complexity } };
}
function numberOf(answer: JevAnswer | undefined, name: string): number | boolean | undefined {
  if (!answer) return undefined;
  if (typeof answer.noul === 'number' || typeof answer.noul === 'boolean') return answer.noul;
  return answer.probabilities?.[name];
}
function flag(answer: JevAnswer | undefined, name: string, atLeast: boolean): boolean {
  const value = numberOf(answer, name);
  return typeof value === 'boolean' ? value : atLeast ? (value ?? 0) >= 0.5 : (value ?? 1) < 0.5;
}
function text(value: unknown, limit = 3000): string { return (typeof value === 'string' ? value : JSON.stringify(value) ?? '').slice(0, limit); }
function relation(answer: JevAnswer | undefined): { same: number; kind: string } {
  const same = answer?.probabilities?.same ?? (typeof answer?.score === 'number' ? answer.score : 0);
  const kind = typeof answer?.choice === 'string' ? answer.choice : typeof answer?.score === 'string' ? answer.score : same >= 0.5 ? 'same' : 'different';
  return { same, kind };
}

export type JevCheckService = Readonly<{ check(input: JevCheckInput): Promise<ToolOutcome<Record<string, unknown>>>; label(input: { id: number; label: string }): Promise<ToolOutcome<{ id: number; label: string }>> }>;

export function createJevCheck({ jev, store }: { jev: Jev; store: Store }): JevCheckService {
  const ask = (purpose: string, project: string | undefined, state: unknown, questions: Record<string, JevQuestion>) => jev.ask(`check.${purpose}`, { project, state, questions });
  async function check(input: JevCheckInput): Promise<ToolOutcome<Record<string, unknown>>> {
    if (input.preset === 'issue') {
      const result = await ask('issue', input.project, input.input, issueQuestions());
      if (!result.ok) return result;
      return { ok: true, flags: { testable: flag(result.answers.testable, 'true', false), too_big: flag(result.answers.too_big, 'true', true) }, complexity: result.answers.complexity?.score, answers: result.answers };
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
    const against = (value?.against ?? []).slice(0, 40); const rows: Array<Record<string, unknown>> = []; let next = 0;
    const worker = async (): Promise<void> => { for (;;) { const index = next++; if (index >= against.length) return; const ticket = against[index]!;
      const result = await ask('dedupe', input.project, { candidate: text(value?.candidate), against: { number: ticket.number, title: text(ticket.title), body: text(ticket.body) } }, { relation: { type: 'score', instructions: 'How closely do these tickets relate?', criteria: ['same unit of work', 'merely related', 'different'] } });
      if (result.ok) { const rel = relation(result.answers.relation); rows[index] = { number: ticket.number, ...rel, duplicate: rel.same >= 0.5 }; }
    } };
    await Promise.all(Array.from({ length: Math.min(4, against.length) }, () => worker()));
    const relations = rows.filter(Boolean); return { ok: true, duplicates: relations.filter((row) => row.duplicate), related: relations.filter((row) => row.kind === 'related').map((row) => ({ number: row.number, link: `#${row.number}` })), relations };
  }
  async function label(input: { id: number; label: string }): Promise<ToolOutcome<{ id: number; label: string }>> {
    const row = store.sql.prepare('UPDATE jev_calls SET label = ? WHERE id = ?').run(input.label, input.id);
    return Number(row.changes) ? { ok: true, id: input.id, label: input.label } : { ok: false, reason: 'jev call not found' };
  }
  return { check, label };
}
