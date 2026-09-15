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
  inputTokens: number;
  outputTokens: number;
}>;

export type BoundedPiAccessPolicy = Readonly<{
  poolId: string;
  /** Prices are USD per one million tokens and must be declared, never fetched at runtime. */
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxContextTokens: number;
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
  private readonly reservations = new Map<string, MonetaryReservation>();
  private readonly settlements = new Map<string, RequestSettlement>();
  private toolCalls = 0;

  constructor(readonly policy: BoundedPiAccessPolicy) {
    positiveInteger(policy.maxInputTokens, 'maxInputTokens');
    positiveInteger(policy.maxOutputTokens, 'maxOutputTokens');
    positiveInteger(policy.maxContextTokens, 'maxContextTokens');
    positiveInteger(policy.maxToolCalls, 'maxToolCalls');
    positiveInteger(policy.timeoutMs, 'timeoutMs');
    nonNegativeFinite(policy.inputUsdPerMillion, 'inputUsdPerMillion');
    nonNegativeFinite(policy.outputUsdPerMillion, 'outputUsdPerMillion');
    if (!policy.poolId) throw new Error('poolId is required');
  }

  prepare(effectId: string, model: Model<Api>, context: unknown, options: ModelsSimpleStreamOptions | undefined): Readonly<{ options: ModelsSimpleStreamOptions; reservation: MonetaryReservation }> {
    if (!effectId || this.reservations.has(effectId)) throw new Error('model request effect identity must be fresh');
    const inputTokens = byteUpperBound({ context, tools: (context as { tools?: unknown }).tools, toolChoice: options?.toolChoice });
    if (inputTokens > this.policy.maxInputTokens) throw new Error('model request input cap refuses request');
    if (inputTokens + this.policy.maxOutputTokens > this.policy.maxContextTokens || inputTokens + this.policy.maxOutputTokens > model.contextWindow) {
      throw new Error('model request context cap refuses request');
    }
    const upperBound = (inputTokens * this.policy.inputUsdPerMillion + this.policy.maxOutputTokens * this.policy.outputUsdPerMillion) / 1_000_000;
    if (!Number.isFinite(upperBound)) throw new Error('model request monetary bound is invalid');
    const reservation: MonetaryReservation = Object.freeze({ poolId: this.policy.poolId, unit: 'usd', upperBound, provider: model.provider, model: model.id, inputTokens, outputTokens: this.policy.maxOutputTokens });
    this.reservations.set(effectId, reservation);
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
    const amount = message.usage?.cost?.total;
    if (!Number.isFinite(amount) || amount < 0 || amount > reservation.upperBound) {
      this.settlements.set(effectId, { state: 'unknown', reason: 'provider usage is absent, invalid, or exceeds the pre-reserved bound' });
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
