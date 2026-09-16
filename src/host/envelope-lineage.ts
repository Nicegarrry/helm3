import { rawArtifactRefSchema, type RawArtifactRef, type WorkerResult } from '../contracts/index.js';
import type { ArtifactMetadata } from '../journal/index.js';
import { parseWorkerResult } from './worker-result-format.js';
import { z } from 'zod/v3';

type ReadArtifact = (raw: RawArtifactRef, sourceIdentity: string) => Promise<Buffer>;

export type EnvelopeLineageInput = Readonly<{
  attemptId: string;
  commandId?: string;
  sessionId?: string;
  evidenceRefs: readonly string[];
  metadata: readonly ArtifactMetadata[];
  read: ReadArtifact;
}>;

export type EnvelopeLineageResult = Readonly<{
  result: WorkerResult;
  resultRef: string;
  dispositionRefs: readonly string[];
}>;

const dispositionSchema = z.object({
  schemaVersion: z.literal(1),
  commandId: z.string().min(1),
  attemptId: z.string().min(1),
  sessionId: z.string().min(1),
  invocation: z.string().min(1),
  phase: z.enum(['initial', 'correction', 'interrupted']),
  envelopeSourceIdentity: z.string().min(1),
  rawRef: rawArtifactRefSchema,
  status: z.enum(['accepted', 'rejected']),
  reason: z.enum(['accepted', 'envelope_invalid', 'envelope_missing', 'changed_files_mismatch', 'interrupted']),
}).strict();
type Disposition = z.infer<typeof dispositionSchema>;

const REF = /^raw:sha256:([0-9a-f]{64})$/;
const HASH = /^sha256:([0-9a-f]{64})$/;
const DISPOSITION_PREFIX = 'pi-envelope-disposition:';
const ENVELOPE_PREFIX = 'pi-envelope:';

function equalRaw(a: RawArtifactRef, b: RawArtifactRef): boolean {
  return a.ref === b.ref && a.hash === b.hash && a.mediaType === b.mediaType;
}

function canonicalRaw(value: unknown): RawArtifactRef | undefined {
  const parsed = rawArtifactRefSchema.safeParse(value);
  if (!parsed.success || !REF.test(parsed.data.ref) || !HASH.test(parsed.data.hash)
    || parsed.data.ref.slice('raw:sha256:'.length) !== parsed.data.hash.slice('sha256:'.length)) return undefined;
  return parsed.data;
}

function isLegacyIdentity(value: string): boolean {
  return /^pi-envelope-disposition:[^:]+:[^:]+$/.test(value);
}

function isNewDispositionIdentity(value: string): boolean {
  return value.startsWith(DISPOSITION_PREFIX) && !isLegacyIdentity(value);
}

function expectedEnvelopeIdentity(attemptId: string, invocation: string, phase: string): string {
  return ENVELOPE_PREFIX + attemptId + ':' + invocation + ':' + phase;
}

function expectedDispositionIdentity(attemptId: string, invocation: string, phase: string): string {
  return DISPOSITION_PREFIX + attemptId + ':' + invocation + ':' + phase;
}

function readJson(bytes: Buffer): unknown | undefined {
  try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
}

async function legacyResult(input: EnvelopeLineageInput, inScope: readonly ArtifactMetadata[]): Promise<EnvelopeLineageResult | undefined> {
  const envelopes = inScope.filter((entry) => entry.source === 'pi.envelope'
    && entry.sourceIdentity.startsWith(ENVELOPE_PREFIX + input.attemptId + ':'));
  const dispositions = inScope.filter((entry) => entry.source === 'pi.envelope_disposition');
  for (const entry of dispositions) {
    if (!isLegacyIdentity(entry.sourceIdentity)) return undefined;
    let value: unknown;
    try { value = readJson(await input.read(entry.raw, entry.sourceIdentity)); } catch { return undefined; }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const old = value as { status?: unknown; rawRef?: unknown; attemptId?: unknown };
    const oldRef = canonicalRaw(old.rawRef);
    if ((old.status !== 'envelope_invalid' && old.status !== 'envelope_missing')
      || old.attemptId !== input.attemptId || !oldRef) return undefined;
    if (!inScope.some((candidate) => candidate.source === 'pi.envelope' && equalRaw(candidate.raw, oldRef))) return undefined;
  }
  const valid: Array<{ result: WorkerResult; ref: string }> = [];
  for (const entry of envelopes) {
    let text: string;
    try { text = (await input.read(entry.raw, entry.sourceIdentity)).toString('utf8'); } catch { return undefined; }
    const result = parseWorkerResult(text);
    if (result) valid.push({ result, ref: entry.raw.ref });
  }
  return valid.length === 1
    ? Object.freeze({ result: valid[0]!.result, resultRef: valid[0]!.ref, dispositionRefs: Object.freeze(dispositions.map((entry) => entry.raw.ref)) })
    : undefined;
}

/**
 * Select one mechanically accepted native result from its complete evidence
 * lineage. All new disposition records are validated before any result is
 * considered. Returning undefined means the evidence cannot establish a
 * terminal result.
 */
export async function selectTrustedEnvelopeLineage(input: EnvelopeLineageInput): Promise<EnvelopeLineageResult | undefined> {
  const uniqueRefs = new Set(input.evidenceRefs);
  // Raw bytes can repeat across phases; source identities bind their dispositions.
  if (!input.attemptId.trim()) return undefined;
  const inScope = input.metadata.filter((entry) => uniqueRefs.has(entry.raw.ref));
  const dispositions = inScope.filter((entry) => entry.source === 'pi.envelope_disposition');
  const newDispositions = dispositions.filter((entry) => isNewDispositionIdentity(entry.sourceIdentity));
  // A disposition-shaped record with a non-legacy identity is new evidence.
  // It must never be ignored to make a legacy result appear valid.
  if (newDispositions.length === 0) return legacyResult(input, inScope);
  if (newDispositions.length !== dispositions.length) return undefined;

  const envelopes = inScope.filter((entry) => entry.source === 'pi.envelope');
  const lineageEnvelopes = envelopes.filter((entry) => entry.sourceIdentity.startsWith(ENVELOPE_PREFIX + input.attemptId + ':'));
  if (lineageEnvelopes.length === 0) return undefined;

  const parsed: Array<{ metadata: ArtifactMetadata; disposition: Disposition; result?: WorkerResult }> = [];
  const identities = new Set<string>();
  const invocations = new Set<string>();
  let commandId = input.commandId;
  let sessionId = input.sessionId;
  for (const entry of newDispositions) {
    if (identities.has(entry.sourceIdentity)) return undefined;
    identities.add(entry.sourceIdentity);
    let disposition: Disposition;
    try { disposition = dispositionSchema.parse(readJson(await input.read(entry.raw, entry.sourceIdentity))); }
    catch { return undefined; }
    if (entry.sourceIdentity !== expectedDispositionIdentity(input.attemptId, disposition.invocation, disposition.phase)
      || disposition.attemptId !== input.attemptId
      || (input.commandId !== undefined && disposition.commandId !== input.commandId)
      || (input.sessionId !== undefined && disposition.sessionId !== input.sessionId)
      || (commandId !== undefined && disposition.commandId !== commandId)
      || (sessionId !== undefined && disposition.sessionId !== sessionId)
      || disposition.envelopeSourceIdentity !== expectedEnvelopeIdentity(input.attemptId, disposition.invocation, disposition.phase)
      || !canonicalRaw(disposition.rawRef)) return undefined;
    commandId ??= disposition.commandId;
    sessionId ??= disposition.sessionId;
    if (invocations.size > 0 && !invocations.has(disposition.invocation)) return undefined;
    invocations.add(disposition.invocation);
    const matching = lineageEnvelopes.filter((candidate) => candidate.sourceIdentity === disposition.envelopeSourceIdentity
      && equalRaw(candidate.raw, disposition.rawRef));
    if (matching.length !== 1) return undefined;
    let rawText: string;
    try { rawText = (await input.read(matching[0]!.raw, matching[0]!.sourceIdentity)).toString('utf8'); } catch { return undefined; }
    const result = parseWorkerResult(rawText);
    if (disposition.status === 'accepted') {
      if (disposition.reason !== 'accepted' || disposition.phase === 'interrupted' || !result) return undefined;
    } else {
      if (disposition.reason === 'accepted'
        || (disposition.reason === 'interrupted' && disposition.phase !== 'interrupted')
        || (disposition.reason === 'envelope_missing' && rawText !== '')
        || (disposition.reason === 'envelope_invalid' && (!rawText || result))
        || (disposition.reason === 'changed_files_mismatch' && !result)
        || (disposition.phase === 'interrupted' && disposition.reason !== 'interrupted')) return undefined;
    }
    parsed.push({ metadata: entry, disposition, ...(result ? { result } : {}) });
  }

  if (parsed.length === 0 || parsed.length > 2 || parsed.some((item) => item.disposition.phase === 'interrupted')) return undefined;
  if (parsed.some((item) => item.disposition.invocation !== [...invocations][0])) return undefined;
  const referenced = new Set(parsed.map((item) => item.disposition.envelopeSourceIdentity));
  if (lineageEnvelopes.some((entry) => !referenced.has(entry.sourceIdentity))) return undefined;
  const initial = parsed.filter((item) => item.disposition.phase === 'initial');
  const correction = parsed.filter((item) => item.disposition.phase === 'correction');
  if (initial.length !== 1 || correction.length > 1) return undefined;
  if (correction.length === 1 && (initial[0]!.disposition.status !== 'rejected' || correction[0]!.disposition.status !== 'accepted')) return undefined;
  if (correction.length === 0 && initial[0]!.disposition.status !== 'accepted') return undefined;
  const accepted = parsed.filter((item) => item.disposition.status === 'accepted');
  if (accepted.length !== 1 || !accepted[0]!.result) return undefined;
  return Object.freeze({
    result: accepted[0]!.result,
    resultRef: accepted[0]!.disposition.rawRef.ref,
    dispositionRefs: Object.freeze(parsed.map((item) => item.metadata.raw.ref)),
  });
}
