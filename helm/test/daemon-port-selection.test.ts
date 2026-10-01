import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDetachedDaemonPort } from '../src/cli.js';

test('an injected default port held by another Helm home falls back to random', async () => {
  const warnings: string[] = [];
  const result = await selectDetachedDaemonPort(48111, 48111, '/isolated/serve.json', {
    canListen: async () => false,
    isHelmListener: async () => true,
    readLive: () => undefined,
    sleep: async () => undefined,
    warn: (line) => warnings.push(line),
  });
  assert.equal(result.port, 0);
  assert.match(warnings[0]!, /48111.*another Helm home/);
});

test('an injected default port waits for and reuses same-home metadata', async () => {
  let reads = 0;
  const result = await selectDetachedDaemonPort(48112, 48112, '/shared/serve.json', {
    canListen: async () => false,
    readLive: () => ++reads === 2 ? { port: 48112, pid: 42 } : undefined,
    sleep: async () => undefined,
    warn: () => assert.fail('same-home metadata must be reused without a warning'),
  });
  assert.deepEqual(result, { port: 48112, live: { port: 48112, pid: 42 } });
});
