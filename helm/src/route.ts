import type { Jev, JevAnswer } from './jev.js';
import { issueQuestions, flag, scoreTier } from './jevcheck.js';
import { loadSettings, type Settings } from './settings.js';
import { cleanRateForRouting } from './scorecard.js';
import type { Store } from './types.js';
import type { ModelChooser, ModelChoice, SpawnInput } from './helm.js';

const HIGH = 'codex/gpt-5.6-luna:high';
const KNOWN_PI_MODELS = new Set(['opencode-go/qwen3.8-flash', 'google/gemini-3.8-flash', 'openrouter/deepseek/deepseek-v4.1-flash']);

function tooBig(answer: JevAnswer | undefined): boolean { return flag(answer, 'true', true); }
function project(repo: string): string | undefined { return /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : undefined; }
function modelParts(model: string): { provider: string; id: string } | undefined {
  const separator = model.indexOf('/');
  if (separator <= 0) return undefined;
  return { provider: model.slice(0, separator), id: model.slice(separator + 1).replace(/:[^:]+$/, '') };
}
async function defaultAvailable(model: string): Promise<{ available: boolean; reason?: string }> {
  if (model.startsWith('codex/')) return { available: true };
  if (model.startsWith('claude/')) return { available: false, reason: 'no worker lane for claude' };
  if (KNOWN_PI_MODELS.has(model)) return { available: true };
  const parts = modelParts(model);
  if (!parts) return { available: false, reason: 'model has no provider lane' };
  try {
    const { defaultModelRuntime } = await import('./worker.js');
    const runtime = await defaultModelRuntime();
    return runtime.getModel(parts.provider, parts.id) ? { available: true } : { available: false, reason: 'Pi model cannot be resolved' };
  } catch { return { available: false, reason: 'Pi model cannot be resolved' }; }
}
type SkippedCandidate = Readonly<{ model: string; reason: string; tier: number }>;

export function createRouter(options: { settings: Settings; settingsHome?: string; store: Store; jev: Jev; now?: () => Date; resolveProject?: (repo: string) => Promise<string | undefined>; isAvailable?: (model: string) => boolean | Promise<boolean> }): ModelChooser {
  const currentSettings = () => options.settingsHome ? loadSettings(options.settingsHome) : options.settings;
  const availability = async (model: string): Promise<{ available: boolean; reason?: string }> => {
    if (model.startsWith('claude/')) return { available: false, reason: 'no worker lane for claude' };
    if (!options.isAvailable) return defaultAvailable(model);
    try { return await options.isAvailable(model) ? { available: true } : { available: false, reason: 'model is unavailable' }; } catch { return { available: false, reason: 'model is unavailable' }; }
  };
  return async (input: SpawnInput): Promise<ModelChoice> => {
    if (input.model || input.difficulty) return { model: input.model ?? HIGH };
    const settings = currentSettings();
    const projectName = project(input.repo) ?? (options.resolveProject ? await options.resolveProject(input.repo).catch(() => undefined) : undefined);
    const questions = issueQuestions();
    let result: Awaited<ReturnType<Jev['ask']>>;
    try {
      result = await options.jev.ask('route', { ...(projectName ? { project: projectName } : {}), state: { objective: input.objective, acceptance: input.acceptance ?? null }, questions: { complexity: questions.complexity!, too_big: questions.too_big! } });
    } catch { return { model: HIGH }; }
    if (!result.ok) return { model: HIGH };
    const splitRecommended = tooBig(result.answers.too_big);
    const judged = scoreTier(result.answers.complexity);
    if (!judged) return { model: HIGH, ...(splitRecommended ? { warning: 'split recommended' } : {}) };
    const allowed = settings.routing.allowed.length ? new Set(settings.routing.allowed) : undefined;
    const skippedCandidates: SkippedCandidate[] = [];
    for (let tier = judged.tier; tier <= 5; tier += 1) {
      for (const model of settings.routing.tiers[String(tier)] ?? []) {
        if (allowed && !allowed.has(model)) { skippedCandidates.push({ model, reason: 'not allowed by routing.allowed', tier }); continue; }
        const resolved = await availability(model);
        if (!resolved.available) { skippedCandidates.push({ model, reason: `unavailable: ${resolved.reason ?? 'model is unavailable'}`, tier }); continue; }
        const rate = cleanRateForRouting(options.store, model, tier, options.now?.() ?? new Date(), projectName);
        if (rate.n >= settings.routing.minN && rate.clean / rate.n < settings.routing.minClean) { skippedCandidates.push({ model, reason: `clean rate below minClean (${rate.clean}/${rate.n})`, tier }); continue; }
        return { model, tier: judged.tier, score: judged.score, ...(skippedCandidates.length ? { skippedCandidates } : {}), ...(splitRecommended ? { warning: 'split recommended' } : {}) };
      }
    }
    return { model: HIGH, tier: judged.tier, score: judged.score, ...(skippedCandidates.length ? { skippedCandidates } : {}), ...(splitRecommended ? { warning: 'split recommended' } : {}) };
  };
}

export function registerRouting(options: { chooseModel: (chooser: ModelChooser) => void; settings: Settings; settingsHome?: string; store: Store; jev?: Jev; now?: () => Date; resolveProject?: (repo: string) => Promise<string | undefined> }): void {
  if (options.jev) options.chooseModel(createRouter({ settings: options.settings, settingsHome: options.settingsHome, store: options.store, jev: options.jev, now: options.now, resolveProject: options.resolveProject }));
}
