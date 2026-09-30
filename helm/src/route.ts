import type { Jev, JevAnswer } from './jev.js';
import { issueQuestions, flag, scoreTier } from './jevcheck.js';
import { loadSettings, type Settings } from './settings.js';
import type { Store } from './types.js';
import type { ModelChooser, ModelChoice, SpawnInput } from './helm.js';
import { LOAD_CLASS_QUESTION, loadClassFromAnswer } from './capacity/classify.js';
import { createModelCatalog, type ModelCatalog } from './routing/catalog.js';
import { selectCandidate } from './routing/select.js';

function choice(value: ModelChoice, loadClassAsked = false): ModelChoice {
  Object.defineProperty(value, 'loadClassAsked', { value: loadClassAsked, enumerable: false });
  return value;
}

function tooBig(answer: JevAnswer | undefined): boolean { return flag(answer, 'true', true); }
function project(repo: string): string | undefined { return /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : undefined; }
function difficultyTier(difficulty: SpawnInput['difficulty']): number | undefined {
  return difficulty === 'super-easy' ? 1 : difficulty === 'easy' ? 2 : difficulty === 'normal' ? 3 : undefined;
}

export function createRouter(options: {
  settings: Settings;
  settingsHome?: string;
  store: Store;
  jev?: Jev;
  now?: () => Date;
  resolveProject?: (repo: string) => Promise<string | undefined>;
  isAvailable?: (model: string) => boolean | Promise<boolean>;
  catalog?: ModelCatalog;
}): ModelChooser {
  const currentSettings = () => options.settingsHome ? loadSettings(options.settingsHome) : options.settings;
  const defaultCatalog = createModelCatalog({ getSettings: currentSettings, probe: options.isAvailable ? {
    codex: (id) => options.isAvailable!(`codex/${id}`),
    pi: (provider, id) => options.isAvailable!(`${provider}/${id}`),
    claude: () => options.isAvailable!('claude/runner'),
  } : undefined });
  const catalog = options.catalog ?? (options.isAvailable ? {
    availability: async (model: string) => {
      if (model.startsWith('claude/')) return { available: false, reason: 'no worker lane for claude' };
      try { return await options.isAvailable!(model) ? { available: true } : { available: false, reason: 'model is unavailable' }; }
      catch { return { available: false, reason: 'model is unavailable' }; }
    },
    check: defaultCatalog.check,
  } : defaultCatalog);
  return async (input: SpawnInput): Promise<ModelChoice> => {
    if (input.model) return { model: input.model };
    const settings = currentSettings();
    const projectName = project(input.repo) ?? (options.resolveProject ? await options.resolveProject(input.repo).catch(() => undefined) : undefined);
    let judgedTier = difficultyTier(input.difficulty);
    let score: number | undefined;
    let splitRecommended = false;
    let warning: string | undefined;
    let loadClassAsked = false;
    let loadClass: ReturnType<typeof loadClassFromAnswer>;
    if (judgedTier === undefined && options.jev) {
      loadClassAsked = true;
      const questions = issueQuestions();
      try {
        const result = await options.jev.ask('route', {
          ...(projectName ? { project: projectName } : {}),
          state: { objective: input.objective, acceptance: input.acceptance ?? null },
          questions: { complexity: questions.complexity!, too_big: questions.too_big!, load: LOAD_CLASS_QUESTION },
        });
        if (result.ok) {
          splitRecommended = tooBig(result.answers.too_big);
          loadClass = loadClassFromAnswer(result.answers.load);
          const judged = scoreTier(result.answers.complexity);
          judgedTier = judged?.tier;
          score = judged?.score;
          if (!judged) warning = splitRecommended ? 'split recommended' : undefined;
        } else warning = 'Jev routing failed; used tier 3 fallback';
      } catch { warning = 'Jev routing failed; used tier 3 fallback'; }
    }
    judgedTier ??= 3;
    const selection = await selectCandidate({
      settings, input, judgedTier, score, project: projectName,
      store: options.store, catalog, now: options.now?.() ?? new Date(),
    });
    const output: ModelChoice = {
      ...(selection.model ? { model: selection.model } : {}),
      tier: selection.tier,
      ...(selection.score === undefined ? {} : { score: selection.score }),
      policyApplied: selection.policyApplied,
      ...(selection.skippedCandidates?.length ? { skippedCandidates: selection.skippedCandidates } : {}),
      ...(selection.refusal ? { refusal: selection.refusal } : {}),
      ...(splitRecommended ? { warning: 'split recommended' } : warning ? { warning } : {}),
      ...(loadClass ? { loadClass } : {}),
    };
    return choice(output, loadClassAsked);
  };
}

export function registerRouting(options: { chooseModel: (chooser: ModelChooser) => void; settings: Settings; settingsHome?: string; store: Store; jev?: Jev; now?: () => Date; resolveProject?: (repo: string) => Promise<string | undefined>; catalog?: ModelCatalog }): void {
  options.chooseModel(createRouter({ settings: options.settings, settingsHome: options.settingsHome, store: options.store, jev: options.jev, now: options.now, resolveProject: options.resolveProject, catalog: options.catalog }));
}
