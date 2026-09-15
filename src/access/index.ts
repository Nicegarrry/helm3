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
}>;

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
    const keys = ['poolId', 'provider', 'model', 'api', 'baseUrl', 'authEnvironment', 'contextWindow', 'maxOutputTokens', 'maxBilledOutputTokens', 'maxPacketBytes', 'maxRequests', 'inputUsdPerMillion', 'outputUsdPerMillion', 'cacheReadUsdPerMillion', 'cacheWriteUsdPerMillion', 'maxToolCalls', 'timeoutMs', 'allowCorrection'];
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
    if (policy.maxOutputTokens > policy.maxBilledOutputTokens) throw new Error('hard output cap cannot exceed billed output bound');
    this.policy = Object.freeze({
      poolId: policy.poolId, provider: policy.provider, model: policy.model, api: policy.api, baseUrl: policy.baseUrl, authEnvironment: policy.authEnvironment,
      contextWindow: policy.contextWindow, maxOutputTokens: policy.maxOutputTokens, maxBilledOutputTokens: policy.maxBilledOutputTokens,
      maxPacketBytes: policy.maxPacketBytes, maxRequests: policy.maxRequests, inputUsdPerMillion: policy.inputUsdPerMillion,
      outputUsdPerMillion: policy.outputUsdPerMillion, cacheReadUsdPerMillion: policy.cacheReadUsdPerMillion,
      cacheWriteUsdPerMillion: policy.cacheWriteUsdPerMillion, maxToolCalls: policy.maxToolCalls, timeoutMs: policy.timeoutMs,
      ...(policy.allowCorrection === undefined ? {} : { allowCorrection: policy.allowCorrection }),
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
    const reservation: MonetaryReservation = Object.freeze({ poolId: this.policy.poolId, unit: 'usd', upperBound, provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, authEnvironment: this.policy.authEnvironment, packetBytes, billedInputTokens: this.policy.contextWindow, billedOutputTokens: this.policy.maxBilledOutputTokens });
    this.reservations.set(effectId, reservation);
    this.requestCount += 1;
    return Object.freeze({
      reservation,
      options: { ...options, maxRetries: 0, maxTokens: this.policy.maxOutputTokens, signal: combinedSignal(this.policy.timeoutMs, options?.signal) },
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
