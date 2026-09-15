import type { ModelFact, ResourceRequest } from '../core/index.js';

export type PoolKind = 'subscription' | 'api' | 'topup';
export type ModelRole = 'builder' | 'reviewer' | 'consultant' | 'orchestrator';
export type DataClassification = 'public' | 'restricted';
export type Availability = 'known_available' | 'known_unavailable' | 'unknown';

export type ResourcePool = Readonly<{ poolId: string; kind: PoolKind; unit: string }>;
export type ModelProfile = Readonly<{
  modelId: string;
  provider: string;
  family: string;
  poolId: string;
  enabled: boolean;
  availability: Availability;
  roles: readonly ModelRole[];
  buildCapabilities: readonly string[];
  reviewCapabilities: readonly string[];
  dataPolicy: 'public-only' | 'restricted-ok';
  observedAt: string;
}>;
export type QuotaObservation = Readonly<{
  poolId: string;
  state: 'known' | 'unknown' | 'unavailable';
  remaining?: number;
  resetAt?: string;
  observedAt: string;
  detail?: string;
}>;
export type EconomySnapshot = Readonly<{ pools: readonly ResourcePool[]; models: readonly ModelProfile[]; quota: readonly QuotaObservation[] }>;

/**
 * Projects a richer registry row into the immutable fact shape Core admits.
 * `capabilities` intentionally contains both build and review facts; callers
 * still pass the role-specific required floor through `KernelKind.modelSelection`.
 */
export function toCoreModelFact(profile: ModelProfile, factVersion: number): ModelFact {
  if (!Number.isInteger(factVersion) || factVersion <= 0) throw new Error('fact version must be a positive integer');
  return {
    modelId: profile.modelId, provider: profile.provider, poolId: profile.poolId, enabled: profile.enabled,
    capabilities: [...new Set([...profile.buildCapabilities, ...profile.reviewCapabilities])].sort(),
    roles: [...profile.roles].sort(), availability: profile.availability, factVersion, observedAt: profile.observedAt,
  };
}

/**
 * This adapter is implemented by the Core command-admission path. Economy
 * never tracks reservations itself: Core remains authoritative for lease,
 * reserve, override and actual-use state.
 */
export interface DispatchAuthority {
  assertReservation(request: ResourceRequest): void;
}

export type EligibilityRequest = Readonly<{
  modelId: string;
  role: ModelRole;
  requiredCapabilities: readonly string[];
  dataClassification: DataClassification;
  resource?: ResourceRequest;
}>;
export type Eligibility = Readonly<{ eligible: true } | { eligible: false; code: 'unknown_model' | 'disabled_model' | 'availability' | 'availability_unknown' | 'data_policy' | 'role' | 'capability' | 'pool_mismatch' | 'unattested_human_override' | 'authority'; detail: string }>;

function requireId(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    requireId(value, label);
    if (seen.has(value)) throw new Error(`${label} must be unique`);
    seen.add(value);
  }
}

function validate(snapshot: EconomySnapshot): void {
  unique(snapshot.pools.map((pool) => pool.poolId), 'pool id');
  unique(snapshot.models.map((model) => model.modelId), 'model id');
  unique(snapshot.quota.map((quota) => quota.poolId), 'quota pool id');
  const pools = new Set(snapshot.pools.map((pool) => pool.poolId));
  for (const model of snapshot.models) {
    requireId(model.provider, 'provider'); requireId(model.family, 'family');
    if (!pools.has(model.poolId)) throw new Error('model refers to an unknown pool');
    unique(model.roles, 'model role'); unique(model.buildCapabilities, 'build capability'); unique(model.reviewCapabilities, 'review capability');
  }
  for (const quota of snapshot.quota) {
    if (!pools.has(quota.poolId)) throw new Error('quota refers to an unknown pool');
    if (quota.state === 'known' && (!Number.isFinite(quota.remaining) || quota.remaining === undefined || quota.remaining < 0)) throw new Error('known quota requires a non-negative remaining value');
  }
}

function refusal(code: Exclude<Eligibility, { eligible: true }>['code'], detail: string): Eligibility { return { eligible: false, code, detail }; }

export function createEconomy(input: EconomySnapshot, authority: DispatchAuthority) {
  validate(input);
  const pools = new Map(input.pools.map((pool) => [pool.poolId, Object.freeze({ ...pool })]));
  const models = new Map(input.models.map((model) => [model.modelId, Object.freeze({ ...model, roles: [...model.roles], buildCapabilities: [...model.buildCapabilities], reviewCapabilities: [...model.reviewCapabilities] })]));
  const quota = new Map(input.quota.map((observation) => [observation.poolId, Object.freeze({ ...observation })]));

  return Object.freeze({
    snapshot(): EconomySnapshot {
      return { pools: [...pools.values()].sort((a, b) => a.poolId.localeCompare(b.poolId)), models: [...models.values()].sort((a, b) => a.modelId.localeCompare(b.modelId)), quota: [...quota.values()].sort((a, b) => a.poolId.localeCompare(b.poolId)) };
    },
    quota(poolId: string): QuotaObservation {
      requireId(poolId, 'pool id');
      return quota.get(poolId) ?? { poolId, state: 'unknown', observedAt: '', detail: 'no provider observation' };
    },
    /** A compact, pre-admission explanation. Core is still the final refusal gate. */
    eligible(request: EligibilityRequest): Eligibility {
      const model = models.get(request.modelId);
      if (!model) return refusal('unknown_model', 'model has no registered facts');
      if (!model.enabled) return refusal('disabled_model', 'model is disabled');
      if (model.availability === 'unknown') return refusal('availability_unknown', 'model availability is unknown');
      if (model.availability !== 'known_available') return refusal('availability', 'model is not known available');
      if (request.dataClassification === 'restricted' && model.dataPolicy !== 'restricted-ok') return refusal('data_policy', 'model policy does not permit restricted data');
      if (!model.roles.includes(request.role)) return refusal('role', 'model lacks the requested role');
      const capabilities = request.role === 'reviewer' ? model.reviewCapabilities : model.buildCapabilities;
      if (request.requiredCapabilities.some((capability) => !capabilities.includes(capability))) return refusal('capability', 'model lacks a required capability');
      if (!request.resource) return { eligible: true };
      if (request.resource.poolId !== model.poolId) return refusal('pool_mismatch', 'resource pool does not match the model pool');
      const pool = pools.get(model.poolId)!;
      if (request.resource.unit !== pool.unit) return refusal('pool_mismatch', 'resource unit does not match the model pool');
      // An opaque override id in a model-originated request is never proof of a human ruling.
      // A privileged host may attest an exception directly to the core authority before calling here.
      if (request.resource.humanOverrideId) return refusal('unattested_human_override', 'reserve override must be attested by the privileged host');
      try { authority.assertReservation(request.resource); } catch (error) { return refusal('authority', error instanceof Error ? error.message : 'reservation authority refused request'); }
      return { eligible: true };
    },
  });
}
