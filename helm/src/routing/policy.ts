import type { Settings } from '../settings.js';
import type { SpawnInput } from '../helm.js';

export type RoutingLane = 'codex' | 'pi' | 'claude';
export type RoutingPolicy = Readonly<{ lanes?: readonly RoutingLane[]; subscriptionOnly: boolean }>;
export type AppliedRoutingPolicy = Readonly<{ lanes: readonly RoutingLane[]; subscriptionOnly: boolean }>;

export function laneForModel(model: string): RoutingLane {
  if (model.startsWith('codex/')) return 'codex';
  if (model.startsWith('claude/')) return 'claude';
  return 'pi';
}

export function appliedPolicy(settings: Settings, input: { lanes?: readonly RoutingLane[] }): AppliedRoutingPolicy {
  const configured = settings.routing.policy ?? { subscriptionOnly: false };
  const configuredLanes = configured.lanes ?? ['codex', 'pi', 'claude'];
  const lanes = input.lanes ? configuredLanes.filter((lane) => input.lanes!.includes(lane)) : configuredLanes;
  return { lanes: [...lanes], subscriptionOnly: configured.subscriptionOnly ?? false };
}

export function policyAllows(policy: AppliedRoutingPolicy, model: string): boolean {
  const lane = laneForModel(model);
  if (!policy.lanes.includes(lane)) return false;
  return !policy.subscriptionOnly || lane === 'codex' || lane === 'claude';
}

export function policyReason(policy: AppliedRoutingPolicy, model: string): string {
  const lane = laneForModel(model);
  if (!policy.lanes.includes(lane)) return `lane '${lane}' is not in the applied routing policy`;
  return 'subscriptionOnly excludes paid API lanes';
}
