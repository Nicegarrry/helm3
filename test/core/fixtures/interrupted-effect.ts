import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { openKernel } from '../../../src/core/index.js';

const [databasePath, marker] = process.argv.slice(2);
const now = '2026-09-15T00:00:00Z';
const later = '2026-09-15T01:00:00Z';
const payload = { value: 'safe' };
const payloadHash = `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
const { kernel, host } = openKernel({ databasePath, kinds: { 'test.effect': { payloadSchema: z.object({ value: z.string() }).strict() } }, now: () => now });
host.issueAutonomyLease({ leaseId: 'lease-1', revision: 1, issuedBy: 'human', parentAuthorityId: 'authority-1', scope: { repositoryId: 'repo-1', mapNodeIds: ['node-1'] }, allowedActions: ['test.effect'], issuedAt: now, expiresAt: later, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
host.admit({ schemaVersion: 1, commandId: 'command-1', kind: 'test.effect', idempotencyKey: 'idempotency-1', payloadHash, scope: { repositoryId: 'repo-1', mapNodeId: 'node-1' }, actorId: 'forged', runId: 'run-1', origin: 'worker', leaseId: 'lease-1', leaseRevision: 1, plannedAt: now, notAfter: later, expected: [], payload, requiredEvidence: [] }, { actorId: 'trusted', allowedOrigins: ['worker'] });
const claim = host.claim('command-1', { executorId: 'worker' }, '2026-09-15T00:10:00Z');
void host.perform('command-1', claim, { executorId: 'worker' }, async () => ({ value: true, state: 'known', source: 'git', observedAt: now }), {
  effectId: 'effect-1',
  execute: async () => { writeFileSync(marker, 'external effect happened'); process.exit(91); },
  observe: async () => ({ commandId: 'command-1', effectId: 'effect-1', state: 'succeeded', source: 'fixture', observedAt: now, evidenceRefs: ['artifact:fixture'] }),
});
