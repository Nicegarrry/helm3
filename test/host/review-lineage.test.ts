import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ArtifactJournal } from '../../src/journal/index.js';
import { observeReviewTerminal } from '../../src/host/review-observer.js';
import type { DurableReviewRecord } from '../../src/host/review.js';
import type { PiWorkerFleet } from '../../src/host/worker-fleet.js';
import { WorkspaceManager } from '../../src/workspace/index.js';

const exec = promisify(execFile);

type Variant = 'good' | 'fenced' | 'foreign-session' | 'wrong-identity' | 'orphan' | 'malformed' | 'two-accepted' | 'missing-predecessor' | 'repeated-bytes' | 'foreign-event' | 'mutated-workspace' | 'single-malformed' | 'single-foreign-session' | 'single-missing-predecessor' | 'false-missing' | 'interrupted-predecessor' | 'foreign-content-alias';
async function observe(variant: Variant) {
  const root = await mkdtemp(join(tmpdir(), 'helm3-review-lineage-'));
  const manager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
  const journal = await ArtifactJournal.open({ root: join(root, 'journal'), hostPolicy: { allowSensitiveWrites: true } });
  try {
    const repository = join(root, 'repository'); await mkdir(repository); await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repository, 'config', 'user.name', 'Test']); await writeFile(join(repository, 'README.md'), 'base\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
    const head = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    const reservation = await manager.create(repository, join(root, 'reviewer'), 'reviewer', head, { attemptId: 'attempt-reviewer', generation: 1, expiresAt: '2099-01-01T00:00:00Z' }, { writableRoots: [], readableRoots: ['.'] });
    const before = await manager.inspectGitReadonly(reservation);
    const beforeRaw = await journal.append({ source: 'host.review.git.before', sourceIdentity: 'host-review-git-before:run:attempt-reviewer', mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, workerId: 'worker-reviewer', attemptId: 'attempt-reviewer', spawnCommandId: 'spawn-reviewer', repository: reservation.repository, workspace: reservation.root, head: before.head, clean: before.clean, status: before.status })), classification: 'sensitive' }, { permitSensitive: true });

    const report = (files: string[]) => ({ status: 'succeeded', summary: 'reviewed', changed_files: files, commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'report' });
    const identity = (phase: string) => `pi-envelope:attempt-reviewer:invocation:${phase}`;
    const initialText = JSON.stringify(report(variant === 'repeated-bytes' ? [] : ['README.md']));
    const correctedText = JSON.stringify(report([]));
    const initial = await journal.append({ source: 'pi.envelope', sourceIdentity: identity('initial'), mediaType: 'text/plain; charset=utf-8', bytes: Buffer.from(initialText) });
    const corrected = await journal.append({ source: 'pi.envelope', sourceIdentity: identity('correction'), mediaType: 'text/plain; charset=utf-8', bytes: Buffer.from(variant === 'fenced' ? '```json\n' + correctedText + '\n```' : correctedText) });
    if (variant === 'foreign-content-alias') await journal.append({ source: 'pi.envelope', sourceIdentity: 'pi-envelope:another-attempt:another-invocation:initial', mediaType: 'text/plain; charset=utf-8', bytes: Buffer.from(correctedText) });
    const disposition = async (phase: 'initial' | 'correction', rawRef: typeof corrected, overrides: Record<string, unknown> = {}, malformed = false) => journal.append({ source: 'pi.envelope_disposition', sourceIdentity: `pi-envelope-disposition:attempt-reviewer:invocation:${phase}`, mediaType: 'application/json', bytes: Buffer.from(malformed ? '{' : JSON.stringify({ schemaVersion: 1, commandId: 'spawn-reviewer', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer', invocation: 'invocation', phase, envelopeSourceIdentity: identity(phase), rawRef, status: phase === 'initial' ? 'rejected' : 'accepted', reason: phase === 'initial' ? 'changed_files_mismatch' : 'accepted', ...overrides })) });
    const initialDisposition = await disposition('initial', initial, variant === 'two-accepted' ? { status: 'accepted', reason: 'accepted' } : variant === 'false-missing' ? { reason: 'envelope_missing' } : variant === 'interrupted-predecessor' ? { reason: 'interrupted' } : {});
    const overrides: Record<string, unknown> = (variant === 'foreign-session' || variant === 'single-foreign-session') ? { sessionId: 'foreign-session' }
      : variant === 'wrong-identity' || variant === 'repeated-bytes' ? { envelopeSourceIdentity: identity('initial') }
      : variant === 'orphan' ? { rawRef: beforeRaw } : {};
    const correctedDisposition = await disposition('correction', corrected, overrides, variant === 'malformed' || variant === 'single-malformed');
    const events = await journal.append({ source: 'pi.event', sourceIdentity: 'pi-event-batch:session-reviewer:stream:1-1', mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, commandId: 'spawn-reviewer', attemptId: 'attempt-reviewer', sessionId: variant === 'foreign-event' ? 'foreign-session' : 'session-reviewer', firstSequence: 1, events: [] })) });
    const review: DurableReviewRecord = { schemaVersion: 1, reviewId: 'review-test', idempotencyKey: 'sha256:test', state: 'launched', source: { workerId: 'builder', attemptId: 'attempt-builder', sessionId: 'session-builder', modelId: 'builder', family: 'fable', provider: 'faux', api: 'fixture', repository: reservation.repository, workspace: reservation.root, runId: 'run', head, clean: true, contextRefs: [] }, requestedHead: head, manifest: { digest: 'sha256:manifest', entries: [{ ref: 'objective', purpose: 'objective', hash: 'sha256:objective' }, { ref: 'acceptance', purpose: 'acceptance', hash: 'sha256:acceptance' }] }, reviewer: { requestedModelId: 'reviewer', workerId: 'worker-reviewer', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer', spawnCommandId: 'spawn-reviewer' } };

    const evidenceRefs = variant.startsWith('single-') ? [corrected.ref, correctedDisposition.ref, events.ref] : [initial.ref, corrected.ref, initialDisposition.ref, correctedDisposition.ref, events.ref];
    if (variant === 'missing-predecessor') evidenceRefs.splice(evidenceRefs.indexOf(initialDisposition.ref), 1);
    const fleet = { terminalJournal: async () => ({ workerId: 'worker-reviewer', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer', spawnCommandId: 'spawn-reviewer', workspace: reservation.root, owner: reservation.owner, modelId: 'reviewer', modelProvider: 'faux', modelApi: 'fixture', evidenceRefs, reviewBeforeRef: beforeRaw.ref }) } as unknown as PiWorkerFleet;
    const observationJournal = { metadata: () => journal.metadata(), read: (raw: typeof corrected, sourceIdentity: string) => journal.read(raw, sourceIdentity, { permitSensitive: true }), appendAfter: (bytes: Uint8Array) => journal.append({ source: 'host.review.git.after', sourceIdentity: 'host-review-git-after:run:attempt-reviewer', mediaType: 'application/json', bytes, classification: 'sensitive' }, { permitSensitive: true }) };
    if (variant === 'mutated-workspace') await writeFile(join(reservation.root, 'README.md'), 'unexpected mutation');
    const outcome = await observeReviewTerminal({ fleet, workspaceManager: manager, journal: observationJournal, context: { runId: 'run', sessionId: 'expired-controller', mode: 'primary' }, review });
    return { outcome, correctedRef: corrected.ref };
  } finally { journal.close(); manager.close(); await rm(root, { recursive: true, force: true }); }
}

test('historical observer accepts a trusted mechanical rejection followed by one verified correction', async () => {
  const { outcome, correctedRef } = await observe('good');
  assert.equal(outcome?.resultRef, correctedRef);
  assert.ok(outcome?.readonlyObservation.afterRef);
});

test('historical observer parses whole JSON fences consistently with native Pi', async () => {
  const { outcome, correctedRef } = await observe('fenced');
  assert.equal(outcome?.resultRef, correctedRef);
});

for (const variant of ['foreign-session', 'wrong-identity', 'orphan', 'malformed', 'two-accepted', 'missing-predecessor', 'repeated-bytes', 'foreign-event', 'mutated-workspace', 'single-malformed', 'single-foreign-session', 'single-missing-predecessor', 'false-missing', 'interrupted-predecessor'] as const) {
  test(`historical observer refuses ${variant} correction lineage`, async () => {
    const { outcome } = await observe(variant);
    assert.equal(outcome, undefined);
  });
}

test('unrelated attempt metadata sharing content bytes does not contaminate this review', async () => {
  const { outcome, correctedRef } = await observe('foreign-content-alias');
  assert.equal(outcome?.resultRef, correctedRef);
});
