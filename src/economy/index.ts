import { z } from 'zod/v3';
import type { ModelFact, ResourceRequest } from '../core/index.js';

export type PoolKind = 'subscription' | 'api' | 'topup';
export type ModelRole = 'builder' | 'reviewer' | 'consultant' | 'orchestrator';
export type DataClassification = 'public' | 'restricted';
export type Availability = 'known_available' | 'known_unavailable' | 'unknown';
export type ResourcePool = Readonly<{ poolId: string; kind: PoolKind; unit: string }>;
export type ModelProfile = Readonly<{ modelId: string; provider: string; family: string; poolId: string; enabled: boolean; availability: Availability; roles: readonly ModelRole[]; buildCapabilities: readonly string[]; reviewCapabilities: readonly string[]; dataPolicy: 'public-only' | 'restricted-ok'; observedAt: string }>;
export type QuotaObservation = Readonly<{ poolId: string; state: 'known'; remaining: number; resetAt?: string; observedAt: string; detail?: string } | { poolId: string; state: 'unknown' | 'unavailable'; observedAt: string; detail: string }>;
export type UnobservedQuota = Readonly<{ poolId: string; state: 'unknown'; detail: 'no provider observation' }>;
export type EconomySnapshot = Readonly<{ pools: readonly ResourcePool[]; models: readonly ModelProfile[]; quota: readonly QuotaObservation[] }>;

const identifier = z.string().min(1);
const instant = z.string().datetime({ offset: false });
const role = z.enum(['builder', 'reviewer', 'consultant', 'orchestrator']);
const poolSchema = z.object({ poolId: identifier, kind: z.enum(['subscription', 'api', 'topup']), unit: identifier }).strict();
const modelSchema = z.object({ modelId: identifier, provider: identifier, family: identifier, poolId: identifier, enabled: z.boolean(), availability: z.enum(['known_available', 'known_unavailable', 'unknown']), roles: z.array(role).min(1), buildCapabilities: z.array(identifier), reviewCapabilities: z.array(identifier), dataPolicy: z.enum(['public-only', 'restricted-ok']), observedAt: instant }).strict();
const quotaSchema = z.discriminatedUnion('state', [
  z.object({ poolId: identifier, state: z.literal('known'), remaining: z.number().finite().nonnegative(), resetAt: instant.optional(), observedAt: instant, detail: z.string().min(1).optional() }).strict(),
  z.object({ poolId: identifier, state: z.enum(['unknown', 'unavailable']), observedAt: instant, detail: z.string().min(1) }).strict(),
]);
const snapshotSchema = z.object({ pools: z.array(poolSchema), models: z.array(modelSchema), quota: z.array(quotaSchema) }).strict();

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function parseSnapshot(input: EconomySnapshot, now: string): EconomySnapshot {
  const snapshot = snapshotSchema.parse(input) as EconomySnapshot;
  unique(snapshot.pools.map((pool) => pool.poolId), 'pool id');
  unique(snapshot.models.map((model) => model.modelId), 'model id');
  unique(snapshot.quota.map((quota) => quota.poolId), 'quota pool id');
  const pools = new Set(snapshot.pools.map((pool) => pool.poolId));
  for (const model of snapshot.models) {
    if (!pools.has(model.poolId)) throw new Error('model refers to an unknown pool');
    if (Date.parse(model.observedAt) > Date.parse(now)) throw new Error('model observation cannot be from the future');
    unique(model.roles, 'model role'); unique(model.buildCapabilities, 'build capability'); unique(model.reviewCapabilities, 'review capability');
  }
  for (const quota of snapshot.quota) {
    if (!pools.has(quota.poolId)) throw new Error('quota refers to an unknown pool');
    if (Date.parse(quota.observedAt) > Date.parse(now)) throw new Error('quota observation cannot be from the future');
  }
  return snapshot;
}

function frozenPool(pool: ResourcePool): ResourcePool { return Object.freeze({ ...pool }); }
function frozenModel(model: ModelProfile): ModelProfile { return Object.freeze({ ...model, roles: Object.freeze([...model.roles]), buildCapabilities: Object.freeze([...model.buildCapabilities]), reviewCapabilities: Object.freeze([...model.reviewCapabilities]) }); }
function frozenQuota(observation: QuotaObservation): QuotaObservation { return Object.freeze({ ...observation }); }

/** Projects a registry row into Core's role-aware, versioned admission fact. */
export function toCoreModelFact(input: ModelProfile, factVersion: number): ModelFact {
  const profile = modelSchema.parse(input) as ModelProfile;
  if (!Number.isInteger(factVersion) || factVersion <= 0) throw new Error('fact version must be a positive integer');
  const capabilitiesByRole: Record<string, readonly string[]> = {};
  for (const item of profile.roles) capabilitiesByRole[item] = Object.freeze([...(item === 'reviewer' ? profile.reviewCapabilities : profile.buildCapabilities)]);
  return Object.freeze({
    modelId: profile.modelId, provider: profile.provider, poolId: profile.poolId, enabled: profile.enabled,
    capabilities: [...new Set([...profile.buildCapabilities, ...profile.reviewCapabilities])].sort(), roles: [...profile.roles].sort(), capabilitiesByRole: Object.freeze(capabilitiesByRole),
    availability: profile.availability, factVersion, observedAt: profile.observedAt,
  });
}

/** Core command admission owns reservations, human exceptions, and actual use. */
export interface DispatchAuthority { assertReservation(request: ResourceRequest): void; }
export type EligibilityRequest = Readonly<{ modelId: string; role: ModelRole; requiredCapabilities: readonly string[]; dataClassification: DataClassification; resource?: ResourceRequest }>;
export type Eligibility = Readonly<{ eligible: true } | { eligible: false; code: 'unknown_model' | 'disabled_model' | 'availability' | 'availability_unknown' | 'data_policy' | 'role' | 'capability' | 'pool_mismatch' | 'unattested_human_override' | 'authority'; detail: string }>;
function refusal(code: Exclude<Eligibility, { eligible: true }>['code'], detail: string): Eligibility { return { eligible: false, code, detail }; }

export function createEconomy(input: EconomySnapshot, authority: DispatchAuthority, options: Readonly<{ now?: () => string }> = {}) {
  const now = options.now?.() ?? new Date().toISOString();
  instant.parse(now);
  const inputSnapshot = parseSnapshot(input, now);
  const pools = new Map(inputSnapshot.pools.map((pool) => [pool.poolId, frozenPool(pool)]));
  const models = new Map(inputSnapshot.models.map((model) => [model.modelId, frozenModel(model)]));
  const quota = new Map(inputSnapshot.quota.map((observation) => [observation.poolId, frozenQuota(observation)]));
  return Object.freeze({
    snapshot(): EconomySnapshot { return Object.freeze({ pools: Object.freeze([...pools.values()].sort((a, b) => a.poolId.localeCompare(b.poolId))), models: Object.freeze([...models.values()].sort((a, b) => a.modelId.localeCompare(b.modelId))), quota: Object.freeze([...quota.values()].sort((a, b) => a.poolId.localeCompare(b.poolId))) }); },
    quota(poolId: string): QuotaObservation | UnobservedQuota { identifier.parse(poolId); return quota.get(poolId) ?? Object.freeze({ poolId, state: 'unknown', detail: 'no provider observation' as const }); },
    /** Compact pre-admission explanation; Core remains the final command/refusal gate. */
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
      if (request.resource.poolId !== model.poolId || request.resource.unit !== pools.get(model.poolId)!.unit) return refusal('pool_mismatch', 'resource pool or unit does not match the model pool');
      if (request.resource.humanOverrideId) return refusal('unattested_human_override', 'reserve override must be attested by the privileged host');
      try { authority.assertReservation(request.resource); } catch (error) { return refusal('authority', error instanceof Error ? error.message : 'reservation authority refused request'); }
      return { eligible: true };
    },
  });
}
