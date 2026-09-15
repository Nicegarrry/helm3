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

test('review observer accepts only terminal native evidence bound to its reviewer and exact unchanged Git snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-review-observer-'));
  const manager = new WorkspaceManager({ stateRoot: join(root, 'workspace-state') });
  const journal = await ArtifactJournal.open({ root: join(root, 'journal'), hostPolicy: { allowSensitiveWrites: true } });
  try {
    const repository = join(root, 'repository'); await mkdir(repository); await exec('git', ['init', repository]); await exec('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repository, 'config', 'user.name', 'Test']); await writeFile(join(repository, 'README.md'), 'base\n'); await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'base']);
    const head = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
    const reservation = await manager.create(repository, join(root, 'reviewer'), 'reviewer', head, { attemptId: 'attempt-reviewer', generation: 1, expiresAt: '2099-01-01T00:00:00Z' }, { writableRoots: [], readableRoots: ['.'] });
    const before = await manager.inspectGitReadonly(reservation);
    const beforeRaw = await journal.append({ source: 'host.review.git.before', sourceIdentity: 'host-review-git-before:run:attempt-reviewer', mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, workerId: 'worker-reviewer', attemptId: 'attempt-reviewer', spawnCommandId: 'spawn-reviewer', repository: reservation.repository, workspace: reservation.root, head: before.head, clean: before.clean, status: before.status })), classification: 'sensitive' }, { permitSensitive: true });
    const result = await journal.append({ source: 'pi.envelope', sourceIdentity: 'pi-envelope:attempt-reviewer:invocation:initial', mediaType: 'text/plain', bytes: Buffer.from(JSON.stringify({ status: 'succeeded' })) });
    const events = await journal.append({ source: 'pi.event', sourceIdentity: 'pi-event-batch:session-reviewer:stream:1-1', mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, commandId: 'spawn-reviewer', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer', firstSequence: 1, events: [] })) });
    const review: DurableReviewRecord = { schemaVersion: 1, reviewId: 'review-test', idempotencyKey: 'sha256:test', state: 'launched', source: { workerId: 'builder', attemptId: 'attempt-builder', sessionId: 'session-builder', modelId: 'builder', family: 'fable', provider: 'faux', api: 'fixture', repository: reservation.repository, workspace: reservation.root, runId: 'run', head, clean: true, contextRefs: [] }, requestedHead: head, manifest: { digest: 'sha256:manifest', entries: [{ ref: 'objective', hash: 'sha256:objective' }, { ref: 'acceptance', hash: 'sha256:acceptance' }] }, reviewer: { requestedModelId: 'reviewer', workerId: 'worker-reviewer', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer', spawnCommandId: 'spawn-reviewer' } };
    const fleet = { terminalJournal: async () => ({ workerId: 'worker-reviewer', attemptId: 'attempt-reviewer', sessionId: 'session-reviewer', spawnCommandId: 'spawn-reviewer', workspace: reservation.root, owner: reservation.owner, modelId: 'reviewer', modelProvider: 'faux', modelApi: 'fixture', evidenceRefs: [result.ref, events.ref], reviewBeforeRef: beforeRaw.ref }) } as unknown as PiWorkerFleet;
    const observationJournal = { metadata: () => journal.metadata(), read: (raw: typeof result, sourceIdentity: string) => journal.read(raw, sourceIdentity, { permitSensitive: true }), appendAfter: (bytes: Uint8Array) => journal.append({ source: 'host.review.git.after', sourceIdentity: 'host-review-git-after:run:attempt-reviewer', mediaType: 'application/json', bytes, classification: 'sensitive' }, { permitSensitive: true }) };
    const outcome = await observeReviewTerminal({ fleet, workspaceManager: manager, journal: observationJournal, context: { runId: 'run', sessionId: 'expired-controller', mode: 'primary' }, review });
    assert.equal(outcome?.resultRef, result.ref); assert.deepEqual(outcome?.rawEventRefs, [events.ref]); assert.equal(outcome?.readonlyObservation.beforeRef, beforeRaw.ref); assert.ok(outcome?.readonlyObservation.afterRef);
  } finally { journal.close(); manager.close(); await rm(root, { recursive: true, force: true }); }
});
