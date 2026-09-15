import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { z } from 'zod';
import type { RawArtifactRef } from '../../src/contracts/index.js';
import { openKernel } from '../../src/core/index.js';
import { ArtifactJournal } from '../../src/journal/index.js';
import { SQLiteArtifactIndex } from '../../src/journal/sqlite-index.js';

// Independent integration oracle: rebuilding a disposable artifact projection
// must preserve authoritative commands and human decisions in the same SQLite file.
test('artifact-index loss and rebuild leave the authoritative Log intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'helm3-log-journal-'));
  const databasePath = join(directory, 'helm.sqlite');
  const at = '2026-09-15T00:00:00Z';
  const expires = '2026-09-15T01:00:00Z';
  const { kernel, host } = openKernel({
    databasePath,
    kinds: { 'evidence.capture': { payloadSchema: z.object({ label: z.string() }).strict() } },
    now: () => at,
  });
  let journal: ArtifactJournal | undefined;
  let database: DatabaseSync | undefined;
  try {
    host.declareHumanAuthority({
      authorityId: 'approval', repositoryId: 'fixture', mapNodeIds: ['node'], allowedActions: ['evidence.capture'], expiresAt: expires,
      maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [],
    });
    host.issueAutonomyLease({
      leaseId: 'authority', revision: 1, issuedBy: 'human', parentAuthorityId: 'approval',
      scope: { repositoryId: 'fixture', mapNodeIds: ['node'] }, allowedActions: ['evidence.capture'],
      issuedAt: at, expiresAt: expires, maxConcurrency: 1, maxAttemptsPerNode: 1,
      poolLimits: [], protectedReserves: [],
    });
    const payload = { label: 'an exact evidence record' };
    host.admit({
      schemaVersion: 1, commandId: 'capture', kind: 'evidence.capture', idempotencyKey: 'capture-1',
      payloadHash: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
      scope: { repositoryId: 'fixture', mapNodeId: 'node' }, actorId: 'untrusted-input',
      runId: 'run', origin: 'supervisor', leaseId: 'authority', leaseRevision: 1,
      plannedAt: at, notAfter: expires, expected: [], payload, requiredEvidence: ['envelope'],
    }, { actorId: 'trusted-supervisor', allowedOrigins: ['supervisor'] });
    const decision = {
      schemaVersion: 1 as const, eventId: 'ruling', kind: 'human.ruling', source: 'authenticated-human',
      sourceEventId: 'ruling-1', occurredAt: at, recordedAt: at, correlationId: 'run',
      payload: { decision: 'Preserve the original Brief.' },
    };
    host.appendEvent(decision);
    const index = await SQLiteArtifactIndex.open(databasePath);
    journal = await ArtifactJournal.open({ root: join(directory, 'artifacts'), index });
    const bytes = Buffer.from('{"status":"partial","summary":"Still a claim, not accepted evidence."}\n');
    const executor = { executorId: 'fixture-executor' };
    const claim = host.claim('capture', executor, expires);
    let reference: RawArtifactRef | undefined;
    let executions = 0;
    const result = await host.perform('capture', claim, executor, async () => {
      throw new Error('This command has no external preconditions.');
    }, {
      effectId: 'attempt-envelope-1',
      execute: async () => {
        executions += 1;
        reference = await journal!.append({
          source: 'pi.envelope', sourceIdentity: 'attempt-envelope-1', mediaType: 'application/json', bytes,
        });
        throw new Error('Simulated lost acknowledgement after durable publication.');
      },
      observe: () => { throw new Error('Observation must wait for explicit reconciliation after lost acknowledgement.'); },
    });
    assert.equal(result.state, 'unknown');
    assert.ok(reference);
    assert.throws(() => host.claim('capture', executor, expires), /not claimable/);
    database = new DatabaseSync(databasePath);
    const beforeCommand = kernel.getCommand('capture');
    const beforeEvents = database.prepare('SELECT bytes FROM events ORDER BY event_id').all();
    await index.reset();
    assert.equal(await index.findBySourceIdentity('attempt-envelope-1'), undefined);
    assert.deepEqual(kernel.getCommand('capture'), beforeCommand);
    assert.equal(await journal.rebuildIndex(), 1);
    assert.equal((await index.findBySourceIdentity('attempt-envelope-1'))?.raw.hash, reference.hash);
    assert.deepEqual(kernel.getCommand('capture'), beforeCommand);
    assert.deepEqual(database.prepare('SELECT bytes FROM events ORDER BY event_id').all(), beforeEvents);
    assert.deepEqual(await journal.read(reference, 'attempt-envelope-1'), bytes);
    host.recordObservation('capture', {
      commandId: 'capture', effectId: 'attempt-envelope-1', state: 'succeeded',
      source: 'journal.sha256-verification', observedAt: at, evidenceRefs: [reference.ref],
    });
    assert.equal(kernel.getCommand('capture')?.status, 'succeeded');
    assert.deepEqual(kernel.getCommand('capture')?.observations.at(-1)?.evidenceRefs, [reference.ref]);
    assert.throws(() => host.claim('capture', executor, expires), /not claimable/);
    assert.equal(executions, 1);
  } finally {
    database?.close();
    journal?.close();
    host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
