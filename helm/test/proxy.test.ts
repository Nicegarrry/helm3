import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { proxyRequest, serveStdioProxy } from '../src/proxy.js';

async function fixture(t: TestContext, pollMs = 60_000) {
  const home = mkdtempSync(join(tmpdir(), 'helm-proxy-'));
  let token = 'a'.repeat(64);
  let hash = 'one';
  let draining = false;
  let unauthorized = false;
  let calls = 0;
  let tools = [{ name: 'future', description: 'Daemon-only tool', inputSchema: { type: 'object', properties: {} } }];
  let received: unknown;
  const start = async () => {
    const http = createServer(async (req, res) => {
      assert.equal(req.headers['x-helm-shim'], '1');
      if (req.headers.authorization !== `Bearer ${token}` || unauthorized) {
        unauthorized = false;
        res.writeHead(401).end(); return;
      }
      res.setHeader('x-helm-tools-hash', hash);
      if (req.url?.startsWith('/mcp/tools')) { res.end(JSON.stringify({ tools })); return; }
      if (draining) {
        draining = false;
        res.end(JSON.stringify({ ok: false, reason: 'daemon is draining; retry after maintenance (no work was admitted)' })); return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      received = JSON.parse(body);
      calls++;
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    writeFileSync(join(home, 'serve.json'), JSON.stringify({ port, token }));
    return { http, port };
  };
  let daemon = await start();
  const initialPort = daemon.port;
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair();
  const proxy = await serveStdioProxy(initialPort, 'core', home, proxyTransport, pollMs);
  const client = new Client({ name: 'proxy-test', version: '1' });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await proxy.close(); await close(daemon.http); rmSync(home, { recursive: true, force: true }); });
  return { client, home, initialPort, received: () => received, calls: () => calls,
    draining: () => { draining = true; }, unauthorized: () => { unauthorized = true; },
    change: () => { hash = 'two'; tools = [...tools, { name: 'added', description: 'Added after initialize', inputSchema: { type: 'object', properties: {} } }]; },
    restart: async () => { await close(daemon.http); token = 'b'.repeat(64); daemon = await start(); },
    stop: async (keepMetadata = false) => { await close(daemon.http); if (!keepMetadata) rmSync(join(home, 'serve.json')); },
    start: async () => { token = 'c'.repeat(64); daemon = await start(); },
  };
}
function close(server: Server): Promise<void> { return new Promise((resolve) => server.close(() => resolve())); }

test('mid-session daemon restart rotates port and token without restarting proxy', async (t) => {
  const f = await fixture(t);
  await f.restart();
  const result = await f.client.callTool({ name: 'future', arguments: {} });
  assert.deepEqual(JSON.parse((result.content as Array<{ text: string }>)[0]!.text), { ok: true });
});

test('new optional daemon params pass through the proxy unchanged', async (t) => {
  const f = await fixture(t);
  const input = { project: 'repo', issue: 308, priority: 'urgent', newOptional: { nested: [1, null, false] } };
  await f.client.callTool({ name: 'future', arguments: input });
  assert.deepEqual(f.received(), input);
});

test('changed response hash emits list_changed and list includes a newly added tool', async (t) => {
  const f = await fixture(t);
  assert.equal(f.client.getServerCapabilities()?.tools?.listChanged, true);
  const notification = new Promise<void>((resolve) => f.client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
  f.change();
  await f.client.callTool({ name: 'future', arguments: {} });
  await notification;
  assert.deepEqual((await f.client.listTools()).tools.map((tool) => tool.name), ['future', 'added']);
});

test('idle polling emits list_changed without a client call', async (t) => {
  const f = await fixture(t, 20);
  const notification = new Promise<void>((resolve) => f.client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
  f.change();
  await notification;
  assert.equal((await f.client.listTools()).tools.length, 2);
});

test('connection gap, 401 and pre-admission drain retry without duplicate admissions', async (t) => {
  const f = await fixture(t);
  await f.stop(true);
  const next = f.client.callTool({ name: 'future', arguments: {} });
  await f.start();
  await next;
  f.unauthorized();
  await f.client.callTool({ name: 'future', arguments: {} });
  f.draining();
  await f.client.callTool({ name: 'future', arguments: {} });
  assert.equal(f.calls(), 3);
});

test('refusals stop at the retry deadline', async (t) => {
  const f = await fixture(t);
  await f.stop();
  const started = Date.now();
  const result = await proxyRequest(f.initialPort, '/tools/future', {}, 'core', f.home, undefined, 20);
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 500);
});
