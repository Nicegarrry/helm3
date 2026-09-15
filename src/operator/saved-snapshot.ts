import { constants, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { validateOperatorSnapshot } from './projection.js';
import type { SnapshotSource } from './types.js';

export const savedSnapshotByteLimit = 1024 * 1024;

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs;
}

/**
 * Reads one explicit exported projection. The file is evidence input only: it
 * never opens a Helm host, journal, or authority store and never grants action
 * authority to its contents.
 */
export async function readSavedOperatorSnapshot(path: string): Promise<SnapshotSource> {
  if (!path) throw new Error('snapshot path is required');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('snapshot must be a regular file');
    if (before.size > BigInt(savedSnapshotByteLimit)) throw new Error(`snapshot exceeds ${savedSnapshotByteLimit} byte limit`);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error('snapshot changed while reading');
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after)) throw new Error('snapshot changed while reading');
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('snapshot contains invalid JSON'); }
    const snapshot = validateOperatorSnapshot(parsed);
    return Object.freeze({
      async read() { return snapshot; },
      presentation: Object.freeze({ mode: 'historical-untrusted' as const }),
    });
  } finally {
    await handle.close();
  }
}
