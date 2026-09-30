import type { Jev, JevAnswer } from './jev.js';
import { issueQuestions, flag, scoreTier } from './jevcheck.js';
import { loadSettings, type Settings } from './settings.js';
import type { Store } from './types.js';
import type { ModelChooser, ModelChoice, SpawnInput } from './helm.js';
import { createModelCatalog, type ModelCatalog } from './routing/catalog.js';
import { appliedPolicy, policyAllows } from './routing/policy.js';
import { selectCandidate } from './routing/select.js';

const HIGH = 'codex/gpt-6-luna:high';

function tooBig(answer: JevAnswer | undefined): boolean { return flag(answer, 'true', true); }
function project(repo: string): string | undefined { return /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : undefined; }

export function createRouter(options: {
  settings: Settings;
  settingsHome?: string;
  store: Store;
  jev: Jev;
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
  const fallback = (settings: Settings, input: SpawnInput, warning?: string): ModelChoice => {
    const policy = appliedPolicy(settings, input);
    if (!policyAllows(policy, HIGH)) return { refusal: `routing fallback ${HIGH} is disallowed by the applied lane policy`, ...(warning ? { warning } : {}) };
    if (settings.routing.allowed.length > 0 && !settings.routing.allowed.includes(HIGH)) return { refusal: `routing fallback ${HIGH} is not allowed by routing.allowed`, ...(warning ? { warning } : {}) };
    return { model: HIGH, ...(warning ? { warning } : {}) };
  };
  return async (input: SpawnInput): Promise<ModelChoice> => {
    if (input.model || input.difficulty) return { model: input.model ?? HIGH };
    const settings = currentSettings();
    const projectName = project(input.repo) ?? (options.resolveProject ? await options.resolveProject(input.repo).catch(() => undefined) : undefined);
    const questions = issueQuestions();
    let result: Awaited<ReturnType<Jev['ask']>>;
    try {
      result = await options.jev.ask('route', {
        ...(projectName ? { project: projectName } : {}),
        state: { objective: input.objective, acceptance: input.acceptance ?? null },
        questions: { complexity: questions.complexity!, too_big: questions.too_big! },
      });
    } catch { return fallback(settings, input); }
    if (!result.ok) return fallback(settings, input);
    const splitRecommended = tooBig(result.answers.too_big);
    const judged = scoreTier(result.answers.complexity);
    if (!judged) return fallback(settings, input, splitRecommended ? 'split recommended' : undefined);
    const selection = await selectCandidate({
      settings, input, judgedTier: judged.tier, score: judged.score, project: projectName,
      store: options.store, catalog, now: options.now?.() ?? new Date(),
    });
    return {
      ...(selection.model ? { model: selection.model } : {}),
      tier: selection.tier,
      score: selection.score,
      policyApplied: selection.policyApplied,
      ...(selection.skippedCandidates?.length ? { skippedCandidates: selection.skippedCandidates } : {}),
      ...(selection.refusal ? { refusal: selection.refusal } : {}),
      ...(splitRecommended ? { warning: 'split recommended' } : {}),
    };
  };
}

export function registerRouting(options: { chooseModel: (chooser: ModelChooser) => void; settings: Settings; settingsHome?: string; store: Store; jev?: Jev; now?: () => Date; resolveProject?: (repo: string) => Promise<string | undefined>; catalog?: ModelCatalog }): void {
  if (options.jev) options.chooseModel(createRouter({ settings: options.settings, settingsHome: options.settingsHome, store: options.store, jev: options.jev, now: options.now, resolveProject: options.resolveProject, catalog: options.catalog }));
}
