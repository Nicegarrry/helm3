import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readdir, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RawArtifactRef } from '../contracts/index.js';
import { SQLiteArtifactIndex } from './sqlite-index.js';

const SHA256 = /^[a-f0-9]{64}$/;
const REF_PREFIX = 'raw:sha256:';

export type ArtifactClassification = 'ordinary' | 'sensitive';
export type ArtifactAccessContext = Readonly<{ permitSensitive: boolean }>;
export type ArtifactHostPolicy = Readonly<{ allowSensitiveWrites: boolean }>;

export type ArtifactMetadata = Readonly<{
  recordId: string;
  schemaVersion: 1;
  source: string;
  sourceIdentity: string;
  raw: RawArtifactRef;
  classification: ArtifactClassification;
  derivedFrom?: RawArtifactRef;
}>;

export interface ArtifactIndexPort {
  findBySourceIdentity(sourceIdentity: string): Promise<ArtifactMetadata | undefined>;
  record(metadata: ArtifactMetadata): Promise<void>;
  reset(): Promise<void>;
  close?(): void;
}

export type ArtifactAppend = Readonly<{
  source: string;
  sourceIdentity: string;
  mediaType: string;
  bytes: Uint8Array;
  classification?: ArtifactClassification;
  derivedFrom?: RawArtifactRef;
}>;

export type ArtifactIssue = Readonly<{
  kind: 'orphan_raw' | 'missing_raw' | 'corrupt_raw' | 'unindexed_metadata';
  hash: string;
  sourceIdentity: string | 'unknown';
}>;

export class ArtifactConflictError extends Error {}
export class ArtifactAccessError extends Error {}
export class ArtifactIntegrityError extends Error {}

export type ArtifactJournalOptions = Readonly<{
  root: string;
  index?: ArtifactIndexPort;
  indexPath?: string;
  hostPolicy?: ArtifactHostPolicy;
  hooks?: Readonly<{
    afterRawPublished?: () => Promise<void>;
    afterMetadataPublishedBeforeIndex?: () => Promise<void>;
    onMetadataScan?: () => void;
  }>;
}>;

function required(value: string, field: string): string {
  if (value.trim() !== value || value.length === 0) throw new Error(`${field} must be a nonempty trimmed string`);
  return value;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function refFor(hash: string, mediaType: string): RawArtifactRef {
  return { ref: `${REF_PREFIX}${hash}`, hash: `sha256:${hash}`, mediaType };
}

function recordIdFor(metadata: Omit<ArtifactMetadata, 'recordId'>): string {
  return hashBytes(Buffer.from(JSON.stringify([
    metadata.schemaVersion,
    metadata.source,
    metadata.sourceIdentity,
    metadata.raw.ref,
    metadata.raw.hash,
    metadata.raw.mediaType,
    metadata.classification,
    metadata.derivedFrom ?? null,
  ])));
}

function metadataPathId(sourceIdentity: string): string {
  return hashBytes(Buffer.from(JSON.stringify([sourceIdentity])));
}

function hashFromRef(raw: RawArtifactRef): string {
  const hash = raw.hash.replace(/^sha256:/, '');
  if (!SHA256.test(hash) || raw.ref !== `${REF_PREFIX}${hash}` || raw.mediaType.trim() !== raw.mediaType || raw.mediaType.length === 0) {
    throw new ArtifactIntegrityError('artifact reference is not canonical');
  }
  return hash;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new ArtifactIntegrityError(`journal directory must be a real directory: ${path}`);
  await chmod(path, 0o700);
}

async function regularFile(path: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new ArtifactIntegrityError(`journal artifact must be a regular file: ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicFile(path: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await regularFile(path);
    const existing = await readFile(path);
    if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw new ArtifactConflictError(`immutable artifact collision: ${path}`);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await syncDirectory(directory);
}

async function replaceFile(path: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch((unlinkError: NodeJS.ErrnoException) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    throw error;
  }
}

/**
 * Raw bytes plus durable per-source metadata. The supplied SQLite index is a
 * rebuildable projection; it never creates Helm Log facts.
 */
export class ArtifactJournal {
  private constructor(
    private readonly root: string,
    private readonly index: ArtifactIndexPort,
    private readonly hostPolicy: ArtifactHostPolicy,
    private readonly hooks: NonNullable<ArtifactJournalOptions['hooks']>,
  ) {}

  static async open(options: ArtifactJournalOptions): Promise<ArtifactJournal> {
    await privateDirectory(options.root);
    await Promise.all([
      privateDirectory(join(options.root, 'raw')),
      privateDirectory(join(options.root, 'raw', 'sha256')),
      privateDirectory(join(options.root, 'metadata')),
      privateDirectory(join(options.root, 'authority')),
      privateDirectory(join(options.root, 'authority', 'sha256')),
      privateDirectory(join(options.root, 'index')),
    ]);
    const index = options.index ?? await SQLiteArtifactIndex.open(options.indexPath ?? join(options.root, 'index', 'artifact-index.sqlite'));
    const journal = new ArtifactJournal(options.root, index, options.hostPolicy ?? { allowSensitiveWrites: false }, options.hooks ?? {});
    // The sidecars remain the durable record. This full validation/backfill is
    // deliberately at the lifecycle boundary, not on each streaming event.
    await journal.syncMetadataAuthority(await journal.allMetadata());
    return journal;
  }

  async append(input: ArtifactAppend, access: ArtifactAccessContext = { permitSensitive: false }): Promise<RawArtifactRef> {
    // Callers may mutate Uint8Arrays or reference objects after invoking this async method.
    // Freeze the durable input before the first await so hash, bytes, and metadata agree.
    const bytes = Buffer.from(input.bytes);
    const derivedFrom = input.derivedFrom ? { ...input.derivedFrom } : undefined;
    const source = required(input.source, 'source');
    const sourceIdentity = required(input.sourceIdentity, 'sourceIdentity');
    const mediaType = required(input.mediaType, 'mediaType');
    const classification = input.classification ?? 'ordinary';
    if (classification === 'sensitive' && (!this.hostPolicy.allowSensitiveWrites || !access.permitSensitive)) {
      throw new ArtifactAccessError('sensitive artifact write requires trusted host policy and access context');
    }
    if (derivedFrom) {
      const parentHash = hashFromRef(derivedFrom);
      await this.assertRawIntact(parentHash);
    }

    const hash = hashBytes(bytes);
    const raw = refFor(hash, mediaType);
    await this.ensureMetadataAuthority(hash, classification);
    const metadataWithoutId: Omit<ArtifactMetadata, 'recordId'> = {
      schemaVersion: 1,
      source,
      sourceIdentity,
      raw,
      classification,
      ...(derivedFrom ? { derivedFrom } : {}),
    };
    const metadata: ArtifactMetadata = { ...metadataWithoutId, recordId: recordIdFor(metadataWithoutId) };
    const existing = await this.findMetadata(sourceIdentity);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(metadata)) {
        await this.assertRawIntact(hash);
        const indexed = await this.index.findBySourceIdentity(sourceIdentity);
        if (indexed?.recordId !== existing.recordId) await this.index.record(existing);
        return existing.raw;
      }
      throw new ArtifactConflictError(`source identity already records different immutable bytes: ${sourceIdentity}`);
    }

    const rawPath = this.rawPath(hash);
    try {
      await regularFile(rawPath);
      const existingBytes = await readFile(rawPath);
      if (hashBytes(existingBytes) !== hash) throw new ArtifactIntegrityError(`existing raw file hash mismatch: ${hash}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await atomicFile(rawPath, bytes);
    }
    await this.hooks.afterRawPublished?.();

    await atomicFile(this.metadataPath(sourceIdentity), Buffer.from(JSON.stringify(metadata)));
    await this.hooks.afterMetadataPublishedBeforeIndex?.();
    await this.index.record(metadata);
    return raw;
  }

  async read(raw: RawArtifactRef, sourceIdentity: string, access: ArtifactAccessContext = { permitSensitive: false }): Promise<Buffer> {
    const metadata = await this.findMetadata(required(sourceIdentity, 'sourceIdentity'));
    if (!metadata || metadata.raw.ref !== raw.ref || metadata.raw.hash !== raw.hash || metadata.raw.mediaType !== raw.mediaType) {
      throw new ArtifactIntegrityError('artifact source identity does not match durable metadata');
    }
    const hash = hashFromRef(raw);
    const authority = await this.metadataAuthority(hash);
    if ((metadata.classification === 'sensitive' || authority === 'sensitive') && !access.permitSensitive) throw new ArtifactAccessError('sensitive artifact read requires trusted access context');
    const path = this.rawPath(hash);
    try {
      await regularFile(path);
      const bytes = await readFile(path);
      if (hashBytes(bytes) !== hash) throw new ArtifactIntegrityError(`artifact bytes do not match ${raw.hash}`);
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactIntegrityError(`artifact bytes are missing: ${raw.hash}`);
      throw error;
    }
  }

  async reconcile(): Promise<ArtifactIssue[]> {
    const metadata = await this.allMetadata();
    await this.syncMetadataAuthority(metadata);
    const indexed = new Set<string>();
    const issues: ArtifactIssue[] = [];
    for (const entry of metadata) {
      indexed.add(hashFromRef(entry.raw));
      try {
        await regularFile(this.rawPath(hashFromRef(entry.raw)));
        const bytes = await readFile(this.rawPath(hashFromRef(entry.raw)));
        if (hashBytes(bytes) !== hashFromRef(entry.raw)) issues.push({ kind: 'corrupt_raw', hash: entry.raw.hash, sourceIdentity: entry.sourceIdentity });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') issues.push({ kind: 'missing_raw', hash: entry.raw.hash, sourceIdentity: entry.sourceIdentity });
        else throw error;
      }
      const indexedEntry = await this.index.findBySourceIdentity(entry.sourceIdentity);
      if (indexedEntry?.recordId !== entry.recordId) issues.push({ kind: 'unindexed_metadata', hash: entry.raw.hash, sourceIdentity: entry.sourceIdentity });
    }
    for (const name of await readdir(join(this.root, 'raw', 'sha256'))) {
      if (SHA256.test(name) && !indexed.has(name)) issues.push({ kind: 'orphan_raw', hash: `sha256:${name}`, sourceIdentity: 'unknown' });
    }
    return issues;
  }

  async rebuildIndex(): Promise<number> {
    const metadata = await this.allMetadata();
    // Validate the complete durable input before touching the replaceable projection.
    // A failed rebuild must leave the last known-good index intact.
    for (const entry of metadata) await this.assertRawIntact(hashFromRef(entry.raw));
    await this.index.reset();
    for (const entry of metadata) await this.index.record(entry);
    return metadata.length;
  }

  close(): void { this.index.close?.(); }

  /** Trusted hosts may build projections from durable metadata without reading artifact bytes. */
  async metadata(): Promise<readonly ArtifactMetadata[]> { return this.allMetadata(); }

  private rawPath(hash: string): string { return join(this.root, 'raw', 'sha256', hash); }
  private metadataPath(sourceIdentity: string): string {
    return join(this.root, 'metadata', `${metadataPathId(sourceIdentity)}.json`);
  }
  private authorityPath(hash: string): string { return join(this.root, 'authority', 'sha256', `${hash}.json`); }

  private async allMetadata(): Promise<ArtifactMetadata[]> {
    this.hooks.onMetadataScan?.();
    const files = await readdir(join(this.root, 'metadata'));
    const entries: ArtifactMetadata[] = [];
    const identities = new Map<string, ArtifactMetadata>();
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const path = join(this.root, 'metadata', file);
      await regularFile(path);
      const entry = this.parseMetadata(JSON.parse(await readFile(path, 'utf8')), file);
      const sameIdentity = identities.get(entry.sourceIdentity);
      if (sameIdentity && sameIdentity.recordId !== entry.recordId) throw new ArtifactConflictError(`duplicate durable source identity: ${entry.sourceIdentity}`);
      identities.set(entry.sourceIdentity, entry);
      entries.push(entry);
    }
    return entries;
  }

  private async findMetadata(sourceIdentity: string): Promise<ArtifactMetadata | undefined> {
    const file = `${metadataPathId(sourceIdentity)}.json`;
    const path = join(this.root, 'metadata', file);
    try {
      await regularFile(path);
      return this.parseMetadata(JSON.parse(await readFile(path, 'utf8')), file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private authorityBytes(hash: string, classification: ArtifactClassification): Buffer {
    return Buffer.from(JSON.stringify({ schemaVersion: 1, hash: `sha256:${hash}`, classification }));
  }

  private async metadataAuthority(hash: string): Promise<ArtifactClassification> {
    const path = this.authorityPath(hash);
    try {
      await regularFile(path);
      const input = JSON.parse(await readFile(path, 'utf8')) as Partial<{ schemaVersion: number; hash: string; classification: string }>;
      if (input.schemaVersion !== 1 || input.hash !== `sha256:${hash}` || (input.classification !== 'ordinary' && input.classification !== 'sensitive')) {
        throw new ArtifactIntegrityError(`invalid artifact metadata authority: ${hash}`);
      }
      return input.classification;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactIntegrityError(`artifact metadata authority is missing: ${hash}`);
      throw error;
    }
  }

  private async ensureMetadataAuthority(hash: string, classification: ArtifactClassification, allowBackfill = false): Promise<void> {
    const path = this.authorityPath(hash);
    if (classification === 'sensitive') {
      await replaceFile(path, this.authorityBytes(hash, 'sensitive'));
      return;
    }
    try {
      const existing = await this.metadataAuthority(hash);
      if (existing === 'sensitive') throw new ArtifactAccessError('ordinary artifact cannot alias existing sensitive bytes');
      return;
    } catch (error) {
      if (!(error instanceof ArtifactIntegrityError) || !error.message.startsWith('artifact metadata authority is missing:')) throw error;
    }
    if (!allowBackfill) {
      try {
        await regularFile(this.rawPath(hash));
        throw new ArtifactIntegrityError(`artifact metadata authority is missing: ${hash}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    try {
      await atomicFile(path, this.authorityBytes(hash, 'ordinary'));
    } catch (error) {
      if (!(error instanceof ArtifactConflictError) || await this.metadataAuthority(hash) !== 'sensitive') throw error;
      throw new ArtifactAccessError('ordinary artifact cannot alias existing sensitive bytes');
    }
    if (await this.metadataAuthority(hash) === 'sensitive') {
      throw new ArtifactAccessError('ordinary artifact cannot alias existing sensitive bytes');
    }
  }

  private async syncMetadataAuthority(metadata: readonly ArtifactMetadata[]): Promise<void> {
    const classifications = new Map<string, ArtifactClassification>();
    for (const entry of metadata) {
      const hash = hashFromRef(entry.raw);
      if (entry.classification === 'sensitive') classifications.set(hash, 'sensitive');
      else if (!classifications.has(hash)) classifications.set(hash, 'ordinary');
    }
    for (const [hash, classification] of classifications) {
      if (classification === 'sensitive') await this.ensureMetadataAuthority(hash, 'sensitive');
      else {
        try {
          await this.metadataAuthority(hash);
        } catch (error) {
          if (!(error instanceof ArtifactIntegrityError) || !error.message.startsWith('artifact metadata authority is missing:')) throw error;
          await this.ensureMetadataAuthority(hash, 'ordinary', true);
        }
      }
    }
  }

  private parseMetadata(input: unknown, file: string): ArtifactMetadata {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ArtifactIntegrityError(`invalid artifact metadata: ${file}`);
    const entry = input as Partial<ArtifactMetadata>;
    if (entry.schemaVersion !== 1
      || typeof entry.recordId !== 'string'
      || typeof entry.source !== 'string'
      || typeof entry.sourceIdentity !== 'string'
      || entry.classification !== 'ordinary' && entry.classification !== 'sensitive'
      || typeof entry.raw !== 'object' || entry.raw === null) throw new ArtifactIntegrityError(`invalid artifact metadata: ${file}`);
    required(entry.source, 'metadata source');
    required(entry.sourceIdentity, 'metadata sourceIdentity');
    const raw = entry.raw as RawArtifactRef;
    hashFromRef(raw);
    if (entry.derivedFrom !== undefined) hashFromRef(entry.derivedFrom);
    const metadataWithoutId: Omit<ArtifactMetadata, 'recordId'> = {
      schemaVersion: 1,
      source: entry.source,
      sourceIdentity: entry.sourceIdentity,
      raw,
      classification: entry.classification,
      ...(entry.derivedFrom ? { derivedFrom: entry.derivedFrom } : {}),
    };
    if (file.slice(0, -5) !== metadataPathId(entry.sourceIdentity) || entry.recordId !== recordIdFor(metadataWithoutId)) {
      throw new ArtifactIntegrityError(`invalid artifact metadata: ${file}`);
    }
    return { ...metadataWithoutId, recordId: entry.recordId };
  }

  private async assertRawIntact(hash: string): Promise<void> {
    const path = this.rawPath(hash);
    try {
      await regularFile(path);
      if (hashBytes(await readFile(path)) !== hash) throw new ArtifactIntegrityError(`artifact bytes do not match sha256:${hash}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactIntegrityError(`artifact bytes are missing: sha256:${hash}`);
      throw error;
    }
  }
}
