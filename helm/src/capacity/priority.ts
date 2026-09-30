import type { Jev, JevAnswer } from '../jev.js';
import type { Priority } from '../types.js';

export type AdmissionRank = Readonly<{ base: number; reasons: readonly string[] }>;
export type QuickCheck = Readonly<{ class?: string; size?: string }>;
const BASE: Record<Priority, number> = { low: 0, normal: 10, high: 20, urgent: 40 };
const CLASSES = ['security', 'bugfix', 'feature', 'chore', 'docs'], SIZES = ['xs', 's', 'm', 'l'];
const choice = (instructions: string, options: string[]) => ({ type: 'choice' as const, instructions, options, criteria: Object.fromEntries(options.map((option) => [option, option])) });
const QUESTIONS = { class: choice('What kind of change is this objective? security means a vulnerability, auth, secrets or permissions fix.', CLASSES), size: choice('How large is the change? xs is a one-line edit, l is large or cross-cutting.', SIZES) };
const pick = (answer: JevAnswer | undefined, options: string[]): string | undefined => options.find((option) => option === answer?.choice);
/** One cheap Jev call on the objective, raced against a short timeout; any failure or hang yields no classification so the spawn is never blocked. */
export async function quickCheck(jev: Jev | undefined, input: Readonly<{ objective: string; project: string }>): Promise<QuickCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([jev?.ask('priority', { project: input.project, state: { objective: input.objective }, questions: QUESTIONS }), new Promise<undefined>((resolve) => { timer = setTimeout(resolve, 2_000); })]);
    return result?.ok ? { class: pick(result.answers.class, CLASSES), size: pick(result.answers.size, SIZES) } : {};
  } catch { return {}; } finally { clearTimeout(timer); }
}
export const effectivePriority = (stated: Priority, check: QuickCheck): Priority => check.class === 'security' && BASE[stated] < BASE.high ? 'high' : stated;
export const agingPoints = (waitMs: number): number => Math.floor(waitMs / 300_000);
export function admissionRank(effective: Priority, requestedBy: 'owner' | 'auto', size?: string): AdmissionRank {
  const boosts: Array<[string, number]> = [[`priority ${effective}`, BASE[effective]]];
  if (requestedBy === 'owner') boosts.push(['requested by owner', 15]);
  if (size === 'xs' || size === 's') boosts.push([`quick win (${size})`, 10]);
  return { base: boosts.reduce((total, [, points]) => total + points, 0), reasons: boosts.map(([reason, points]) => `${reason} +${points}`) };
}
