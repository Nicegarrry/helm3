import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { proxyRequest, serveStdioProxy } from '../src/proxy.js';

// A socket-free HTTP boundary also verifies the shim in restricted worker sandboxes.
test('stable shim uses live metadata, forwards future params, announces changes and bounds safe retries', { timeout: 5000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'helm-shim-unit-'));
  const metadata = (port: number, token: string) => writeFileSync(join(home, 'serve.json'), JSON.stringify({ port, token }));
  metadata(1234, 'a'.repeat(64));
  let hash = 'one';
  let refused = false;
  let unauthorized = false;
  let drain = false;
  let interrupted = false;
  let calls = 0;
  let admissions = 0;
  let input: unknown;
  let options: any;
  t.mock.method(http, 'request', (opts: any, callback: (res: any) => void) => {
    assert.equal(opts.agent, false, 'a restart call must not reuse an idle socket from the previous daemon');
    options = opts;
    const req = new EventEmitter() as any;
    req.destroy = (err: Error) => req.emit('error', err);
    req.end = (body: string) => queueMicrotask(() => {
      req.emit('socket', { connecting: false });
      calls++;
      if (refused) { refused = false; req.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })); return; }
      const res = new EventEmitter() as any;
      res.setEncoding = () => {};
      res.headers = { 'x-helm-tools-hash': hash };
      res.statusCode = unauthorized ? 401 : 200;
      const isList = opts.method === 'GET';
      const tools = [{ name: 'future', description: 'remote', inputSchema: { type: 'object' } }, ...(hash === 'two' ? [{ name: 'added', inputSchema: { type: 'object' } }] : [])];
      const value = unauthorized ? {} : drain ? { ok: false, reason: 'daemon is draining; retry after maintenance (no work was admitted)' } : isList ? { tools } : { ok: true };
      if (!isList && !unauthorized && !drain) { admissions++; input = JSON.parse(body); }
      unauthorized = false; drain = false;
      callback(res);
      if (interrupted) { interrupted = false; res.emit('error', new Error('interrupted')); return; }
      res.emit('data', JSON.stringify(value)); res.emit('end');
    });
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const proxy = await serveStdioProxy(1, 'core', home, st, 20);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(ct);
  t.after(async () => { await client.close(); await proxy.close(); });
  assert.equal(client.getServerCapabilities()?.tools?.listChanged, true);
  metadata(5678, 'b'.repeat(64));
  const args = { project: 'new', priority: 'urgent', futureOptional: [1, false] };
  await client.callTool({ name: 'future', arguments: args });
  assert.deepEqual(input, args);
  assert.equal(options.port, 5678);
  assert.equal(options.headers.authorization, `Bearer ${'b'.repeat(64)}`);
  assert.equal(options.headers['x-helm-shim'], '1');
  const changed = new Promise<void>((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
  hash = 'two';
  const keepAlive = setTimeout(() => {}, 4000);
  t.after(() => clearTimeout(keepAlive));
  await changed; // idle poll, no client request
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['future', 'added']);
  refused = true;
  await client.callTool({ name: 'future', arguments: {} });
  unauthorized = true;
  await client.callTool({ name: 'future', arguments: {} });
  drain = true;
  await client.callTool({ name: 'future', arguments: {} });
  assert.equal(admissions, 4);
  interrupted = true;
  const result = await proxyRequest(1, '/tools/future', {}, 'core', home);
  assert.match(result.reason, /outcome may be unknown/);
  assert.equal(admissions, 5); // no replay after an interrupted admitted call
  assert.ok(calls >= 8);
});
