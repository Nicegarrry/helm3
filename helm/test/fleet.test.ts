import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquirePublisherLock, assertPrivateAccess, fetchState, ownerHeaders, parseFleetArgs, parseServeJson, publishSnapshot, retryPublish, snapshotFromState, stateUrl, syncOnce } from '../bin/fleet.mjs';

const state = (workers: unknown[] = []) => ({ ok: true, observedAt: '2026-09-21T00:00:00.000Z', run: { spendUsd: 1.2, spendCapUsd: 5, activeWorkers: 1, maxWorkers: 3, unknownCostEvents: 2, daemon: { version: '1.6.0', revision: 'abc', phase: 'ready', secret: 'never' } }, workers, models: [{ model: 'codex/test', workers: 1, active: 1, spendUsd: 1.2, tokens: 4, raw: { secret: 'never' } }] });

test('fleet snapshot allowlists nested data and prioritizes active workers', () => {
  const snap = snapshotFromState(state([
    { workerId: 'done', state: 'idle', repoSlug: 'a/r', objective: 'TOP SECRET', result: { token: 'TOP SECRET' }, updatedAt: '2026-01-01' },
    { workerId: 'live', state: 'running', repoSlug: 'a/r', model: 'm', updatedAt: '2025-01-01', toolArgs: { password: 'TOP SECRET' }, spendUsd: 1 },
  ])) as any;
  assert.deepEqual(snap.workers.map((worker: any) => worker.workerId), ['live', 'done']);
  assert.equal(snap.daemon.secret, undefined);
  assert.doesNotMatch(JSON.stringify(snap), /TOP SECRET|password|objective|toolArgs/);
  assert.equal(snap.counts.totalWorkers, 2);
});

test('fleet snapshot bounds UTF-8 content and reports worker truncation', () => {
  const workers = Array.from({ length: 150 }, (_, index) => ({ workerId: `w-${index}`, state: index === 149 ? 'running' : 'idle', repoSlug: 'x'.repeat(200), model: 'm'.repeat(100), updatedAt: String(index) }));
  const snap = snapshotFromState(state(workers)) as any;
  assert.ok(Buffer.byteLength(JSON.stringify(snap), 'utf8') < 15000);
  assert.ok(Buffer.byteLength(JSON.stringify({ snapshot: JSON.stringify(snap) }), 'utf8') < 16384);
  assert.equal(snap.workers[0].workerId, 'w-149');
  assert.ok(snap.counts.truncatedWorkers > 0);
});

test('fleet bounds the model rollup before active workers and discloses model truncation', () => {
  const models = Array.from({ length: 100 }, (_, index) => ({ model: `model-${index}-${'x'.repeat(250)}`, workers: 1, active: 0, spendUsd: 0, tokens: 0 }));
  const snap = snapshotFromState({ ...state([{ workerId: 'live', state: 'running' }]), models }) as any;
  assert.ok(Buffer.byteLength(JSON.stringify(snap), 'utf8') < 15000);
  assert.ok(Buffer.byteLength(JSON.stringify({ snapshot: JSON.stringify(snap) }), 'utf8') < 16384);
  assert.equal(snap.workers[0].workerId, 'live');
  assert.ok(snap.counts.truncatedModels > 0);
});

test('fleet snapshot tolerates older daemon response and empty fleet', () => {
  const snap = snapshotFromState({ ok: true, workers: [], run: { spendUsd: 0, activeWorkers: 0 }, models: [] }) as any;
  assert.equal(snap.daemon, undefined);
  assert.deepEqual(snap.workers, []);
  assert.equal(snap.counts.totalWorkers, 0);
});

test('fleet safe state URL and serve validation reject non-loopback ambiguity', async (t) => {
  assert.equal(stateUrl(4747), 'http://127.0.0.1:4747/api/state');
  for (const bad of ['{}', '{"port":0}', '{"port":65536}', 'not-json']) assert.throws(() => parseServeJson(bad));
  const home = await mkdtemp(join(tmpdir(), 'helm-fleet-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'serve.json'), '{"port":4750}');
  let url = '';
  const received = await fetchState(home, async (input) => { url = String(input); return new Response(JSON.stringify({ ok: true }), { status: 200 }); });
  assert.equal(url, stateUrl(4750)); assert.deepEqual(received, { ok: true });
});

test('fleet refuses public policy and uses authentication only for owner API routes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const request = async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ access: 'anyone_with_link' }), { status: 200 }); };
  await assert.rejects(() => assertPrivateAccess('private-fleet', 'owner-token', request), /refusing cloud write/);
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, 'Bearer owner-token');
  assert.deepEqual(ownerHeaders('owner-token'), { authorization: 'Bearer owner-token', accept: 'application/json' });
});

test('fleet maintains one record, verifies access before each write, and uses stable idempotency only on create', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const request = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/data/fleet')) return new Response(JSON.stringify({ records: [] }), { status: 200 });
    if (String(url).endsWith('/access')) return new Response(JSON.stringify({ access: 'password' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'new-record' }), { status: 200 });
  };
  await publishSnapshot({ slug: 'private-fleet', snapshot: snapshotFromState(state()), auth: 'owner-token', request });
  assert.equal(calls.length, 3); assert.ok(calls[1]?.url.endsWith('/access'));
  assert.equal((calls[2]?.init?.headers as Record<string, string>)['idempotency-key']?.length, 64);
  assert.ok(Buffer.byteLength(String(calls[2]?.init?.body), 'utf8') < 16384);
  const updateCalls: Array<{ url: string; init?: RequestInit }> = [];
  const updateRequest = async (url: RequestInfo | URL, init?: RequestInit) => { updateCalls.push({ url: String(url), init }); if (String(url).endsWith('/data/fleet')) return new Response(JSON.stringify({ records: [{ id: 'only', data: { snapshot: '{}' } }] }), { status: 200 }); if (String(url).endsWith('/access')) return new Response(JSON.stringify({ access: 'restricted' }), { status: 200 }); return new Response('{}', { status: 200 }); };
  const result = await publishSnapshot({ slug: 'private-fleet', snapshot: snapshotFromState(state()), auth: 'owner-token', request: updateRequest });
  assert.deepEqual(result, { action: 'updated', recordId: 'only' }); assert.equal(updateCalls[2]?.init?.method, 'PATCH'); assert.equal((updateCalls[2]?.init?.headers as Record<string, string>)['idempotency-key'], undefined);
});

test('fleet refuses ambiguity, has a per-home/site lock, and parses the read-only command', async (t) => {
  await assert.rejects(() => publishSnapshot({ slug: 'private-fleet', snapshot: {}, auth: 'x', request: async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('/data/fleet') ? { records: [{ id: 'a' }, { id: 'b' }] } : { access: 'password' }), { status: 200 }) }), /ambiguous/);
  const home = await mkdtemp(join(tmpdir(), 'helm-fleet-lock-')); t.after(() => rm(home, { recursive: true, force: true }));
  const release = acquirePublisherLock(home, 'site'); assert.throws(() => acquirePublisherLock(home, 'site'), /already running/); release(); acquirePublisherLock(home, 'site')();
  assert.deepEqual(parseFleetArgs(['--site', 'private-fleet', '--home', '/tmp/helm', '--interval', '30000', '--once']), { site: 'private-fleet', home: '/tmp/helm', interval: 30000, once: true });
});

test('fleet outbound retries are bounded with backoff', async () => {
  let attempts = 0; const waits: number[] = [];
  const value = await retryPublish(async () => { attempts++; if (attempts < 3) throw new TypeError('temporary'); return 'published'; }, async (delay) => { waits.push(delay); });
  assert.equal(value, 'published'); assert.equal(attempts, 3); assert.deepEqual(waits, [200, 600]);
  attempts = 0;
  await assert.rejects(() => retryPublish(async () => { attempts++; throw new Error('unsafe policy'); }, async () => {}), /unsafe policy/);
  assert.equal(attempts, 1, 'privacy/configuration failures are not retried');
});

test('fleet source failure retains cloud data by making no owner API call or daemon mutation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helm-fleet-offline-')); t.after(() => rm(home, { recursive: true, force: true }));
  const serve = '{"port":4750}'; await writeFile(join(home, 'serve.json'), serve);
  let calls = 0;
  await assert.rejects(() => syncOnce({ home, slug: 'private-fleet', auth: 'owner-token', request: async () => { calls++; throw new TypeError('offline'); } }), /offline/);
  assert.equal(calls, 1);
  assert.equal(await readFile(join(home, 'serve.json'), 'utf8'), serve);
});
