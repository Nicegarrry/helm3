import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { openStore } from '../src/store.js';
import { createMemorySync as createMemorySyncImpl } from '../src/memory-sync.js';
import { z } from 'zod';

type Call = { name: string; arguments: Record<string, unknown> };
const TEST_ENV_FILE = '/definitely-missing/helm-memory-test-env';
const createMemorySync = (options: Parameters<typeof createMemorySyncImpl>[0]) => createMemorySyncImpl({ ...options, envFile: TEST_ENV_FILE });
const settings = (enabled: boolean, url = 'http://127.0.0.1:9/mcp') => ({ memory: { cg: { enabled, url, keyEnv: 'CG_TEST_KEY' } } });
const textResult = (value: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const renderedLog = (input: Record<string, unknown>) => {
  const lines = String(input.entry ?? '').split(/\r\n?|\n/); return [`- ${String(input.date ?? '')}: ${lines[0]}`, ...lines.slice(1).map((line) => `  ${line}`)].join('\n');
};

function outbox(store: ReturnType<typeof openStore>, rows: Array<{ op: 'write' | 'log'; path: string; args: Record<string, unknown>; at?: string }>): void {
  store.sql.exec('CREATE TABLE IF NOT EXISTS memory_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, path TEXT NOT NULL, args TEXT NOT NULL, createdAt TEXT NOT NULL, syncedAt TEXT, error TEXT)');
  for (const row of rows) store.sql.prepare('INSERT INTO memory_outbox (op, path, args, createdAt) VALUES (?, ?, ?, ?)').run(row.op, row.path, JSON.stringify(row.args), row.at ?? new Date().toISOString());
}

function fakeClient(calls: Call[], response: (call: Call) => unknown) {
  return { client: { connect: async () => undefined, callTool: async (input: Call) => { calls.push(input); return response(input); }, close: async () => undefined } } as any;
}

type FakeCg = { url: string; calls: Call[]; auth: string[]; errors: string[]; close(): Promise<void> };

async function startFakeCg(t: TestContext): Promise<FakeCg | undefined> {
  const fake: Omit<FakeCg, 'url' | 'close'> = { calls: [], auth: [], errors: [] };
  const markdownByPath = new Map<string, string>();
  const server = createServer(async (req, res) => {
    fake.auth.push(String(req.headers.authorization ?? ''));
    const mcp = new McpServer({ name: 'fake-common-ground', version: '1' });
    const schema = z.object({}).passthrough();
    for (const name of ['cg_write', 'cg_read', 'cg_log']) mcp.registerTool(name, { description: name, inputSchema: schema }, async (args) => {
      const input = (args ?? {}) as Record<string, unknown>; fake.calls.push({ name, arguments: input });
      const path = String(input.path ?? '');
      if (name === 'cg_read') return { content: [{ type: 'text', text: JSON.stringify({ markdown: markdownByPath.get(path) ?? '---\ntype: "lesson"\n---\ntruth\n---\n', sha: 'server-sha' }) }] };
      if (name === 'cg_write' && path.includes('scorecard') && !input.expectedSha) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'conflict' }) }] };
      if (name === 'cg_write' && path.includes('conflict')) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'conflict' }) }] };
      if (name === 'cg_write' && path.includes('duplicate')) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'near_duplicate' }) }] };
      if (name === 'cg_log') markdownByPath.set(path, `${markdownByPath.get(path) ?? '---\ntype: "lesson"\n---\ntruth\n---\n'}${markdownByPath.has(path) ? '\n' : ''}${renderedLog(input)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(req, res); }
    catch (error) { fake.errors.push(error instanceof Error ? error.message : String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('sandbox forbids localhost listeners'); return undefined; }
    throw error;
  }
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { ...fake, url: `http://127.0.0.1:${address.port}/mcp`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test('CG sync replays ordered rows, uses cg_log for lessons, and is idempotent', async () => {
  const store = openStore(':memory:'); const calls: Call[] = [];
  outbox(store, [
    { op: 'write', path: 'projects/repo/scorecard/one.md', args: { path: 'projects/repo/scorecard/one.md', type: 'scorecard' }, at: '2026-01-01' },
    { op: 'log', path: 'projects/repo/lesson/one.md', args: { path: 'projects/repo/lesson/one.md', entry: 'rule', date: '2026-01-01' }, at: '2026-01-02' },
  ]);
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, clientFactory: () => fakeClient(calls, () => textResult({ ok: true })) });
  await tick(); await tick();
  assert.deepEqual(calls.map((call) => call.name), ['cg_write', 'cg_log']);
  assert.equal((store.sql.prepare('SELECT COUNT(*) AS n FROM memory_outbox WHERE syncedAt IS NULL').get() as { n: number }).n, 0);
  store.close();
});

test('an inflight log is reconciled from cg_read after a crash', async () => {
  const store = openStore(':memory:'); const calls: Call[] = []; let first = true; let now = 0;
  outbox(store, [{ op: 'log', path: 'team/lesson/one.md', args: { path: 'team/lesson/one.md', entry: 'rule', date: '2026-01-01' } }]);
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, now: () => new Date(now), clientFactory: () => fakeClient(calls, (call) => {
    if (call.name === 'cg_log' && first) { first = false; throw new Error('crashed after cg_log was applied'); }
    return call.name === 'cg_read' ? textResult({ markdown: '---\ntype: "lesson"\n---\ntruth\n---\n- 2026-01-01: rule' }) : textResult({ ok: true });
  }) });
  await tick(); now = 1_000; await tick();
  assert.deepEqual(calls.map((call) => call.name), ['cg_log', 'cg_read']);
  const row = store.sql.prepare('SELECT syncedAt, error FROM memory_outbox').get() as { syncedAt: string | null; error: string | null };
  assert.ok(row.syncedAt); assert.equal(row.error, null); store.close();
});

test('an inflight log with only a substring present is sent again', async () => {
  const store = openStore(':memory:'); const calls: Call[] = [];
  outbox(store, [{ op: 'log', path: 'team/lesson/one.md', args: { path: 'team/lesson/one.md', entry: 'rule', date: '2026-01-01' } }]);
  store.sql.prepare("UPDATE memory_outbox SET error = 'inflight'").run();
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, clientFactory: () => fakeClient(calls, (call) => call.name === 'cg_read' ? textResult({ markdown: '---\ntype: "lesson"\n---\ntruth\n---\n- 2026-01-01: rules' }) : textResult({ ok: true })) });
  await tick();
  assert.deepEqual(calls.map((call) => call.name), ['cg_read', 'cg_log']); store.close();
});

test('a failed inflight dedupe read keeps the marker for the next tick', async () => {
  const store = openStore(':memory:'); const calls: Call[] = []; let now = 0; let failed = true;
  outbox(store, [{ op: 'log', path: 'team/lesson/one.md', args: { path: 'team/lesson/one.md', entry: 'rule', date: '2026-01-01' } }]);
  store.sql.prepare("UPDATE memory_outbox SET error = 'inflight'").run();
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, now: () => new Date(now), clientFactory: () => fakeClient(calls, (call) => {
    if (call.name === 'cg_read' && failed) { failed = false; return textResult({ ok: false, error: 'read failed' }); }
    return textResult({ markdown: '---\ntype: "lesson"\n---\ntruth\n---\n- 2026-01-01: rule' });
  }) });
  await tick();
  assert.deepEqual(calls.map((call) => call.name), ['cg_read']);
  assert.equal((store.sql.prepare('SELECT syncedAt, error FROM memory_outbox').get() as { syncedAt: string | null; error: string | null }).error, 'inflight');
  now = 1_000; await tick();
  assert.deepEqual(calls.map((call) => call.name), ['cg_read', 'cg_read']);
  assert.ok((store.sql.prepare('SELECT syncedAt FROM memory_outbox').get() as { syncedAt: string | null }).syncedAt); store.close();
});

test('a log after a conflicted write is parked as blocked', async () => {
  const store = openStore(':memory:'); const calls: Call[] = [];
  outbox(store, [
    { op: 'write', path: 'projects/repo/page/one.md', args: { path: 'projects/repo/page/one.md', type: 'page' }, at: '2026-01-01' },
    { op: 'log', path: 'projects/repo/page/one.md', args: { path: 'projects/repo/page/one.md', entry: 'later' }, at: '2026-01-02' },
    { op: 'log', path: 'projects/repo/page/one.md', args: { path: 'projects/repo/page/one.md', entry: 'still later' }, at: '2026-01-03' },
  ]);
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, clientFactory: () => fakeClient(calls, () => textResult({ ok: false, error: 'conflict' })) });
  await tick();
  const rows = store.sql.prepare('SELECT error, syncedAt FROM memory_outbox ORDER BY id').all() as Array<{ error: string; syncedAt: string | null }>;
  assert.deepEqual(calls.map((call) => call.name), ['cg_write']); assert.equal(rows[0]?.error, 'conflict'); assert.equal(rows[1]?.error, 'blocked'); assert.equal(rows[2]?.error, 'blocked');
  assert.ok(rows[1]?.syncedAt); assert.ok(rows[2]?.syncedAt); assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.conflict').length, 1); assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.blocked').length, 2); store.close();
});

test('scorecard conflict reads the sha and retries once with expectedSha', async () => {
  const store = openStore(':memory:'); const calls: Call[] = [];
  outbox(store, [{ op: 'write', path: 'projects/repo/scorecard/one.md', args: { path: 'projects/repo/scorecard/one.md', type: 'scorecard' } }]);
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, clientFactory: () => fakeClient(calls, (call) => call.name === 'cg_write' && calls.length === 1 ? textResult({ ok: false, error: 'conflict' }) : call.name === 'cg_read' ? textResult({ sha: 'sha-2' }) : textResult({ ok: true })) });
  await tick();
  assert.deepEqual(calls.map((call) => call.name), ['cg_write', 'cg_read', 'cg_write']);
  assert.equal(calls[2]!.arguments.expectedSha, 'sha-2');
  assert.equal((store.sql.prepare('SELECT syncedAt FROM memory_outbox').get() as { syncedAt: string | null }).syncedAt !== null, true);
  store.close();
});

test('missing scorecard sha parks the row and emits a conflict event', async () => {
  const store = openStore(':memory:'); const calls: Call[] = [];
  outbox(store, [{ op: 'write', path: 'projects/repo/scorecard/one.md', args: { path: 'projects/repo/scorecard/one.md', type: 'scorecard' } }]);
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, clientFactory: () => fakeClient(calls, (call) => call.name === 'cg_read' ? textResult({}) : textResult({ ok: false, error: 'conflict' })) });
  await tick();
  assert.deepEqual(calls.map((call) => call.name), ['cg_write', 'cg_read']);
  assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.conflict').length, 1); store.close();
});

test('a close error after a successful batch does not back off or emit an error', async () => {
  const store = openStore(':memory:'); const calls: Call[] = []; let closeCount = 0;
  outbox(store, [{ op: 'log', path: 'team/lesson/one.md', args: { path: 'team/lesson/one.md', entry: 'one' } }]);
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, clientFactory: () => ({ client: { connect: async () => undefined, callTool: async (input: Call) => { calls.push(input); return textResult({ ok: true }); }, close: async () => { closeCount += 1; throw new Error('close failed'); } } } as any) });
  await tick();
  outbox(store, [{ op: 'log', path: 'team/lesson/two.md', args: { path: 'team/lesson/two.md', entry: 'two' } }]);
  await tick();
  assert.equal(closeCount, 2); assert.deepEqual(calls.map((call) => call.name), ['cg_log', 'cg_log']);
  assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.cg.error').length, 0); store.close();
});

test('non-owned conflicts are parked once and rows after them still replay', async () => {
  const store = openStore(':memory:'); const calls: Call[] = [];
  outbox(store, [
    { op: 'write', path: 'projects/repo/page/conflict.md', args: { path: 'projects/repo/page/conflict.md', type: 'page' }, at: '2026-01-01' },
    { op: 'log', path: 'projects/repo/lesson/after.md', args: { path: 'projects/repo/lesson/after.md', entry: 'later' }, at: '2026-01-02' },
  ]);
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, clientFactory: () => fakeClient(calls, (call) => call.name === 'cg_write' ? textResult({ ok: false, error: 'conflict' }) : textResult({ ok: true })) });
  await tick(); await tick();
  const conflict = store.sql.prepare("SELECT syncedAt, error FROM memory_outbox WHERE error = 'conflict'").get() as { syncedAt: string | null; error: string };
  assert.ok(conflict.syncedAt); assert.equal(conflict.error, 'conflict'); assert.deepEqual(calls.map((call) => call.name), ['cg_write', 'cg_log']);
  assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.conflict').length, 1); store.close();
});

test('duplicate is terminal and emits no secret', async () => {
  const store = openStore(':memory:'); const secret = 'secret-key';
  outbox(store, [{ op: 'write', path: 'team/lesson/one.md', args: { path: 'team/lesson/one.md', type: 'lesson' } }]);
  const tick = createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: secret }, clientFactory: () => fakeClient([], () => textResult({ ok: false, error: 'near_duplicate' })) });
  await tick();
  const row = store.sql.prepare('SELECT syncedAt, error FROM memory_outbox').get() as { syncedAt: string | null; error: string | null };
  assert.ok(row.syncedAt); assert.equal(row.error, 'duplicate');
  const events = store.listAllEvents(); assert.equal(events[0]?.kind, 'memory.duplicate'); assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  store.close();
});

test('a successful result mentioning duplicates is not a duplicate refusal', async () => {
  const store = openStore(':memory:'); outbox(store, [{ op: 'write', path: 'team/lesson/one.md', args: { path: 'team/lesson/one.md', type: 'lesson' } }]);
  await createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: 'secret-key' }, clientFactory: () => fakeClient([], () => textResult({ ok: true, message: 'no duplicate found' })) })();
  const row = store.sql.prepare('SELECT syncedAt, error FROM memory_outbox').get() as { syncedAt: string | null; error: string | null };
  assert.ok(row.syncedAt); assert.equal(row.error, null); assert.equal(store.listAllEvents().length, 0); store.close();
});

test('missing key and disabled sync do not create a client or touch the network', async () => {
  const store = openStore(':memory:'); outbox(store, []); let made = 0;
  await createMemorySync({ store, settings: settings(false), env: {}, clientFactory: () => { made += 1; return fakeClient([], () => textResult({ ok: true })); } })();
  assert.equal(made, 0); assert.equal(store.listAllEvents().length, 0);
  await createMemorySync({ store, settings: settings(true), env: {}, clientFactory: () => { made += 1; return fakeClient([], () => textResult({ ok: true })); } })();
  assert.equal(made, 0); assert.equal(store.listAllEvents()[0]?.kind, 'memory.cg.missing_key');
  store.close();
});

test('memory sync uses the injected env file when HOME is unavailable', async () => {
  const store = openStore(':memory:');
  let made = 0;
  try {
    await createMemorySyncImpl({ store, settings: settings(true), env: {}, envFile: TEST_ENV_FILE, clientFactory: () => { made += 1; return fakeClient([], () => textResult({ ok: true })); } })();
    assert.equal(made, 0);
    assert.equal(store.listAllEvents()[0]?.kind, 'memory.cg.missing_key');
  } finally { store.close(); }
});

test('missing keys and connect failures are stateful and back off', async () => {
  const store = openStore(':memory:'); outbox(store, []); let now = 0; let made = 0; let fail = true;
  const tick = createMemorySync({ store, settings: settings(true), env: {}, now: () => new Date(now), clientFactory: () => { made += 1; throw new Error('transport failed secret-key'); } });
  await tick(); await tick(); assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.cg.missing_key').length, 1);
  const env = { CG_TEST_KEY: 'secret-key' }; const reconnect = createMemorySync({ store, settings: settings(true), env, now: () => new Date(now), clientFactory: () => { made += 1; if (fail) throw new Error('transport failed secret-key'); return fakeClient([], () => textResult({ ok: true })); } });
  outbox(store, [{ op: 'log', path: 'team/lesson/retry.md', args: { path: 'team/lesson/retry.md', entry: 'retry' } }]);
  await reconnect(); await reconnect(); assert.equal(made, 1); assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.cg.error').length, 1);
  let failureAt = 0;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const delay = Math.min(300_000, 1_000 * (2 ** (attempt - 1))); const retryAt = failureAt + delay;
    now = retryAt - 1; await reconnect(); assert.equal(made, attempt); now = retryAt; await reconnect(); assert.equal(made, attempt + 1); failureAt = retryAt;
  }
  const cappedRetry = failureAt + 300_000; now = cappedRetry - 1; await reconnect(); assert.equal(made, 11); now = cappedRetry; await reconnect(); assert.equal(made, 12);
  fail = false; now += 300_000; await reconnect(); assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.cg.error').length, 1);
  fail = true; outbox(store, [{ op: 'log', path: 'team/lesson/recovered.md', args: { path: 'team/lesson/recovered.md', entry: 'again' } }]); await reconnect();
  assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.cg.error').length, 2); assert.doesNotMatch(JSON.stringify(store.listAllEvents()), /secret-key/); store.close();
});

test('connection failures redact the bearer key from events', async () => {
  const store = openStore(':memory:'); const secret = 'secret-key'; outbox(store, [{ op: 'log', path: 'team/lesson/one.md', args: { path: 'team/lesson/one.md', entry: 'rule' } }]);
  await createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: secret }, clientFactory: () => { throw new Error(`request failed with ${secret}`); } })();
  assert.doesNotMatch(JSON.stringify(store.listAllEvents()), new RegExp(secret)); store.close();
});

test('real MCP Streamable HTTP server covers the CG acceptance contract', async (t) => {
  const fake = await startFakeCg(t); if (!fake) return;
  const store = openStore(':memory:');
  outbox(store, [
    { op: 'write', path: 'projects/repo/page/one.md', args: { path: 'projects/repo/page/one.md', type: 'page' }, at: '2026-01-01' },
    { op: 'write', path: 'projects/repo/scorecard/card.md', args: { path: 'projects/repo/scorecard/card.md', type: 'scorecard' }, at: '2026-01-02' },
    { op: 'log', path: 'projects/repo/lesson/one.md', args: { path: 'projects/repo/lesson/one.md', entry: 'lesson' }, at: '2026-01-03' },
    { op: 'write', path: 'projects/repo/page/conflict.md', args: { path: 'projects/repo/page/conflict.md', type: 'page' }, at: '2026-01-04' },
    { op: 'write', path: 'projects/repo/page/duplicate.md', args: { path: 'projects/repo/page/duplicate.md', type: 'page' }, at: '2026-01-05' },
    { op: 'log', path: 'projects/repo/lesson/after.md', args: { path: 'projects/repo/lesson/after.md', entry: 'after conflict' }, at: '2026-01-06' },
  ]);
  try {
    let clientClosed = 0;
    const tick = createMemorySync({ store, settings: settings(true, fake.url), env: { CG_TEST_KEY: 'real-secret' }, clientFactory: (url, key) => {
      const client = new Client({ name: 'helm-cg-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
      return { client, transport, close: async () => { clientClosed += 1; await client.close(); } };
    } });
    await tick();
    assert.deepEqual(fake.calls.map((call) => call.name), ['cg_write', 'cg_write', 'cg_read', 'cg_write', 'cg_log', 'cg_write', 'cg_write', 'cg_log']);
    assert.equal(fake.calls[3]!.arguments.expectedSha, 'server-sha'); assert.ok(fake.auth.every((value) => value === 'Bearer real-secret'));
    assert.equal((store.sql.prepare('SELECT COUNT(*) AS n FROM memory_outbox WHERE syncedAt IS NULL').get() as { n: number }).n, 0);
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.conflict').length, 1);
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'memory.duplicate').length, 1);
    const firstClosed = clientClosed; assert.equal(firstClosed, 1);
    store.sql.prepare('INSERT INTO memory_outbox (op, path, args, createdAt) VALUES (?, ?, ?, ?)').run('log', 'projects/repo/lesson/second-tick.md', JSON.stringify({ path: 'projects/repo/lesson/second-tick.md', entry: 'second tick' }), '2026-01-07');
    await tick(); assert.equal(fake.calls.at(-1)?.name, 'cg_log'); assert.equal(clientClosed, 2);
    const before = fake.calls.length; await tick(); assert.equal(fake.calls.length, before);
    const disabled = openStore(':memory:'); outbox(disabled, [{ op: 'log', path: 'team/lesson/no.md', args: { path: 'team/lesson/no.md', entry: 'off' } }]);
    await createMemorySync({ store: disabled, settings: settings(false, fake.url), env: { CG_TEST_KEY: 'real-secret' } })();
    assert.equal(fake.calls.length, before); disabled.close();
    assert.doesNotMatch(JSON.stringify({ events: store.listAllEvents(), errors: fake.errors }), /real-secret/);
  } finally { await fake.close(); store.close(); }
});
