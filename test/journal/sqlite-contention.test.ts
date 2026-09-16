import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { SQLiteArtifactIndex } from '../../src/journal/sqlite-index.js';
import type { ArtifactMetadata } from '../../src/journal/index.js';

function createSampleMetadata(sourceIdentity: string, recordId: string): ArtifactMetadata {
  return {
    recordId,
    schemaVersion: 1,
    source: 'test-source',
    sourceIdentity,
    raw: {
      ref: 'raw:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      hash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mediaType: 'application/json',
    },
    classification: 'ordinary',
  };
}

test('SQLiteArtifactIndex contention and idempotency tests', async (t) => {
  let tempDir: string;

  t.beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sqlite-contention-test-'));
  });

  t.afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('same source same recordId is idempotent', async () => {
    const dbPath = join(tempDir, 'index.sqlite');
    const index = await SQLiteArtifactIndex.open(dbPath);
    try {
      const meta = createSampleMetadata('source-1', 'rec-1');
      await index.record(meta);
      await assert.doesNotReject(async () => {
        await index.record(meta);
      });
      const stored = await index.findBySourceIdentity('source-1');
      assert.deepEqual(stored, meta);
    } finally {
      index.close();
    }
  });

  await t.test('different recordId conflict throws and does not overwrite existing metadata', async () => {
    const dbPath = join(tempDir, 'index.sqlite');
    const index = await SQLiteArtifactIndex.open(dbPath);
    try {
      const meta1 = createSampleMetadata('source-1', 'rec-1');
      const meta2 = createSampleMetadata('source-1', 'rec-2');
      await index.record(meta1);

      await assert.rejects(
        async () => {
          await index.record(meta2);
        },
        /artifact index source identity conflict: source-1/,
      );

      const stored = await index.findBySourceIdentity('source-1');
      assert.deepEqual(stored, meta1);
    } finally {
      index.close();
    }
  });

  await t.test('separate thread holds lock then releases while index.record waits and succeeds', async () => {
    const dbPath = join(tempDir, 'index.sqlite');
    const index = await SQLiteArtifactIndex.open(dbPath);

    try {
      const workerCode = `
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';

        const db = new DatabaseSync(workerData.dbPath);
        db.exec('PRAGMA busy_timeout = 5000;');
        db.exec('BEGIN IMMEDIATE;');
        parentPort.postMessage('locked');

        setTimeout(() => { db.exec('COMMIT;'); db.close(); parentPort.postMessage('released'); }, 200);

      `;

      const worker = new Worker(workerCode, {
        eval: true,
        workerData: { dbPath },
      });

      await new Promise<void>((resolve, reject) => {
        worker.on('message', (msg) => {
          if (msg === 'locked') resolve();
        });
        worker.on('error', reject);
      });

      const meta = createSampleMetadata('source-locked', 'rec-locked');
      const released = new Promise<void>((resolve, reject) => {
        worker.on('message', (msg) => { if (msg === 'released') resolve(); });
        worker.on('error', reject);
      });
      await index.record(meta);
      await released;
      const stored = await index.findBySourceIdentity('source-locked');
      assert.deepEqual(stored, meta);
      await worker.terminate();
    } finally {
      index.close();
    }
  });

  await t.test('distinct sources both present after contention across concurrent callers', async () => {
    const dbPath = join(tempDir, 'index.sqlite');
    const indexA = await SQLiteArtifactIndex.open(dbPath);
    const indexB = await SQLiteArtifactIndex.open(dbPath);

    try {
      const metaA = createSampleMetadata('source-A', 'rec-A');
      const metaB = createSampleMetadata('source-B', 'rec-B');

      await Promise.all([
        indexA.record(metaA),
        indexB.record(metaB),
      ]);

      const shared = createSampleMetadata('source-shared', 'rec-shared');
      await Promise.all([indexA.record(shared), indexB.record(shared)]);
      assert.deepEqual(await indexA.findBySourceIdentity('source-shared'), shared);
      const storedA = await indexA.findBySourceIdentity('source-A');
      const storedB = await indexB.findBySourceIdentity('source-B');
      assert.deepEqual(storedA, metaA);
      assert.deepEqual(storedB, metaB);
    } finally {
      indexA.close();
      indexB.close();
    }
  });
});
