import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { daemonAuthorization } from '../bin/daemon-auth.mjs';
import { fetchState } from '../bin/fleet.mjs';
import { minimalGateEnv } from '../src/sandbox.js';
import { minimalClaudeEnv } from '../src/claude.js';

test('daemon credentials are read afresh and malformed metadata never leaks into errors', () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-credentials-'));
  const file = join(home, 'serve.json');
  try {
    assert.throws(() => daemonAuthorization(home), /^Error: daemon authentication unavailable$/);
    for (const token of ['a'.repeat(64), 'b'.repeat(64)]) {
      writeFileSync(file, JSON.stringify({ token }), { mode: 0o600 });
      assert.equal(daemonAuthorization(home), `Bearer ${token}`);
      assert.ok(!Object.values(process.env).includes(token));
      assert.ok(!Object.values(minimalGateEnv(home, home)).includes(token));
      assert.ok(!Object.values(minimalClaudeEnv({ ...process.env, HELM_TOKEN: token })).includes(token));
    }
    for (const contents of ['{"token":"secret-unfinished', '{}', '{"token":"short"}']) {
      writeFileSync(file, contents);
      assert.throws(() => daemonAuthorization(home), /^Error: daemon authentication unavailable$/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('fleet fetch reads the token at each call and sends it only in Authorization', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-fleet-auth-'));
  try {
    for (const token of ['a'.repeat(64), 'b'.repeat(64)]) {
      writeFileSync(join(home, 'serve.json'), JSON.stringify({ port: 4747, token }), { mode: 0o600 });
      const request: typeof fetch = async (url, options) => {
        assert.equal(String(url), 'http://127.0.0.1:4747/api/state');
        assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${token}`);
        return new Response(JSON.stringify({ ok: true, observedAt: new Date().toISOString(), run: { spendUsd: 0, spendCapUsd: 0, activeWorkers: 0, maxWorkers: 3, unknownCostEvents: 0 }, workers: [], models: [] }));
      };
      await fetchState(home, request);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
