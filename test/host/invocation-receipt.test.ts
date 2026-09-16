import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openHost } from '../../src/host/index.js';

test('invocation receipt read distinguishes outcome, kind, session, and expiry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-invocation-read-'));
  let time = '2026-09-16T00:00:00Z';
  const host = await openHost({ stateDirectory: root, kinds: {}, now: () => time });
  const owner = { runId: 'run', sessionId: 'session', leaseId: 'ownership', owner: 'astra' as const, epoch: 1,
    issuedAt: time, expiresAt: '2026-09-16T01:00:00Z' };
  try {
    host.acquireOwnership(owner, 0);
    const artifacts = host.artifactsFor({ runId: 'run', sessionId: 'session', mode: 'primary' });
    for (const outcome of ['succeeded', 'failed', 'unknown'] as const) {
      const ref = await artifacts.saveInvocation({ driver: 'astra', sessionId: 'session', outcome, text: 'Model claims success regardless of SDK outcome.' });
      assert.equal((await artifacts.readInvocation(ref)).outcome, outcome);
    }
    const text = await artifacts.writeText('claim', JSON.stringify({ driver: 'astra', sessionId: 'session', outcome: 'succeeded', text: 'claim' }));
    await assert.rejects(artifacts.readInvocation(text), /wrong kind/);
    const ref = await artifacts.saveInvocation({ driver: 'astra', sessionId: 'session', outcome: 'succeeded', text: 'result' });
    host.acquireOwnership({ ...owner, epoch: 2, sessionId: 'replacement', leaseId: 'replacement' }, 1);
    const replacement = host.artifactsFor({ runId: 'run', sessionId: 'replacement', mode: 'primary' });
    await assert.rejects(replacement.readInvocation(ref), /outside the trusted/);
    await assert.rejects(artifacts.readInvocation(ref), /not the current/);
    const replacementRef = await replacement.saveInvocation({ driver: 'astra', sessionId: 'replacement', outcome: 'succeeded', text: 'result' });
    time = '2026-09-16T02:00:00Z';
    await assert.rejects(replacement.readInvocation(replacementRef), /inactive/);
  } finally { host.close(); await rm(root, { recursive: true, force: true }); }
});
