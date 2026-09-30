import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Lifecycle } from '../src/lifecycle.js';
import { serve } from '../src/server.js';
import { ALL_TOOL_NAMES, CORE_TOOL_NAMES, META_TOOL_NAMES, SUPERVISOR_TOOL_NAMES } from '../src/tools.js';
import type { ToolOutcome } from '../src/types.js';
import type { Helm } from '../src/helm.js';

/** A fake Helm: every tool method just returns a canned ok outcome. Enough to exercise the transport. */
const FAKE_WORKER = { workerId: 'w-abc12345', state: 'idle', role: 'builder', model: 'anthropic/claude', branch: 'helm/w-abc12345', head: '1234567890abcdef', createdAt: '2026-01-01T00:00:00.000Z' };
const FAKE_OVERVIEW_WORKER = { ...FAKE_WORKER, state: 'running', repoSlug: 'acme/widgets', objective: 'Add a <flag>', updatedAt: '2026-01-01T00:00:05.000Z', elapsedMs: 5000, spendUsd: 0.1234, tokens: 12345, unknownCostEvents: 0, lastEvent: { kind: 'tool.call', at: '2026-01-01T00:00:04.000Z', data: { tool: 'bash', summary: 'npm test' } }, resultStatus: null };
function createFakeHelm(home: string): Helm {
  const ok = (extra: Record<string, unknown> = {}): ToolOutcome<unknown> => ({ ok: true, ...extra });
  const method = (extra: Record<string, unknown> = {}) => async () => ok(extra);
  return {
    lifecycle: new Lifecycle(home, () => []),
    config: { home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 1000 },
    spawn: method({ workerId: 'w-1', branch: 'helm/w-1', worktree: '/tmp/w-1' }),
    inspect: method({ state: 'idle' }),
    list: method({ workers: [FAKE_WORKER] }),
    steer: method({ turn: 1 }),
    stop: method({ state: 'stopped' }),
    gate: method({ head: 'sha', passed: true, checks: [] }),
    prOpen: method({ number: 1, url: 'https://x', head: 'sha' }),
    prStatus: method({ number: 1, state: 'open', head: 'sha', mergeable: true, checks: [], reviews: [], url: 'https://x' }),
    reviewRequest: method({ reviewWorkerId: 'w-2' }),
    runStatus: method({ spendUsd: 0, spendCapUsd: 0, spendWarnUsd: 0, aboveSoftCap: false, activeWorkers: 0, maxWorkers: 3, unknownCostEvents: 0 }),
    overview: method({
      observedAt: '2026-01-01T00:00:05.000Z',
      run: { spendUsd: 0.1234, spendCapUsd: 5, spendWarnUsd: 4, aboveSoftCap: false, activeWorkers: 1, maxWorkers: 3, unknownCostEvents: 0 },
      workers: [FAKE_OVERVIEW_WORKER],
      models: [{ model: 'anthropic/claude', workers: 1, active: 1, spendUsd: 0.1234, tokens: 12345 }],
      spendSeries: [{ at: '2026-01-01T00:00:01.000Z', spendUsd: 0.05 }, { at: '2026-01-01T00:00:04.000Z', spendUsd: 0.1234 }],
    }),
    prMerge: method({ merged: true }),
  } as unknown as Helm;
}

async function withServer(fn: (port: number, helm: Helm) => Promise<void>, tools: 'core' | 'supervisor' | 'all' = 'all'): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'helm-serve-'));
  const helm = createFakeHelm(home);
  const handle = await serve({ helm, port: 0, tools });
  try {
    assert.ok(handle.port, 'http mode should report the bound port');
    await fn(handle.port as number, helm);
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

test('serve http: GET / returns the plain-text CLI table', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/plain'));
    const body = await res.text();
    assert.match(body, /w-abc12345/);
    assert.doesNotMatch(body, /<html/);
  });
});

test('serve http: GET /api/state returns the overview JSON', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; models: Array<{ model: string }> };
    assert.equal(body.ok, true);
    assert.equal(body.models[0]?.model, 'anthropic/claude');
  });
});

test('serve http: GET /api/state includes spendSeries', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    const body = (await res.json()) as { ok: boolean; spendSeries: Array<{ at: string; spendUsd: number }> };
    assert.equal(body.ok, true);
    assert.equal(body.spendSeries.length, 2);
    assert.equal(body.spendSeries[1]?.spendUsd, 0.1234);
  });
});

test('serve http: GET /api/status returns ok JSON', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.maxWorkers, 3);
  });
});

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

test('serve http: /mcp initialize + tools/list via the MCP SDK client returns every tool', async () => {
  await withServer(async (port) => {
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, ALL_TOOL_NAMES.length);
      for (const name of ALL_TOOL_NAMES) assert.ok(tools.some((t) => t.name === name), `missing tool: ${name}`);
    } finally {
      await client.close();
    }
  });
});

test('MCP tool profiles stay within their serialized context budgets', async () => {
  const expected = {
    core: [...CORE_TOOL_NAMES, ...META_TOOL_NAMES],
    supervisor: [...SUPERVISOR_TOOL_NAMES, ...META_TOOL_NAMES],
  } as const;
  for (const profile of ['core', 'supervisor'] as const) {
    await withServer(async (port) => {
      const client = new Client({ name: `${profile}-size-client`, version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      try {
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name).sort(), [...expected[profile]].sort());
        const serialized = JSON.stringify(tools);
        assert.doesNotMatch(serialized, /\"\$schema\"/);
        assert.doesNotMatch(serialized, /9007199254740991/);
        assert.ok(serialized.length <= (profile === 'core' ? 3_600 : 8_500), `${profile} tools/list is ${serialized.length} chars`);
      } finally { await client.close(); }
    }, profile);
  }
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


test('MCP drain closes admission for both MCP and CLI HTTP calls and keeps reads available', async () => {
  await withServer(async (port) => {
    const client = new Client({ name: 'drain-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      };
      assert.equal((await call('daemon.control', { action: 'drain' })).phase, 'ready');
      const http = await postWithHost(port, '/tools/worker.spawn', `127.0.0.1:${port}`, JSON.stringify({ repo: '/repo', objective: 'new' }));
      assert.match(JSON.parse(http.body).reason, /draining/);
      assert.equal((await call('worker.spawn', { repo: '/repo', objective: 'new' })).ok, false);
      assert.equal((await call('run.status', {})).ok, true);
      assert.equal((await call('daemon.control', { action: 'resume' })).phase, 'accepting');
      assert.equal((await call('worker.spawn', { repo: '/repo', objective: 'new' })).ok, true);
    } finally { await client.close(); }
  });
});
