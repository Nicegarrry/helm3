import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Helm } from '../src/helm.js';
import { createDaemonCatalogs } from '../src/server.js';

test('daemon reuses registry, schemas, validators and hash within each profile and resets on a new boot', () => {
  const get = createDaemonCatalogs({} as Helm);
  const nextBoot = createDaemonCatalogs({} as Helm);
  const hashes = new Set<string>();
  for (const profile of ['core', 'supervisor', 'all'] as const) {
    const first = get(profile);
    const again = get(profile);
    assert.equal(again, first);
    assert.equal(again.registry, first.registry);
    assert.equal(again.tools, first.tools);
    assert.equal(again.inputs, first.inputs);
    assert.equal(first.hash, createHash('sha256').update(JSON.stringify(first.tools)).digest('hex'));
    assert.notEqual(nextBoot(profile), first);
    assert.equal(nextBoot(profile).hash, first.hash);
    hashes.add(first.hash);
    if (profile !== 'all') assert.ok(JSON.stringify(first.tools).length <= (profile === 'core' ? 3600 : 8500));
  }
  assert.equal(hashes.size, 3);
});
