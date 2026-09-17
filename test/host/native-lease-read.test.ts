import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AutonomyLease } from '../../src/contracts/index.js';
import { openHost } from '../../src/host/index.js';

const now = '2026-09-17T00:00:00Z';
const later = '2026-09-17T01:00:00Z';

test('host reads an unreferenced autonomy lease and rejects missing, mismatched, and revoked authority', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'helm3-native-lease-read-'));
  const host = await openHost({ stateDirectory, kinds: {}, now: () => now });
  try {
    host.recordHumanAuthority({
      authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn'],
      expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [],
    });
    const lease: AutonomyLease = {
      leaseId: 'lease', revision: 1, issuedBy: 'test', parentAuthorityId: 'human',
      scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn'],
      issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [],
    };
    host.recordAutonomyLease(lease);

    assert.deepEqual(host.readAutonomyLease('lease', 1), lease);
    assert.equal(host.readAutonomyLease('missing', 1), undefined);
    assert.equal(host.readAutonomyLease('lease', 2), undefined);
    host.revokeAutonomyLease('lease');
    assert.equal(host.readAutonomyLease('lease', 1), undefined);
  } finally {
    host.close();
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
