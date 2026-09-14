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

test('conflicting durable source sidecars fail reconciliation instead of selecting one record', async () => {
  await withJournal(async (journal, root) => {
    await journal.append(event(Buffer.from('first'), 'pi:event:race'));
    const other = await journal.append(event(Buffer.from('second'), 'pi:event:other'));
    const otherPath = join(root, 'metadata', `${sha256(Buffer.from(JSON.stringify(['pi', 'pi:event:other', other.hash.slice('sha256:'.length)])))}.json`);
    const conflicting = JSON.parse(await readFile(otherPath, 'utf8'));
    conflicting.sourceIdentity = 'pi:event:race';
    conflicting.recordId = sha256(Buffer.from(JSON.stringify([conflicting.source, conflicting.sourceIdentity, other.hash.slice('sha256:'.length)])));
    await writeFile(join(root, 'metadata', `${conflicting.recordId}.json`), JSON.stringify(conflicting), { mode: 0o600 });
    await assert.rejects(journal.reconcile(), /duplicate durable source identity/);
    await assert.rejects(journal.rebuildIndex(), /duplicate durable source identity/);
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
