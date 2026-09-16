import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ArtifactIndexPort, ArtifactMetadata } from './index.js';

/** A replaceable, non-authoritative query projection of durable sidecar metadata. */
export class SQLiteArtifactIndex implements ArtifactIndexPort {
  private constructor(private readonly database: DatabaseSync) {}

  static async open(path: string): Promise<SQLiteArtifactIndex> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let created = false;
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error(`artifact index must be a regular file: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      created = true;
    }

    const database = new DatabaseSync(path);
    try {
      database.exec('PRAGMA busy_timeout = 5000;');
      database.exec(
        'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS helm_artifact_index (source_identity TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);',
      );
      if (created) await chmod(path, 0o600);
      return new SQLiteArtifactIndex(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async findBySourceIdentity(sourceIdentity: string): Promise<ArtifactMetadata | undefined> {
    const row = this.database
      .prepare('SELECT metadata_json FROM helm_artifact_index WHERE source_identity = ?')
      .get(sourceIdentity) as { metadata_json?: string } | undefined;
    return row?.metadata_json ? (JSON.parse(row.metadata_json) as ArtifactMetadata) : undefined;
  }

  async record(metadata: ArtifactMetadata): Promise<void> {
    this.database
      .prepare(
        'INSERT INTO helm_artifact_index (source_identity, metadata_json) VALUES (?, ?) ON CONFLICT(source_identity) DO NOTHING;',
      )
      .run(metadata.sourceIdentity, JSON.stringify(metadata));

    const existing = await this.findBySourceIdentity(metadata.sourceIdentity);
    if (!existing || existing.recordId !== metadata.recordId) {
      throw new Error(`artifact index source identity conflict: ${metadata.sourceIdentity}`);
    }
  }

  async reset(): Promise<void> {
    this.database.exec('DELETE FROM helm_artifact_index;');
  }

  close(): void {
    this.database.close();
  }
}
