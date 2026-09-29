import type { Jev, JevAnswer } from './jev.js';
import { issueQuestions, band } from './jevcheck.js';
import type { Settings } from './settings.js';
import { cleanRateForRouting } from './scorecard.js';
import type { Store } from './types.js';
import type { ModelChooser, ModelChoice, SpawnInput } from './helm.js';

const HIGH = 'codex/gpt-5.6-luna:high';

function score(answer: JevAnswer | undefined): number | undefined {
  if (typeof answer?.score === 'number' && Number.isFinite(answer.score)) return answer.score;
  const probabilities = answer?.probabilities;
  if (!probabilities) return undefined;
  const values = [0, 1, 2, 3].map((value) => probabilities[String(value)] ?? 0);
  return values.every((value) => Number.isFinite(value)) ? Math.round(values.reduce((total, value, valueIndex) => total + value * valueIndex, 0) * 10_000) / 10_000 : undefined;
}

function tooBig(answer: JevAnswer | undefined): boolean {
  return typeof answer?.noul === 'boolean' ? answer.noul : typeof answer?.noul === 'number' && answer.noul >= 0.5;
}

function allowed(model: string, settings: Settings): string {
  return settings.routing.allowed.includes(model) ? model : HIGH;
}

function project(repo: string): string | undefined {
  return /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : undefined;
}

export function createRouter(options: { settings: Settings; store: Store; jev: Jev; now?: () => Date; resolveProject?: (repo: string) => Promise<string | undefined> }): ModelChooser {
  return async (input: SpawnInput): Promise<ModelChoice> => {
    if (input.model || input.difficulty) return { model: input.model ?? HIGH };
    const questions = issueQuestions();
    let result: Awaited<ReturnType<Jev['ask']>>;
    try {
      result = await options.jev.ask('route', {
        project: input.repo,
        state: { objective: input.objective, acceptance: input.acceptance ?? null },
        questions: { complexity: questions.complexity!, too_big: questions.too_big! },
      });
    } catch {
      return { model: HIGH };
    }
    if (!result.ok) return { model: HIGH };
    const splitRecommended = tooBig(result.answers.too_big);
    const complexity = score(result.answers.complexity);
    const complexityBand = band(complexity);
    if (complexityBand === undefined) return { model: HIGH, ...(splitRecommended ? { warning: 'split recommended' } : {}) };
    let model = allowed(options.settings.routing.table[complexityBand] ?? HIGH, options.settings);
    const projectName = project(input.repo) ?? await options.resolveProject?.(input.repo).catch(() => undefined);
    const rate = cleanRateForRouting(options.store, model, complexityBand, options.now?.() ?? new Date(), projectName);
    if (rate.n >= options.settings.routing.minN && rate.clean / rate.n < options.settings.routing.minClean) model = HIGH;
    return {
      model,
      band: complexityBand,
      complexity,
      ...(splitRecommended ? { warning: 'split recommended' } : {}),
    };
  };
}

export function registerRouting(options: { chooseModel: (chooser: ModelChooser) => void; settings: Settings; store: Store; jev?: Jev; now?: () => Date; resolveProject?: (repo: string) => Promise<string | undefined> }): void {
  if (options.jev) options.chooseModel(createRouter({ settings: options.settings, store: options.store, jev: options.jev, now: options.now, resolveProject: options.resolveProject }));
}
