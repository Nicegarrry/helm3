import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod/v3';
import { AstraLoopbackMcpTransport, HelmToolRegistry, type HelmToolExecutionContext } from '../../src/runtime/orchestrator/index.js';

const session = { runId: 'run-loopback', sessionId: 'helm:astra:loopback', mode: 'primary' as const };

async function postWithHost(url: URL, host: string, authorization: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const pending = request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { host, authorization, 'content-length': '2' } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
    });
    pending.once('error', reject); pending.end('{}');
  });
}

async function postChunked(url: URL, authorization: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const pending = request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { authorization } }, (response) => {
      response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
    });
    pending.once('error', reject); pending.write(body); pending.end();
  });
}

async function clientFor(bridge: AstraLoopbackMcpTransport) {
  const [{ Client }, { StreamableHTTPClientTransport }, { CallToolResultSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const [envKey, token] = Object.entries(bridge.env)[0]!;
  assert.equal(bridge.config.mcp_servers.helm.bearer_token_env_var, envKey);
  const transport = new StreamableHTTPClientTransport(new URL(bridge.config.mcp_servers.helm.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'helm-loopback-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport, CallToolResultSchema };
}

test('Astra loopback MCP uses a generated local config and dispatches the shared registry with trusted context', async () => {
  let received: HelmToolExecutionContext | undefined;
  const registry = new HelmToolRegistry([{
    name: 'brief.get', description: 'Read a Brief.', input: { id: z.string().min(1) },
    async execute(input, context) { received = context; return { state: 'succeeded', value: input }; },
  }]);
  const suppliedSession = { ...session };
  const bridge = await AstraLoopbackMcpTransport.open({ registry, guard: { async assertCurrent() {} }, session: suppliedSession });
  suppliedSession.runId = 'mutated-after-open';
  try {
    const url = new URL(bridge.config.mcp_servers.helm.url);
    const [envKey, token] = Object.entries(bridge.env)[0]!;
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/mcp');
    assert.match(envKey, /^HELM_ASTRA_MCP_TOKEN_[A-F0-9]{24}$/);
    assert.equal(token.length >= 43, true);
    assert.doesNotMatch(JSON.stringify(bridge.config), new RegExp(token));
    assert.deepEqual(Object.keys(bridge.config.mcp_servers.helm).sort(), ['bearer_token_env_var', 'url']);

    const unauthenticated = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(unauthenticated.status, 401);
    const hostileOrigin = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body: '{}' });
    assert.equal(hostileOrigin.status, 403);
    assert.equal(await postWithHost(url, 'localhost', `Bearer ${token}`), 403);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await fetch(new URL('/unknown', url), { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status, 404);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'x'.repeat(64 * 1024 + 1) })).status, 413);
    assert.equal(await postChunked(url, `Bearer ${token}`, 'x'.repeat(64 * 1024 + 1)), 413, 'chunked requests are bounded without Content-Length');

    const { client, transport, CallToolResultSchema } = await clientFor(bridge);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), ['brief.get']);
      const successful = await client.callTool({ name: 'brief.get', arguments: { id: 'brief-1' } }, CallToolResultSchema);
      assert.equal(successful.isError, false);
      assert.deepEqual(successful.structuredContent, { state: 'succeeded', value: { id: 'brief-1' } });
      assert.deepEqual(received, session);
      const malformed = await client.callTool({ name: 'brief.get', arguments: { id: '' } }, CallToolResultSchema);
      assert.equal(malformed.isError, true);
      const missing = await client.callTool({ name: 'missing', arguments: {} }, CallToolResultSchema);
      assert.equal(missing.isError, true);
    } finally { await transport.close(); }
    const resumed = await clientFor(bridge);
    try {
      const response = await resumed.client.callTool({ name: 'brief.get', arguments: { id: 'brief-2' } }, resumed.CallToolResultSchema);
      assert.equal(response.isError, false, 'a fresh MCP client can initialize against the same Helm session bridge');
    } finally { await resumed.transport.close(); }
    const root = await mkdtemp(join(tmpdir(), 'helm3-astra-mcp-config-'));
    const executable = join(root, 'fake-codex.mjs'); const trace = join(root, 'args.json');
    try {
      await writeFile(executable, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
await writeFile(process.env.TRACE_PATH, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'local-config' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }));
`, { mode: 0o700 });
      await chmod(executable, 0o700);
      const { Codex } = await import('@openai/codex-sdk');
      const codex = new Codex({ codexPathOverride: executable, config: bridge.config as never, env: { PATH: process.env.PATH ?? '', TRACE_PATH: trace, ...bridge.env } });
      const { events } = await codex.startThread({ approvalPolicy: 'never', sandboxMode: 'read-only', networkAccessEnabled: false, webSearchMode: 'disabled', skipGitRepoCheck: true }).runStreamed('local config only');
      for await (const _event of events) { /* exercise the actual pinned SDK process path */ }
      const args = JSON.parse(await readFile(trace, 'utf8')) as string[];
      assert.ok(args.some((arg) => arg.includes('mcp_servers.helm.url') && arg.includes(url.toString())));
      assert.ok(args.some((arg) => arg.includes('mcp_servers.helm.bearer_token_env_var') && arg.includes(envKey)));
      assert.ok(args.every((arg) => !arg.includes(token)), 'the pinned Codex SDK receives the generated env-key reference, never the bearer value');
    } finally { await rm(root, { recursive: true, force: true }); }
  } finally { assert.deepEqual(await bridge.close(), { observed: 'stopped' }); }
});

test('Astra loopback MCP refuses stale ownership before the shared registry effect', async () => {
  let effects = 0;
  const registry = new HelmToolRegistry([{
    name: 'map.write', description: 'Mutate the Map.', input: { value: z.string() },
    async execute() { effects += 1; return { state: 'succeeded', value: 'unexpected' }; },
  }]);
  const bridge = await AstraLoopbackMcpTransport.open({ registry, guard: { async assertCurrent() { throw new Error('stale epoch'); } }, session });
  try {
    const { client, transport, CallToolResultSchema } = await clientFor(bridge);
    try {
      const response = await client.callTool({ name: 'map.write', arguments: { value: 'x' } }, CallToolResultSchema);
      assert.equal(response.isError, true);
      assert.deepEqual(response.structuredContent, { state: 'refused', reason: 'Helm session ownership is not current' });
      assert.equal(effects, 0);
    } finally { await transport.close(); }
  } finally { await bridge.close(); }
});

test('Astra loopback MCP refuses every consultant tool callback before guard or effect', async () => {
  let guards = 0; let effects = 0;
  const registry = new HelmToolRegistry([{
    name: 'brief.write', description: 'Mutate a Brief.', input: {},
    async execute() { effects += 1; return { state: 'succeeded', value: 'unexpected' }; },
  }]);
  const bridge = await AstraLoopbackMcpTransport.open({ registry, guard: { async assertCurrent() { guards += 1; } }, session: { ...session, mode: 'consultant' } });
  try {
    const { client, transport, CallToolResultSchema } = await clientFor(bridge);
    try {
      const response = await client.callTool({ name: 'brief.write', arguments: {} }, CallToolResultSchema);
      assert.equal(response.isError, true);
      assert.deepEqual(response.structuredContent, { state: 'refused', reason: 'Consultant sessions cannot issue Helm tool effects' });
      assert.equal(guards, 0); assert.equal(effects, 0);
    } finally { await transport.close(); }
  } finally { await bridge.close(); }
});

test('Astra loopback MCP reports unknown while a tool ignores shutdown, then records its late observed success', async () => {
  let release!: () => void; let entered!: () => void; let completed = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
  const registry = new HelmToolRegistry([{
    name: 'blocked.effect', description: 'A deliberately blocked local effect.', input: {},
    async execute() { entered(); await gate; completed += 1; return { state: 'succeeded', value: 'late-observed' }; },
  }]);
  const bridge = await AstraLoopbackMcpTransport.open({ registry, guard: { async assertCurrent() {} }, session });
  const { client, transport, CallToolResultSchema } = await clientFor(bridge);
  const pending = client.callTool({ name: 'blocked.effect', arguments: {} }, CallToolResultSchema).catch(() => undefined);
  await enteredGate;
  assert.deepEqual(await bridge.close({ drainDeadlineMs: 0 }), { observed: 'unknown' });
  release(); await pending;
  assert.equal(completed, 1, 'transport shutdown did not erase a late observed effect');
  assert.deepEqual(await bridge.close({ drainDeadlineMs: 50 }), { observed: 'stopped' });
  await transport.close().catch(() => undefined);
});

test('Astra loopback MCP rechecks closing after an awaited guard and never starts that effect', async () => {
  let release!: () => void; let entered!: () => void; let effects = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
  const registry = new HelmToolRegistry([{
    name: 'guarded.effect', description: 'Effect behind an asynchronous guard.', input: {},
    async execute() { effects += 1; return { state: 'succeeded', value: 'unexpected' }; },
  }]);
  const bridge = await AstraLoopbackMcpTransport.open({ registry, guard: { async assertCurrent() { entered(); await gate; } }, session });
  const { client, transport, CallToolResultSchema } = await clientFor(bridge);
  const pending = client.callTool({ name: 'guarded.effect', arguments: {} }, CallToolResultSchema).catch(() => undefined);
  await enteredGate;
  assert.deepEqual(await bridge.close({ drainDeadlineMs: 0 }), { observed: 'unknown' });
  release(); await pending;
  assert.equal(effects, 0);
  assert.deepEqual(await bridge.close({ drainDeadlineMs: 50 }), { observed: 'stopped' });
  await transport.close().catch(() => undefined);
});
