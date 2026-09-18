import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serve } from '../src/server.js';
import { TOOL_NAMES } from '../src/types.js';
import type { ToolOutcome } from '../src/types.js';
import type { Helm } from '../src/helm.js';

/** A fake Helm: every tool method just returns a canned ok outcome. Enough to exercise the transport. */
function createFakeHelm(home: string): Helm {
  const ok = (extra: Record<string, unknown> = {}): ToolOutcome<unknown> => ({ ok: true, ...extra });
  const method = (extra: Record<string, unknown> = {}) => async () => ok(extra);
  return {
    config: { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 1000 },
    spawn: method({ workerId: 'w-1', branch: 'helm/w-1', worktree: '/tmp/w-1' }),
    inspect: method({ state: 'idle' }),
    list: method({ workers: [] }),
    steer: method({ turn: 1 }),
    stop: method({ state: 'stopped' }),
    gate: method({ head: 'sha', passed: true, checks: [] }),
    prOpen: method({ number: 1, url: 'https://x', head: 'sha' }),
    prStatus: method({ number: 1, state: 'open', head: 'sha', mergeable: true, checks: [], reviews: [], url: 'https://x' }),
    reviewRequest: method({ reviewWorkerId: 'w-2' }),
    runStatus: method({ spendUsd: 0, spendCapUsd: 0, activeWorkers: 0, maxWorkers: 3, unknownCostEvents: 0 }),
    prMerge: method({ merged: true }),
  } as unknown as Helm;
}

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'helm-serve-'));
  const helm = createFakeHelm(home);
  const handle = await serve({ helm, mode: 'http', port: 0 });
  try {
    assert.ok(handle.port, 'http mode should report the bound port');
    await fn(handle.port as number);
  } finally {
    await handle.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** Raw node:http POST so we can set a Host header fetch() would normally normalize itself. */
function postWithHost(port: number, path: string, host: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('serve http: POST /tools/run.status returns ok JSON', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/tools/run.status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.maxWorkers, 3);
  });
});

test('serve http: /mcp initialize + tools/list via the MCP SDK client returns 11 tools', async () => {
  await withServer(async (port) => {
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, TOOL_NAMES.length);
      for (const name of TOOL_NAMES) assert.ok(tools.some((t) => t.name === name), `missing tool: ${name}`);
    } finally {
      await client.close();
    }
  });
});

test('serve http: a Host header mismatch is rejected with 403', async () => {
  await withServer(async (port) => {
    const res = await postWithHost(port, '/tools/run.status', 'evil.example.com', '{}');
    assert.equal(res.status, 403);
  });
});

test('F12: a request body over 1 MiB is rejected with 413', async () => {
  await withServer(async (port) => {
    const bigBody = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) });
    const res = await postWithHost(port, '/tools/run.status', `127.0.0.1:${port}`, bigBody);
    assert.equal(res.status, 413);
  });
});

test('F12: an invalid JSON body returns 400, not 500', async () => {
  await withServer(async (port) => {
    const res = await postWithHost(port, '/tools/run.status', `127.0.0.1:${port}`, '{not valid json');
    assert.equal(res.status, 400);
  });
});
