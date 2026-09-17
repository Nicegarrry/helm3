import { Buffer } from 'node:buffer';
import type { AssistantMessage, Model, ModelsSimpleStreamOptions, Api } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };

/**
 * One request's declared worst-case money use. The caller passes this to the
 * kernel resource resolver before the provider stream is consumed.
 */
export type MonetaryReservation = Readonly<{
  poolId: string;
  unit: 'usd';
  upperBound: number;
  provider: string;
  model: string;
  api: Api;
  baseUrl: string;
  /** Identity of the approved credential route, never its value. */
  authEnvironment: string;
  packetBytes: number;
  billedInputTokens: number;
  billedOutputTokens: number;
  openRouterDataPolicy?: 'private' | 'public-training-allowed';
}>;

export type OpenRouterDataPolicy = 'private' | 'public-training-allowed';
export const OPENROUTER_PUBLIC_FREE_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
export const OPENROUTER_PUBLIC_FREE_MODEL_DATED_ALIAS = 'nvidia/nemotron-3-ultra-550b-a55b-20260604:free';
const PUBLIC_FREE_SYSTEM_MESSAGE = 'You are a bounded Helm worker. Use only the supplied public objective and acceptance instructions. Return the requested result.';

export type BoundedPiAccessPolicy = Readonly<{
  poolId: string;
  /** Frozen identity and endpoint facts; a model catalog change refuses the request. */
  provider: string;
  model: string;
  api: Api;
  baseUrl: string;
  /** Identity of the approved credential route, never its value. */
  authEnvironment: string;
  contextWindow: number;
  /** Hard request output cap sent to Pi. */
  maxOutputTokens: number;
  /** Worst-case output charge, including hidden reasoning when applicable. */
  maxBilledOutputTokens: number;
  /** A separate packet-size guard, not a claim about provider tokenisation. */
  maxPacketBytes: number;
  maxRequests: number;
  /** Prices are USD per one million tokens and must be declared, never fetched at runtime. */
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  maxToolCalls: number;
  timeoutMs: number;
  /** Live access defaults to no automatic envelope-repair follow-up. */
  allowCorrection?: boolean;
  /** Required for OpenRouter: final provider routing is enforced after Pi assembles the payload. */
  openRouterRouting?: Readonly<Record<string, unknown>>;
  openRouterDataPolicy?: OpenRouterDataPolicy;
  dataClassification?: 'public' | 'restricted';
  contextRefs?: readonly string[];
  readableRoots?: readonly string[];
}>;

export type RequestSettlement = { state: 'known'; amount: number } | { state: 'unknown'; reason: string };

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}
function nonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
}
function byteUpperBound(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { throw new Error('model request cannot be safely serialized for an input bound'); }
}
function safeToken(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function combinedSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/**
 * Provider-free gate used at the Pi HTTP boundary. It never resolves a key,
 * discovers a model, retries, or chooses another provider. Unknown final
 * usage deliberately leaves the kernel reservation outstanding.
 */
export class BoundedPiAccess {
  readonly policy: BoundedPiAccessPolicy;
  private readonly reservations = new Map<string, MonetaryReservation>();
  private readonly settlements = new Map<string, RequestSettlement>();
  private toolCalls = 0;
  private requestCount = 0;

  constructor(policy: BoundedPiAccessPolicy) {
    const keys = ['poolId', 'provider', 'model', 'api', 'baseUrl', 'authEnvironment', 'contextWindow', 'maxOutputTokens', 'maxBilledOutputTokens', 'maxPacketBytes', 'maxRequests', 'inputUsdPerMillion', 'outputUsdPerMillion', 'cacheReadUsdPerMillion', 'cacheWriteUsdPerMillion', 'maxToolCalls', 'timeoutMs', 'allowCorrection', 'openRouterRouting', 'openRouterDataPolicy', 'dataClassification', 'contextRefs', 'readableRoots'];
    if (typeof policy !== 'object' || policy === null || Object.keys(policy).some((key) => !keys.includes(key))) throw new Error('bounded Pi access policy has unknown fields');
    if (typeof policy.poolId !== 'string' || typeof policy.provider !== 'string' || typeof policy.model !== 'string' || typeof policy.api !== 'string' || typeof policy.baseUrl !== 'string' || typeof policy.authEnvironment !== 'string' || typeof policy.allowCorrection !== 'undefined' && typeof policy.allowCorrection !== 'boolean') {
      throw new Error('bounded Pi access policy has invalid identity fields');
    }
    positiveInteger(policy.maxOutputTokens, 'maxOutputTokens');
    positiveInteger(policy.maxBilledOutputTokens, 'maxBilledOutputTokens');
    positiveInteger(policy.contextWindow, 'contextWindow');
    positiveInteger(policy.maxPacketBytes, 'maxPacketBytes');
    positiveInteger(policy.maxRequests, 'maxRequests');
    if (!Number.isSafeInteger(policy.maxToolCalls) || policy.maxToolCalls < 0) throw new Error('maxToolCalls must be a non-negative safe integer');
    positiveInteger(policy.timeoutMs, 'timeoutMs');
    nonNegativeFinite(policy.inputUsdPerMillion, 'inputUsdPerMillion');
    nonNegativeFinite(policy.outputUsdPerMillion, 'outputUsdPerMillion');
    nonNegativeFinite(policy.cacheReadUsdPerMillion, 'cacheReadUsdPerMillion');
    nonNegativeFinite(policy.cacheWriteUsdPerMillion, 'cacheWriteUsdPerMillion');
    if (!policy.poolId || !policy.provider || !policy.model || !policy.api || !policy.baseUrl || !policy.authEnvironment) throw new Error('pool and frozen provider facts are required');
    if (policy.provider === 'openrouter' && !policy.openRouterRouting) throw new Error('OpenRouter routing policy is required');
    if (policy.provider !== 'openrouter' && policy.openRouterRouting) throw new Error('OpenRouter routing policy is only valid for OpenRouter');
    if (policy.openRouterDataPolicy !== undefined && policy.openRouterDataPolicy !== 'private' && policy.openRouterDataPolicy !== 'public-training-allowed') throw new Error('OpenRouter data policy is invalid');
    if (policy.openRouterDataPolicy === 'public-training-allowed') {
      if (policy.provider !== 'openrouter' || ![OPENROUTER_PUBLIC_FREE_MODEL, OPENROUTER_PUBLIC_FREE_MODEL_DATED_ALIAS].includes(policy.model)) throw new Error('public-training-allowed requires the pinned NVIDIA Nemotron free model');
      if (policy.dataClassification !== 'public' || !Array.isArray(policy.contextRefs) || policy.contextRefs.length !== 0 || !Array.isArray(policy.readableRoots) || policy.readableRoots.length !== 0) throw new Error('public-training-allowed requires an empty public context attestation');
      const route = policy.openRouterRouting;
      if (!route || JSON.stringify(route.only) !== JSON.stringify(['nvidia']) || route.allow_fallbacks !== false || route.require_parameters !== true || route.data_collection !== 'allow' || route.zdr !== false || (route.max_price as Record<string, unknown> | undefined)?.prompt !== 0 || (route.max_price as Record<string, unknown> | undefined)?.completion !== 0) throw new Error('public-training-allowed OpenRouter route is unsafe');
      if (policy.inputUsdPerMillion !== 0 || policy.outputUsdPerMillion !== 0 || policy.cacheReadUsdPerMillion !== 0 || policy.cacheWriteUsdPerMillion !== 0) throw new Error('public-training-allowed requires zero declared costs');
    }
    let pinnedRoute: Readonly<Record<string, unknown>> | undefined;
    if (policy.openRouterRouting) {
      if (policy.api !== 'openai-completions' || policy.baseUrl !== 'https://openrouter.ai/api/v1') throw new Error('OpenRouter requires its pinned API and endpoint');
      const route = policy.openRouterRouting;
      const permitted = ['only', 'allow_fallbacks', 'require_parameters', 'data_collection', 'zdr', 'max_price', 'quantizations'];
      if (Object.keys(route).some(key => !permitted.includes(key)) || route.allow_fallbacks !== false || route.require_parameters !== true || !['deny', 'allow'].includes(route.data_collection as string) || typeof route.zdr !== 'boolean' || !Array.isArray(route.only) || route.only.length === 0 || route.only.length > 8 || route.only.some(provider => typeof provider !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}(?:\/[a-z0-9-]+)?$/.test(provider))) throw new Error('OpenRouter routing policy is unsafe');
      if (policy.openRouterDataPolicy !== 'public-training-allowed' && (route.data_collection !== 'deny' || route.zdr !== true)) throw new Error('private OpenRouter routing policy is unsafe');
      const prices = route.max_price as Record<string, unknown> | undefined;
      if (!prices || Object.keys(prices).some(key => !['prompt', 'completion'].includes(key)) || typeof prices.prompt !== 'number' || !Number.isFinite(prices.prompt) || prices.prompt < 0 || prices.prompt > policy.inputUsdPerMillion || typeof prices.completion !== 'number' || !Number.isFinite(prices.completion) || prices.completion < 0 || prices.completion > policy.outputUsdPerMillion) throw new Error('OpenRouter price caps must fit the bounded policy');
      const quantizations = route.quantizations;
      if (quantizations !== undefined && (!Array.isArray(quantizations) || quantizations.length === 0 || quantizations.length > 8 || quantizations.some(value => !['int4', 'int8', 'fp4', 'fp6', 'fp8', 'fp16', 'bf16', 'fp32'].includes(value)))) throw new Error('OpenRouter quantization allowlist is invalid');
      // Copy and freeze nested routing fields: caller-owned arrays or price
      // objects must not widen an already admitted request later.
      pinnedRoute = Object.freeze({ ...route, only: Object.freeze([...route.only]), max_price: Object.freeze({ ...prices }), ...(Array.isArray(quantizations) ? { quantizations: Object.freeze([...quantizations]) } : {}) });
    }
    if (policy.maxOutputTokens > policy.maxBilledOutputTokens) throw new Error('hard output cap cannot exceed billed output bound');
    this.policy = Object.freeze({
      poolId: policy.poolId, provider: policy.provider, model: policy.model, api: policy.api, baseUrl: policy.baseUrl, authEnvironment: policy.authEnvironment,
      contextWindow: policy.contextWindow, maxOutputTokens: policy.maxOutputTokens, maxBilledOutputTokens: policy.maxBilledOutputTokens,
      maxPacketBytes: policy.maxPacketBytes, maxRequests: policy.maxRequests, inputUsdPerMillion: policy.inputUsdPerMillion,
      outputUsdPerMillion: policy.outputUsdPerMillion, cacheReadUsdPerMillion: policy.cacheReadUsdPerMillion,
      cacheWriteUsdPerMillion: policy.cacheWriteUsdPerMillion, maxToolCalls: policy.maxToolCalls, timeoutMs: policy.timeoutMs,
      ...(policy.allowCorrection === undefined ? {} : { allowCorrection: policy.allowCorrection }),
      ...(pinnedRoute === undefined ? {} : { openRouterRouting: pinnedRoute }),
      ...(policy.openRouterDataPolicy === undefined ? {} : { openRouterDataPolicy: policy.openRouterDataPolicy }),
      ...(policy.dataClassification === undefined ? {} : { dataClassification: policy.dataClassification }),
      ...(policy.contextRefs === undefined ? {} : { contextRefs: Object.freeze([...policy.contextRefs]) }),
      ...(policy.readableRoots === undefined ? {} : { readableRoots: Object.freeze([...policy.readableRoots]) }),
    });
  }

  prepare(effectId: string, model: Model<Api>, context: unknown, options: ModelsSimpleStreamOptions | undefined): Readonly<{ options: ModelsSimpleStreamOptions; reservation: MonetaryReservation }> {
    if (!effectId || this.reservations.has(effectId)) throw new Error('model request effect identity must be fresh');
    if (this.requestCount >= this.policy.maxRequests) throw new Error('model request count cap refuses request');
    if (model.provider !== this.policy.provider || model.id !== this.policy.model || model.api !== this.policy.api || model.baseUrl !== this.policy.baseUrl || model.contextWindow !== this.policy.contextWindow || model.maxTokens < this.policy.maxBilledOutputTokens) {
      throw new Error('model request does not match frozen provider facts');
    }
    const packetBytes = byteUpperBound({ context, toolChoice: options?.toolChoice });
    if (packetBytes > this.policy.maxPacketBytes) throw new Error('model request packet cap refuses request');
    // Provider tokenisation is not locally provable. Reserve the pinned full
    // context window and declared worst-case output rather than inferring them
    // from JSON bytes.
    const upperBound = (this.policy.contextWindow * (this.policy.inputUsdPerMillion + this.policy.cacheReadUsdPerMillion + this.policy.cacheWriteUsdPerMillion) + this.policy.maxBilledOutputTokens * this.policy.outputUsdPerMillion) / 1_000_000;
    if (!Number.isFinite(upperBound)) throw new Error('model request monetary bound is invalid');
    const reservation: MonetaryReservation = Object.freeze({ poolId: this.policy.poolId, unit: 'usd', upperBound, provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, authEnvironment: this.policy.authEnvironment, packetBytes, billedInputTokens: this.policy.contextWindow, billedOutputTokens: this.policy.maxBilledOutputTokens, ...(this.policy.openRouterDataPolicy ? { openRouterDataPolicy: this.policy.openRouterDataPolicy } : {}) });
    this.reservations.set(effectId, reservation);
    this.requestCount += 1;
    return Object.freeze({
      reservation,
      options: {
        ...options,
        maxRetries: 0,
        maxTokens: this.policy.maxOutputTokens,
        signal: combinedSignal(this.policy.timeoutMs, options?.signal),
        ...(this.policy.openRouterRouting ? {
          onPayload: async (payload: unknown, selectedModel: Model<Api>) => {
            const replacement = await options?.onPayload?.(payload, selectedModel);
            const callerPayload = replacement === undefined ? payload : replacement;
            if (!callerPayload || typeof callerPayload !== 'object' || Array.isArray(callerPayload)) throw new Error('OpenRouter payload is not an object');
            if (['models', 'route', 'plugins', 'service_tier'].some(key => key in callerPayload)) throw new Error('OpenRouter auxiliary routing or billable features are not authorised');
            const { max_tokens: _maxTokens, max_completion_tokens: _maxCompletionTokens, ...rest } = callerPayload as Record<string, unknown>;
            if (this.policy.openRouterDataPolicy === 'public-training-allowed') {
              if (!Array.isArray(rest.messages)) throw new Error('public OpenRouter messages must be an array');
              const messages = (rest.messages as readonly unknown[]).filter((message) => {
                if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('public OpenRouter message is invalid');
                const role = (message as { role?: unknown }).role;
                if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role as string)) throw new Error('public OpenRouter message role is not permitted');
                return role !== 'system' && role !== 'developer';
              });
              rest.messages = [{ role: 'system', content: PUBLIC_FREE_SYSTEM_MESSAGE }, ...messages];
            }
            const finalPayload = { ...rest, model: this.policy.model, max_completion_tokens: this.policy.maxOutputTokens, provider: this.policy.openRouterRouting };
            if (byteUpperBound(finalPayload) > this.policy.maxPacketBytes) throw new Error('OpenRouter final payload exceeds the packet cap');
            return finalPayload;
          },
        } : {}),
      },
    });
  }

  reservation(effectId: string): MonetaryReservation {
    const value = this.reservations.get(effectId);
    if (!value) throw new Error('model request reservation is absent');
    return value;
  }

  settle(effectId: string, message: AssistantMessage): void {
    const reservation = this.reservation(effectId);
    const usage = message.usage;
    if (message.provider !== reservation.provider || message.model !== reservation.model || message.api !== reservation.api
      || !safeToken(usage?.input) || !safeToken(usage?.output) || !safeToken(usage?.cacheRead) || !safeToken(usage?.cacheWrite)
      || !safeToken(usage?.totalTokens) || (usage.reasoning !== undefined && (!safeToken(usage.reasoning) || usage.reasoning > usage.output))) {
      this.settlements.set(effectId, { state: 'unknown', reason: 'provider identity or token telemetry is not validated' });
      return;
    }
    const billedInput = usage.input + usage.cacheRead + usage.cacheWrite;
    const observedTotal = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (usage.totalTokens === 0 || usage.totalTokens !== observedTotal || billedInput > this.policy.contextWindow || usage.output > this.policy.maxBilledOutputTokens) {
      this.settlements.set(effectId, { state: 'unknown', reason: 'provider token telemetry is zero, inconsistent, or exceeds a frozen cap' });
      return;
    }
    const amount = (usage.input * this.policy.inputUsdPerMillion + usage.output * this.policy.outputUsdPerMillion + usage.cacheRead * this.policy.cacheReadUsdPerMillion + usage.cacheWrite * this.policy.cacheWriteUsdPerMillion) / 1_000_000;
    if (!Number.isFinite(amount) || amount > reservation.upperBound) {
      this.settlements.set(effectId, { state: 'unknown', reason: 'priced token telemetry exceeds the pre-reserved bound' });
      return;
    }
    this.settlements.set(effectId, { state: 'known', amount });
  }

  unknown(effectId: string, reason: string): void {
    this.reservation(effectId);
    this.settlements.set(effectId, { state: 'unknown', reason });
  }

  settlement(effectId: string): RequestSettlement | undefined { return this.settlements.get(effectId); }
  hasReservation(effectId: string): boolean { return this.reservations.has(effectId); }

  noteToolCall(): void {
    if (this.toolCalls >= this.policy.maxToolCalls) throw new Error('model request tool-call cap refuses tool effect');
    this.toolCalls += 1;
  }

  get correctionAllowed(): boolean { return this.policy.allowCorrection === true; }
}
