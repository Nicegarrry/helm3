import { createHash } from 'node:crypto';
import { z } from 'zod/v3';

const ref = z.object({ ref: z.string().min(1), version: z.string().min(1), digest: z.string().min(1) }).strict();
const packet = z.object({ schemaVersion: z.literal(1), objective: ref, acceptance: ref, brief: ref.array(), map: ref.array(), decisions: ref.array(), handoffs: ref.array() }).strict();
export type ContextRef = z.infer<typeof ref>;
export type WorkerContextPacket = Readonly<{ schemaVersion: 1; objective: ContextRef; acceptance: ContextRef; brief: readonly ContextRef[]; map: readonly ContextRef[]; decisions: readonly ContextRef[]; handoffs: readonly ContextRef[]; digest: string }>;

/** Caller judgement selects refs; Helm refuses an oversized packet rather than truncating it. */
export function createWorkerContextPacket(input: Omit<z.infer<typeof packet>, 'schemaVersion'>, maxBytes = 64 * 1024): WorkerContextPacket {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid context packet byte limit');
  const parsed = packet.parse({ schemaVersion: 1, ...input }); const bytes = Buffer.from(JSON.stringify(parsed));
  if (bytes.length > maxBytes) throw new Error('context packet exceeds its explicit byte limit');
  return Object.freeze({ ...parsed, objective: Object.freeze({ ...parsed.objective }), acceptance: Object.freeze({ ...parsed.acceptance }), brief: Object.freeze(parsed.brief.map(x => Object.freeze({ ...x }))), map: Object.freeze(parsed.map.map(x => Object.freeze({ ...x }))), decisions: Object.freeze(parsed.decisions.map(x => Object.freeze({ ...x }))), handoffs: Object.freeze(parsed.handoffs.map(x => Object.freeze({ ...x })),), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
}

export type ContextOccupancy = Readonly<{ state: 'known'; tokens: number; window: number | null; cachedTokens: number | null; source: string } | { state: 'unknown'; tokens: null; window: null; cachedTokens: null; source: string; reason: string }>;
export function observePiContext(session: { getContextUsage?: () => unknown; getSessionStats?: () => unknown }): ContextOccupancy {
  try { const usage = session.getContextUsage?.() as Record<string, unknown> | undefined; const stats = session.getSessionStats?.() as Record<string, unknown> | undefined; const tokens = usage?.tokens ?? usage?.totalTokens ?? stats?.tokens; const window = usage?.contextWindow ?? usage?.maxTokens; const cached = usage?.cachedTokens ?? usage?.cacheReadTokens; if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) throw Error('usage unavailable'); return Object.freeze({ state: 'known', tokens, window: typeof window === 'number' && Number.isFinite(window) && window >= 0 ? window : null, cachedTokens: typeof cached === 'number' && Number.isFinite(cached) && cached >= 0 ? cached : null, source: usage ? 'pi.session.getContextUsage' : 'pi.session.getSessionStats' }); }
  catch { return Object.freeze({ state: 'unknown', tokens: null, window: null, cachedTokens: null, source: 'pi.session', reason: 'Pi session context usage is unavailable' }); }
}
