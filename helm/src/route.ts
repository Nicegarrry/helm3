import type { Jev, JevAnswer } from './jev.js';
import { issueQuestions, band, flag, score } from './jevcheck.js';
import type { Settings } from './settings.js';
import { cleanRateForRouting } from './scorecard.js';
import type { Store } from './types.js';
import type { ModelChooser, ModelChoice, SpawnInput } from './helm.js';

const HIGH = 'codex/gpt-5.6-luna:high';

function tooBig(answer: JevAnswer | undefined): boolean {
  return flag(answer, 'true', true);
}

function allowed(model: string, settings: Settings): string {
  return settings.routing.allowed.includes(model) ? model : settings.routing.allowed.at(-1) ?? HIGH;
}

function project(repo: string): string | undefined {
  return /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : undefined;
}

export function createRouter(options: { settings: Settings; store: Store; jev: Jev; now?: () => Date; resolveProject?: (repo: string) => Promise<string | undefined> }): ModelChooser {
  const fallbackModel = () => allowed(HIGH, options.settings);
  return async (input: SpawnInput): Promise<ModelChoice> => {
    if (input.model || input.difficulty) return { model: input.model ?? HIGH };
    const projectName = project(input.repo) ?? (options.resolveProject ? await options.resolveProject(input.repo).catch(() => undefined) : undefined);
    const questions = issueQuestions();
    let result: Awaited<ReturnType<Jev['ask']>>;
    try {
      result = await options.jev.ask('route', {
        ...(projectName ? { project: projectName } : {}),
        state: { objective: input.objective, acceptance: input.acceptance ?? null },
        questions: { complexity: questions.complexity!, too_big: questions.too_big! },
      });
    } catch {
      return { model: fallbackModel() };
    }
    if (!result.ok) return { model: fallbackModel() };
    const splitRecommended = tooBig(result.answers.too_big);
    const complexity = score(result.answers.complexity);
    const complexityBand = band(complexity);
    if (complexityBand === undefined) return { model: fallbackModel(), ...(splitRecommended ? { warning: 'split recommended' } : {}) };
    let model = allowed(options.settings.routing.table[complexityBand] ?? HIGH, options.settings);
    const rate = cleanRateForRouting(options.store, model, complexityBand, options.now?.() ?? new Date(), projectName);
    if (rate.n >= options.settings.routing.minN && rate.clean / rate.n < options.settings.routing.minClean) model = allowed(HIGH, options.settings);
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
