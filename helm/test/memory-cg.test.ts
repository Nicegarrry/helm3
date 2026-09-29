import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../src/store.js';
import { createMemorySync } from '../src/memory-sync.js';

type Call = { name: string; arguments: Record<string, unknown> };
const settings = (enabled: boolean, url = 'http://127.0.0.1:9/mcp') => ({ memory: { cg: { enabled, url, keyEnv: 'CG_TEST_KEY' } } });
const textResult = (value: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function outbox(store: ReturnType<typeof openStore>, rows: Array<{ op: 'write' | 'log'; path: string; args: Record<string, unknown>; at?: string }>): void {
  store.sql.exec('CREATE TABLE memory_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, path TEXT NOT NULL, args TEXT NOT NULL, createdAt TEXT NOT NULL, syncedAt TEXT, error TEXT)');
  for (const row of rows) store.sql.prepare('INSERT INTO memory_outbox (op, path, args, createdAt) VALUES (?, ?, ?, ?)').run(row.op, row.path, JSON.stringify(row.args), row.at ?? new Date().toISOString());
}

function fakeClient(calls: Call[], response: (call: Call) => unknown) {
  return { client: { connect: async () => undefined, callTool: async (input: Call) => { calls.push(input); return response(input); }, close: async () => undefined } } as any;
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

test('connection failures redact the bearer key from events', async () => {
  const store = openStore(':memory:'); const secret = 'secret-key'; outbox(store, [{ op: 'log', path: 'team/lesson/one.md', args: { path: 'team/lesson/one.md', entry: 'rule' } }]);
  await createMemorySync({ store, settings: settings(true), env: { CG_TEST_KEY: secret }, clientFactory: () => { throw new Error(`request failed with ${secret}`); } })();
  assert.doesNotMatch(JSON.stringify(store.listAllEvents()), new RegExp(secret)); store.close();
});
