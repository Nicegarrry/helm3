import type { HistoricalReviewObservationJournal } from './index.js';
import type { ArtifactMetadata } from '../journal/index.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import type { WorkspaceManager } from '../workspace/index.js';
import type { DurableReviewRecord, ReviewOutcome } from './review.js';
import type { PiWorkerFleet, WorkerTerminalJournal } from './worker-fleet.js';

type GitSnapshot = Readonly<{
  schemaVersion: 1; workerId: string; attemptId: string; spawnCommandId: string;
  repository: string; workspace: string; head: string; clean: boolean; status: string;
}>;
type PiEventBatch = Readonly<{ schemaVersion: 1; commandId: string; attemptId: string; sessionId: string }>;

function parseGitSnapshot(bytes: Buffer): GitSnapshot | undefined {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Partial<GitSnapshot>;
    return value.schemaVersion === 1 && typeof value.workerId === 'string' && typeof value.attemptId === 'string'
      && typeof value.spawnCommandId === 'string' && typeof value.repository === 'string' && typeof value.workspace === 'string'
      && /^[0-9a-f]{40}$/.test(value.head ?? '') && typeof value.clean === 'boolean' && typeof value.status === 'string'
      ? Object.freeze(value as GitSnapshot) : undefined;
  } catch { return undefined; }
}
function validWorkerResult(bytes: Buffer): boolean {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as { status?: unknown };
    return typeof value === 'object' && value !== null && typeof value.status === 'string' && value.status.length > 0;
  } catch { return false; }
}
function validEvent(bytes: Buffer, terminal: WorkerTerminalJournal): boolean {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Partial<PiEventBatch>;
    return value.schemaVersion === 1 && value.commandId === terminal.spawnCommandId && value.attemptId === terminal.attemptId && value.sessionId === terminal.sessionId;
  } catch { return false; }
}

/**
 * Reads only trusted, immutable native evidence. Undefined means incomplete
 * or untrusted evidence; callers must retain/reconcile the durable launch and
 * must never turn that state into a terminal review result.
 */
export async function observeReviewTerminal(input: Readonly<{
  fleet: PiWorkerFleet; workspaceManager: WorkspaceManager; journal: HistoricalReviewObservationJournal;
  context: HelmToolExecutionContext; review: DurableReviewRecord;
}>): Promise<ReviewOutcome | undefined> {
  const { review } = input;
  const reviewerId = review.reviewer.workerId;
  if (review.state !== 'launched' || !reviewerId || !review.reviewer.attemptId || !review.reviewer.sessionId || !review.reviewer.spawnCommandId) return undefined;
  let terminal: WorkerTerminalJournal | undefined;
  try { terminal = await input.fleet.terminalJournal(input.context, reviewerId); } catch { return undefined; }
  if (!terminal || terminal.workerId !== reviewerId || terminal.attemptId !== review.reviewer.attemptId || terminal.sessionId !== review.reviewer.sessionId || terminal.spawnCommandId !== review.reviewer.spawnCommandId) return undefined;
  let reservation: ReturnType<WorkspaceManager['reservation']>;
  try { reservation = input.workspaceManager.reservation(terminal.workspace); } catch { return undefined; }
  if (reservation.repository !== review.source.repository || reservation.root !== terminal.workspace) return undefined;

  let metadata: readonly ArtifactMetadata[];
  try { metadata = await input.journal.metadata(); } catch { return undefined; }
  const beforeIdentity = `host-review-git-before:${review.source.runId}:${terminal.attemptId}`;
  const before = metadata.find(entry => entry.source === 'host.review.git.before' && entry.sourceIdentity === beforeIdentity && entry.raw.ref === terminal.reviewBeforeRef);
  if (!before) return undefined;
  let beforeSnapshot: GitSnapshot | undefined;
  try { beforeSnapshot = parseGitSnapshot(await input.journal.read(before.raw, before.sourceIdentity)); } catch { return undefined; }
  if (!beforeSnapshot || beforeSnapshot.workerId !== terminal.workerId || beforeSnapshot.attemptId !== terminal.attemptId || beforeSnapshot.spawnCommandId !== terminal.spawnCommandId
    || beforeSnapshot.repository !== reservation.repository || beforeSnapshot.workspace !== reservation.root || beforeSnapshot.head !== review.requestedHead || !beforeSnapshot.clean || beforeSnapshot.status !== '') return undefined;

  const known = new Set(terminal.evidenceRefs);
  const envelopes = metadata.filter(entry => known.has(entry.raw.ref) && entry.source === 'pi.envelope' && entry.sourceIdentity.startsWith(`pi-envelope:${terminal.attemptId}:`));
  const validEnvelopes: ArtifactMetadata[] = [];
  try {
    for (const candidate of envelopes) if (validWorkerResult(await input.journal.read(candidate.raw, candidate.sourceIdentity))) validEnvelopes.push(candidate);
  } catch { return undefined; }
  // A bounded correction can leave an invalid initial envelope plus one valid
  // terminal envelope. More than one valid result is ambiguous provenance.
  if (validEnvelopes.length !== 1) return undefined;
  const result = validEnvelopes[0]!;
  const events = metadata.filter(entry => known.has(entry.raw.ref) && entry.source === 'pi.event');
  if (!events.length) return undefined;
  try {
    if (!(await Promise.all(events.map(async entry => validEvent(await input.journal.read(entry.raw, entry.sourceIdentity), terminal)))).every(Boolean)) return undefined;
  } catch { return undefined; }

  let after: Awaited<ReturnType<WorkspaceManager['inspectGitReadonly']>>;
  try { after = await input.workspaceManager.inspectGitReadonly(reservation); } catch { return undefined; }
  if (after.head !== beforeSnapshot.head || after.status !== beforeSnapshot.status || after.clean !== beforeSnapshot.clean) return undefined;
  const afterRaw = await input.journal.appendAfter(Buffer.from(JSON.stringify({ ...beforeSnapshot, owner: after.owner }), 'utf8')).catch(() => undefined);
  if (!afterRaw) return undefined;
  return Object.freeze({ resultRef: result.raw.ref, rawEventRefs: Object.freeze(events.map(entry => entry.raw.ref)), readonlyObservation: Object.freeze({ beforeRef: before.raw.ref, afterRef: afterRaw.ref }) });
}
