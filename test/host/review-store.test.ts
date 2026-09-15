import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactJournal } from '../../src/journal/index.js';
import type { DurableReviewRecord } from '../../src/host/review.js';
import { JournalReviewDurabilityStore } from '../../src/host/review-store.js';

const head = 'a'.repeat(40);
function planned(): DurableReviewRecord {
  return { schemaVersion: 1, reviewId: 'review-1234567890abcdef', idempotencyKey: `sha256:${'b'.repeat(64)}`, state: 'planned', source: { workerId: 'builder', attemptId: 'attempt-builder', sessionId: 'session-builder', modelId: 'builder', family: 'fable', provider: 'faux', api: 'fixture', repository: 'repo', workspace: 'workspace', runId: 'run', head, clean: true, contextRefs: [] }, requestedHead: head, manifest: { digest: `sha256:${'c'.repeat(64)}`, entries: [{ ref: 'objective', hash: `sha256:${'d'.repeat(64)}` }, { ref: 'acceptance', hash: `sha256:${'e'.repeat(64)}` }] }, reviewer: { requestedModelId: 'reviewer' } };
}

test('journal review store persists immutable intent and append-only provenance across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-review-store-'));
  try {
    const journal = await ArtifactJournal.open({ root, hostPolicy: { allowSensitiveWrites: true } });
    const first = new JournalReviewDurabilityStore(journal, 'run'); const intent = planned();
    await first.prepare(intent); await first.prepare(intent);
    const launched: DurableReviewRecord = { ...intent, state: 'launched', reviewer: { requestedModelId: 'reviewer', workerId: 'reviewer-worker', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer', spawnCommandId: 'spawn-command', modelId: 'reviewer', family: 'astra', poolId: 'offline' } };
    await first.append(launched);
    const reopened = new JournalReviewDurabilityStore(journal, 'run');
    assert.deepEqual(await reopened.reopen(intent.idempotencyKey), launched);
    const identities = (await journal.metadata()).map(entry => entry.sourceIdentity).filter(value => value.includes(intent.idempotencyKey));
    assert.equal(identities.length, 2); assert.ok(identities.some(value => value.endsWith(':intent'))); assert.ok(identities.some(value => value.endsWith(':v1')));
    journal.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('journal review store atomically fences concurrent intents and rejects silent history replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-review-store-race-'));
  try {
    const journal = await ArtifactJournal.open({ root, hostPolicy: { allowSensitiveWrites: true } });
    const left = new JournalReviewDurabilityStore(journal, 'run'); const right = new JournalReviewDurabilityStore(journal, 'run'); const intent = planned();
    await Promise.all([left.prepare(intent), right.prepare(intent)]);
    const changed = { ...intent, reviewer: { requestedModelId: 'different-reviewer' } };
    await assert.rejects(left.prepare(changed));
    const launched: DurableReviewRecord = { ...intent, state: 'launched', reviewer: { requestedModelId: 'reviewer', workerId: 'reviewer-worker', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer' } };
    const unknown: DurableReviewRecord = { ...intent, state: 'unknown', failure: { reason: 'spawn-unknown' } };
    const results = await Promise.allSettled([left.append(launched), right.append(unknown)]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.ok(['launched', 'unknown'].includes((await left.reopen(intent.idempotencyKey))!.state));
    journal.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an intent survives a crash boundary and remains a no-retry reconciliation record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-review-store-crash-'));
  try {
    const journal = await ArtifactJournal.open({ root, hostPolicy: { allowSensitiveWrites: true } }); const intent = planned();
    await new JournalReviewDurabilityStore(journal, 'run').prepare(intent); journal.close();
    const reopenedJournal = await ArtifactJournal.open({ root, hostPolicy: { allowSensitiveWrites: true } });
    assert.deepEqual(await new JournalReviewDurabilityStore(reopenedJournal, 'run').reopen(intent.idempotencyKey), intent);
    reopenedJournal.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
