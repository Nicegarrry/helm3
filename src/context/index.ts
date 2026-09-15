import { createHash } from 'node:crypto';
import type { ContextUsage } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { z } from 'zod/v3';

const ref = z.object({ ref: z.string().min(1), version: z.string().min(1), digest: z.string().min(1) }).strict();
const packet = z.object({ schemaVersion: z.literal(1), objective: ref, acceptance: ref, brief: ref.array(), map: ref.array(), decisions: ref.array(), handoffs: ref.array() }).strict();
export type ContextRef = z.infer<typeof ref>;
export type WorkerContextPacket = Readonly<{ schemaVersion: 1; objective: ContextRef; acceptance: ContextRef; brief: readonly ContextRef[]; map: readonly ContextRef[]; decisions: readonly ContextRef[]; handoffs: readonly ContextRef[]; digest: string }>;
const trustedPacketConfig = z.object({ maxBytes: z.number().int().positive().safe() }).strict();
/** This configuration is supplied by the trusted host policy, never by a worker packet or tool call. */
export type TrustedContextPacketConfig = Readonly<z.infer<typeof trustedPacketConfig>>;

/** Caller judgement selects refs; the trusted host sets the byte limit and Helm refuses rather than truncates. */
export function createWorkerContextPacket(input: Omit<z.infer<typeof packet>, 'schemaVersion'>, trustedHost: TrustedContextPacketConfig): WorkerContextPacket {
  const { maxBytes } = trustedPacketConfig.parse(trustedHost);
  const parsed = packet.parse({ schemaVersion: 1, ...input }); const bytes = Buffer.from(JSON.stringify(parsed));
  if (bytes.length > maxBytes) throw new Error('context packet exceeds its explicit byte limit');
  return Object.freeze({ ...parsed, objective: Object.freeze({ ...parsed.objective }), acceptance: Object.freeze({ ...parsed.acceptance }), brief: Object.freeze(parsed.brief.map(x => Object.freeze({ ...x }))), map: Object.freeze(parsed.map.map(x => Object.freeze({ ...x }))), decisions: Object.freeze(parsed.decisions.map(x => Object.freeze({ ...x }))), handoffs: Object.freeze(parsed.handoffs.map(x => Object.freeze({ ...x })),), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
}

export type PiContextUsage = Pick<ContextUsage, 'tokens' | 'contextWindow' | 'percent'>;
export type PiContextSession = Readonly<{ getContextUsage: () => PiContextUsage | undefined }>;
export type ContextOccupancy = Readonly<{ state: 'known'; tokens: number; window: number; percent: number; estimate: true; source: 'pi.session.getContextUsage' } | { state: 'unknown'; tokens: null; window: null; percent: null; estimate: true; source: 'pi.session.getContextUsage'; reason: string }>;
export function observePiContext(session: PiContextSession): ContextOccupancy {
  try {
    const usage = session.getContextUsage();
    if (!usage || typeof usage.tokens !== 'number' || !Number.isFinite(usage.tokens) || usage.tokens < 0 || !Number.isSafeInteger(usage.tokens)) throw Error('usage unavailable');
    if (typeof usage.contextWindow !== 'number' || !Number.isFinite(usage.contextWindow) || usage.contextWindow < 1 || !Number.isSafeInteger(usage.contextWindow)) throw Error('usage unavailable');
    if (typeof usage.percent !== 'number' || !Number.isFinite(usage.percent) || usage.percent < 0) throw Error('usage unavailable');
    return Object.freeze({ state: 'known', tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent, estimate: true, source: 'pi.session.getContextUsage' });
  } catch { return Object.freeze({ state: 'unknown', tokens: null, window: null, percent: null, estimate: true, source: 'pi.session.getContextUsage', reason: 'Pi session context usage is unavailable' }); }
}
