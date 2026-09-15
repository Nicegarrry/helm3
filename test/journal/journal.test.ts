import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactAccessError,
  ArtifactConflictError,
  ArtifactIntegrityError,
  ArtifactJournal,
} from '../../src/journal/index.js';
import { SQLiteArtifactIndex } from '../../src/journal/sqlite-index.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function withJournal(
  run: (journal: ArtifactJournal, root: string) => Promise<void>,
  options: Parameters<typeof ArtifactJournal.open>[0] = { root: '' },
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'helm3-journal-test-'));
  const journal = await ArtifactJournal.open({ ...options, root });
  try {
    await run(journal, root);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
}

const event = (bytes: Uint8Array, sourceIdentity = 'pi:event:1') => ({
  source: 'pi', sourceIdentity, mediaType: 'application/json', bytes,
});

test('preserves exact event, envelope, context, and gate bytes behind stable hash refs', async () => {
  await withJournal(async (journal) => {
    const payloads = [
      event(Buffer.from('{"event":"tool.started","nul":"\\u0000"}'), 'pi:event:1'),
      event(Buffer.from('{"status":"succeeded"}'), 'pi:envelope:1'),
      event(Buffer.from('{"context":"manifest"}'), 'pi:context:1'),
      event(Buffer.from('{"gate":"typecheck","exitStatus":0}'), 'gate:evidence:1'),
    ];
    for (const payload of payloads) {
      const raw = await journal.append(payload);
      assert.equal(raw.ref, `raw:sha256:${sha256(payload.bytes)}`);
      assert.equal(raw.hash, `sha256:${sha256(payload.bytes)}`);
      assert.deepEqual(await journal.read(raw, payload.sourceIdentity), Buffer.from(payload.bytes));
    }
  });
});

test('deduplicates identical source records and refuses source identity conflicts', async () => {
  await withJournal(async (journal) => {
    const first = await journal.append(event(Buffer.from('same')));
    assert.deepEqual(await journal.append(event(Buffer.from('same'))), first);
    await assert.rejects(journal.append(event(Buffer.from('different'))), ArtifactConflictError);
  });
});

test('snapshots caller-owned bytes before asynchronous publication', async () => {
  await withJournal(async (journal) => {
    const original = Buffer.from('original');
    const expected = Buffer.from(original);
    const pending = journal.append(event(original, 'pi:event:mutable'));
    original.fill(120);
    const raw = await pending;
    assert.equal(raw.hash, `sha256:${sha256(expected)}`);
    assert.deepEqual(await journal.read(raw, 'pi:event:mutable'), expected);
    assert.deepEqual(await journal.reconcile(), []);
  });
});

test('crash after raw publish leaves an explicit unknown-identity orphan without inventing metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-journal-crash-'));
  const bytes = Buffer.from('raw-before-metadata');
  const crashing = await ArtifactJournal.open({ root, hooks: { afterRawPublished: async () => { throw new Error('simulated crash'); } } });
  try {
    await assert.rejects(crashing.append(event(bytes)), /simulated crash/);
  } finally {
    crashing.close();
  }
  const recovered = await ArtifactJournal.open({ root });
  try {
    assert.deepEqual(await recovered.reconcile(), [{ kind: 'orphan_raw', hash: `sha256:${sha256(bytes)}`, sourceIdentity: 'unknown' }]);
  } finally {
    recovered.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('metadata published before the projection can be reindexed without producing Helm facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-journal-index-crash-'));
  const original = await ArtifactJournal.open({ root });
  const parent = await original.append(event(Buffer.from('unredacted'), 'pi:source:1'));
  original.close();
  const redaction = { ...event(Buffer.from('redacted'), 'pi:redaction:1'), derivedFrom: parent };
  const crashing = await ArtifactJournal.open({ root, hooks: { afterMetadataPublishedBeforeIndex: async () => { throw new Error('simulated index crash'); } } });
  try {
    await assert.rejects(crashing.append(redaction), /simulated index crash/);
  } finally {
    crashing.close();
  }
  const recovered = await ArtifactJournal.open({ root });
  try {
    const issues = await recovered.reconcile();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'unindexed_metadata');
    assert.deepEqual(await recovered.append(redaction), { ref: `raw:sha256:${sha256(redaction.bytes)}`, hash: `sha256:${sha256(redaction.bytes)}`, mediaType: 'application/json' });
    assert.deepEqual(await recovered.reconcile(), []);
    assert.equal(await recovered.rebuildIndex(), 2);
  } finally {
    recovered.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('reports missing and tampered raw bytes instead of silently accepting them', async () => {
  await withJournal(async (journal, root) => {
    const raw = await journal.append(event(Buffer.from('original')));
    const path = join(root, 'raw', 'sha256', raw.hash.slice('sha256:'.length));
    await unlink(path);
    assert.deepEqual(await journal.reconcile(), [{ kind: 'missing_raw', hash: raw.hash, sourceIdentity: 'pi:event:1' }]);
    await assert.rejects(journal.read(raw, 'pi:event:1'), ArtifactIntegrityError);
    await assert.rejects(journal.append(event(Buffer.from('original'))), ArtifactIntegrityError);

    await writeFile(path, 'tampered', { mode: 0o600 });
    await chmod(path, 0o600);
    assert.deepEqual(await journal.reconcile(), [{ kind: 'corrupt_raw', hash: raw.hash, sourceIdentity: 'pi:event:1' }]);
    await assert.rejects(journal.append(event(Buffer.from('original'))), ArtifactIntegrityError);
  });
});

test('rebuild validates every raw artifact before preserving or changing the existing projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-journal-rebuild-'));
  const index = await SQLiteArtifactIndex.open(join(root, 'projection.sqlite'));
  const journal = await ArtifactJournal.open({ root, index });
  const goodBytes = Buffer.from('good');
  const badBytes = Buffer.from('bad');
  try {
    const good = await journal.append(event(goodBytes, 'pi:event:good'));
    const bad = await journal.append(event(badBytes, 'pi:event:bad'));
    const badPath = join(root, 'raw', 'sha256', bad.hash.slice('sha256:'.length));
    await unlink(badPath);
    await assert.rejects(journal.rebuildIndex(), /artifact bytes are missing/);
    assert.equal((await index.findBySourceIdentity('pi:event:good'))?.raw.hash, good.hash);
    assert.equal((await index.findBySourceIdentity('pi:event:bad'))?.raw.hash, bad.hash);

    await writeFile(badPath, badBytes, { mode: 0o600 });
    await chmod(badPath, 0o600);
    assert.equal(await journal.rebuildIndex(), 2);
    await writeFile(badPath, 'tampered', { mode: 0o600 });
    await chmod(badPath, 0o600);
    await assert.rejects(journal.rebuildIndex(), /artifact bytes do not match/);
    assert.equal((await index.findBySourceIdentity('pi:event:good'))?.raw.hash, good.hash);
    assert.equal((await index.findBySourceIdentity('pi:event:bad'))?.raw.hash, bad.hash);
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent same-identity writes fence metadata while retaining a losing raw blob as an orphan', async () => {
  await withJournal(async (journal) => {
    const identity = 'pi:event:concurrent';
    const results = await Promise.allSettled([
      journal.append(event(Buffer.from('first'), identity)),
      journal.append(event(Buffer.from('second'), identity)),
    ]);
    const winner = results.find((result): result is PromiseFulfilledResult<{ ref: string; hash: string; mediaType: string }> => result.status === 'fulfilled');
    const loser = results.find((result) => result.status === 'rejected');
    assert.ok(winner, 'one identity publication must win');
    assert.ok(loser?.reason instanceof ArtifactConflictError, 'the losing metadata publication must refuse');
    assert.deepEqual(await journal.read(winner.value, identity), winner.value.hash.endsWith(sha256(Buffer.from('first'))) ? Buffer.from('first') : Buffer.from('second'));
    const issues = await journal.reconcile();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].kind, 'orphan_raw');

    const same = await Promise.all([journal.append(event(Buffer.from('first'), 'pi:event:same-race')), journal.append(event(Buffer.from('first'), 'pi:event:same-race'))]);
    assert.deepEqual(same[0], same[1]);

    const crossSource = await Promise.allSettled([
      journal.append({ ...event(Buffer.from('source-a'), 'pi:event:global-id'), source: 'pi-a' }),
      journal.append({ ...event(Buffer.from('source-b'), 'pi:event:global-id'), source: 'pi-b' }),
    ]);
    const crossWinner = crossSource.find((result): result is PromiseFulfilledResult<{ ref: string; hash: string; mediaType: string }> => result.status === 'fulfilled');
    assert.ok(crossWinner);
    assert.ok(crossSource.some((result) => result.status === 'rejected' && result.reason instanceof ArtifactConflictError));
    assert.deepEqual(await journal.read(crossWinner.value, 'pi:event:global-id'), crossWinner.value.hash.endsWith(sha256(Buffer.from('source-a'))) ? Buffer.from('source-a') : Buffer.from('source-b'));
  });
});

test('fails closed when a sidecar classification or record binding is tampered', async () => {
  await withJournal(async (journal, root) => {
    const raw = await journal.append(event(Buffer.from('policy'), 'pi:event:policy'));
    const sidecar = join(root, 'metadata', `${sha256(Buffer.from(JSON.stringify(['pi:event:policy'])))}.json`);
    const metadata = JSON.parse(await readFile(sidecar, 'utf8'));
    metadata.classification = 'not-a-policy';
    await writeFile(sidecar, JSON.stringify(metadata), { mode: 0o600 });
    await assert.rejects(journal.read(raw, 'pi:event:policy'), /invalid artifact metadata/);
    await assert.rejects(journal.rebuildIndex(), /invalid artifact metadata/);
  });
});

test('rejects path-like refs and requires trusted host policy for sensitive artifacts', async () => {
  await withJournal(async (journal, root) => {
    const sensitive = event(Buffer.from('secret'), 'pi:secret:1');
    await assert.rejects(journal.append({ ...sensitive, classification: 'sensitive' }), ArtifactAccessError);
    const mode = (await stat(root)).mode & 0o777;
    assert.equal(mode, 0o700);
    await assert.rejects(
      journal.read({ ref: 'raw:sha256:../../etc/passwd', hash: `sha256:${'0'.repeat(64)}`, mediaType: 'text/plain' }, 'pi:event:1'),
      ArtifactIntegrityError,
    );
  }, { root: '' });

  await withJournal(async (journal, root) => {
    const raw = await journal.append({ ...event(Buffer.from('secret'), 'pi:secret:1'), classification: 'sensitive' }, { permitSensitive: true });
    await assert.rejects(journal.read(raw, 'pi:secret:1'), ArtifactAccessError);
    assert.deepEqual(await journal.read(raw, 'pi:secret:1', { permitSensitive: true }), Buffer.from('secret'));
    const rawPath = join(root, 'raw', 'sha256', raw.hash.slice('sha256:'.length));
    assert.equal((await stat(rawPath)).mode & 0o777, 0o600);
  }, { root: '', hostPolicy: { allowSensitiveWrites: true } });

  await withJournal(async (journal) => {
    const ordinary = await journal.append(event(Buffer.from('same-secret'), 'pi:ordinary:1'));
    await journal.append({ ...event(Buffer.from('same-secret'), 'pi:sensitive:1'), classification: 'sensitive' }, { permitSensitive: true });
    await assert.rejects(journal.read(ordinary, 'pi:ordinary:1'), ArtifactAccessError);
  }, { root: '', hostPolicy: { allowSensitiveWrites: true } });
});

test('fails closed on a missing or corrupt per-hash authority, then backfills it from validated sidecars at open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-journal-authority-'));
  const options = { root, hostPolicy: { allowSensitiveWrites: true } };
  const first = await ArtifactJournal.open(options);
  try {
    const ordinary = await first.append(event(Buffer.from('shared-secret'), 'pi:ordinary:authority'));
    await first.append({ ...event(Buffer.from('shared-secret'), 'pi:sensitive:authority'), classification: 'sensitive' }, { permitSensitive: true });
    const authority = join(root, 'authority', 'sha256', `${ordinary.hash.slice('sha256:'.length)}.json`);
    await unlink(authority);
    await assert.rejects(first.read(ordinary, 'pi:ordinary:authority'), /metadata authority is missing/);
    await assert.rejects(first.append(event(Buffer.from('shared-secret'), 'pi:ordinary:authority')), /metadata authority is missing/);
    await writeFile(authority, '{"classification":"ordinary"}', { mode: 0o600 });
    await assert.rejects(first.read(ordinary, 'pi:ordinary:authority'), /invalid artifact metadata authority/);
    await unlink(authority);
  } finally {
    first.close();
  }
  const recovered = await ArtifactJournal.open(options);
  try {
    const ordinary = { ref: `raw:sha256:${sha256(Buffer.from('shared-secret'))}`, hash: `sha256:${sha256(Buffer.from('shared-secret'))}`, mediaType: 'application/json' };
    await assert.rejects(recovered.read(ordinary, 'pi:ordinary:authority'), ArtifactAccessError);
    assert.deepEqual(await recovered.read(ordinary, 'pi:ordinary:authority', { permitSensitive: true }), Buffer.from('shared-secret'));
  } finally {
    recovered.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('two open current-format journals share a durable sensitivity elevation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm3-journal-authority-race-'));
  const options = { root, hostPolicy: { allowSensitiveWrites: true } };
  const seed = await ArtifactJournal.open(options);
  let ordinary: Awaited<ReturnType<ArtifactJournal['append']>>;
  try {
    ordinary = await seed.append(event(Buffer.from('cross-instance'), 'pi:ordinary:cross-instance'));
  } finally {
    seed.close();
  }
  const reader = await ArtifactJournal.open(options);
  const writer = await ArtifactJournal.open(options);
  try {
    await writer.append({ ...event(Buffer.from('cross-instance'), 'pi:sensitive:cross-instance'), classification: 'sensitive' }, { permitSensitive: true });
    await assert.rejects(reader.read(ordinary!, 'pi:ordinary:cross-instance'), ArtifactAccessError);

    const concurrent = await Promise.allSettled([
      reader.append(event(Buffer.from('concurrent-alias'), 'pi:ordinary:concurrent-alias')),
      writer.append({ ...event(Buffer.from('concurrent-alias'), 'pi:sensitive:concurrent-alias'), classification: 'sensitive' }, { permitSensitive: true }),
    ]);
    const sensitive = concurrent[1];
    assert.equal(sensitive.status, 'fulfilled');
    const ordinaryConcurrent = concurrent[0];
    if (ordinaryConcurrent.status === 'fulfilled') {
      await assert.rejects(reader.read(ordinaryConcurrent.value, 'pi:ordinary:concurrent-alias'), ArtifactAccessError);
    } else {
      assert.ok(ordinaryConcurrent.reason instanceof ArtifactAccessError);
    }
  } finally {
    reader.close();
    writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('streams more than one thousand events without rescanning durable metadata on append or read', async () => {
  let metadataScans = 0;
  await withJournal(async (journal) => {
    for (let index = 0; index < 1100; index += 1) {
      await journal.append(event(Buffer.from(`event-${index}`), `pi:scale:${index}`));
    }
    const raw = await journal.append(event(Buffer.from('after-scale'), 'pi:scale:after'));
    assert.deepEqual(await journal.read(raw, 'pi:scale:after'), Buffer.from('after-scale'));
    assert.equal(metadataScans, 1, 'only open may scan metadata during streaming append/read');
    await journal.reconcile();
    assert.equal(metadataScans, 2, 'reconcile retains the full durable validation scan');
  }, { root: '', hooks: { onMetadataScan: () => { metadataScans += 1; } } });
});
