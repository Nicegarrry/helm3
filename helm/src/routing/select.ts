import type { JevAnswer } from '../jev.js';
import { cleanRateForRouting } from '../scorecard.js';
import type { Settings } from '../settings.js';
import type { Store } from '../types.js';
import { appliedPolicy, policyAllows, policyReason, type AppliedRoutingPolicy } from './policy.js';
import type { ModelCatalog } from './catalog.js';

export type SkippedCandidate = Readonly<{ model: string; reason: string; tier: number }>;
export type CandidateSelection = Readonly<{
  model?: string;
  tier: number;
  score?: number;
  policyApplied: AppliedRoutingPolicy;
  skippedCandidates?: readonly SkippedCandidate[];
  refusal?: string;
}>;

type Options = Readonly<{
  settings: Settings;
  input: { lanes?: readonly ('codex' | 'pi' | 'claude')[] };
  judgedTier: number;
  score?: number;
  project?: string;
  store: Store;
  catalog: ModelCatalog;
  now: Date;
}>;

/** Shared eligibility check for routing and read-only onboarding diagnostics. */
export async function candidateUnavailableReason(settings: Settings, policy: AppliedRoutingPolicy, catalog: ModelCatalog, model: string): Promise<string | undefined> {
  if (settings.routing.allowed.length > 0 && !settings.routing.allowed.includes(model)) return 'not allowed by routing.allowed';
  if (!policyAllows(policy, model)) return policyReason(policy, model);
  const available = await catalog.availability(model);
  return available.available ? undefined : `unavailable: ${available.reason ?? 'model is unavailable'}`;
}

export async function selectCandidate(options: Options): Promise<CandidateSelection> {
  const policy = appliedPolicy(options.settings, options.input);
  const skipped: SkippedCandidate[] = [];
  const order = [...Array.from({ length: 6 - options.judgedTier }, (_, index) => options.judgedTier + index), ...Array.from({ length: options.judgedTier - 1 }, (_, index) => options.judgedTier - index - 1)];
  for (const tier of order) {
    for (const model of options.settings.routing.tiers[String(tier)] ?? []) {
      const reason = await candidateUnavailableReason(options.settings, policy, options.catalog, model);
      if (reason !== undefined) {
        skipped.push({ model, reason, tier });
        continue;
      }
      const rate = cleanRateForRouting(options.store, model, tier, options.now, options.project);
      if (rate.n >= options.settings.routing.minN && rate.clean / rate.n < options.settings.routing.minClean) {
        skipped.push({ model, reason: `clean rate below minClean (${rate.clean}/${rate.n})`, tier });
        continue;
      }
      return { model, tier: options.judgedTier, ...(options.score === undefined ? {} : { score: options.score }), policyApplied: policy, ...(skipped.length ? { skippedCandidates: skipped } : {}) };
    }
  }
  const policyLanes = policy.lanes.join(', ');
  return { tier: options.judgedTier, ...(options.score === undefined ? {} : { score: options.score }), policyApplied: policy, ...(skipped.length ? { skippedCandidates: skipped } : {}), refusal: `no available routing candidate for tier ${options.judgedTier} under lanes [${policyLanes}]${policy.subscriptionOnly ? ' with subscriptionOnly' : ''}` };
}
