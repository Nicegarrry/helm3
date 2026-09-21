import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { acquirePublisherLock, assertPrivateAccess, fetchState, listFleetRecord, mergeSnapshots, parseFleetArgs, parseServeJson, publishSnapshot, snapshotFromState, stateUrl, syncOnce, runPublisher } from '../bin/fleet.mjs';

const source = (id: string, home = `/tmp/${id}`) => ({ sourceId: id, label: id, home });
const state = (workers: unknown[] = [], observedAt = '2026-09-21T00:00:00.000Z') => ({ ok: true, observedAt, run: { spendUsd: 1.2, spendCapUsd: 5, activeWorkers: 1, maxWorkers: 3, unknownCostEvents: 2, daemon: { version: '1.6.0', revision: 'abc', phase: 'ready', secret: 'never' } }, workers, models: [{ model: 'codex/test', workers: 1, active: 1, spendUsd: 1.2, tokens: 4, raw: { secret: 'never' } }] });
const access = (mode: string) => ({ access: { mode, accessPolicyVersion: 1, allowedEmails: [], allowedDomains: [] }, paymentGate: null });

test('fleet CLI accepts --home as a source and reports unavailable without auth or network', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helm-fleet-cli-')); t.after(() => rm(home, { recursive: true, force: true }));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['bin/helm.js', 'fleet', 'sync', '--site', 'synthetic', '--home', home, '--once'], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: home }, timeout: 10000 });
  assert.match(`${stdout}${stderr}`, /sources unavailable/);
  assert.doesNotMatch(`${stdout}${stderr}`, /undefined.*replace/i);
});

test('source state is fail-closed, loopback-only, and preserves no fake empty fleet', async (t) => {
  assert.equal(stateUrl(4747), 'http://127.0.0.1:4747/api/state');
  for (const bad of ['{}', '{"port":0}', '{"port":65536}', 'not-json']) assert.throws(() => parseServeJson(bad));
  for (const bad of [{}, { ok: true, run: {}, workers: 'bad', models: [] }, { ok: true, run: {}, workers: [], models: [], observedAt: 'nope' }]) assert.throws(() => snapshotFromState(bad));
  const home = await mkdtemp(join(tmpdir(), 'helm-fleet-source-')); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'serve.json'), '{"port":4750}');
  await assert.rejects(() => fetchState(home, async () => new Response(JSON.stringify({}), { status: 200 })), /invalid/);
});

test('snapshot allowlists nested values, bounds escaped UTF-8 body, and prioritizes active workers', () => {
  const workers = Array.from({ length: 130 }, (_, index) => ({ workerId: `w-${index}\\\"😀`, state: index === 129 ? 'running' : 'idle', repoSlug: 'x'.repeat(600), model: 'm'.repeat(600), objective: 'TOP SECRET', toolArgs: { token: 'TOP SECRET' }, updatedAt: String(index) }));
  const projection = snapshotFromState(state(workers), { sourceId: 'one' });
  const snap = mergeSnapshots([{ source: source('one'), projection }], undefined, '2026-09-21T00:00:01.000Z') as any;
  assert.equal(snap.workers[0].workerId.startsWith('w-129'), true);
  assert.equal(snap.workers[0].sourceId, 'one');
  assert.doesNotMatch(JSON.stringify(snap), /TOP SECRET|objective|toolArgs/);
  assert.ok(Buffer.byteLength(JSON.stringify(snap), 'utf8') < 15000);
  assert.ok(Buffer.byteLength(JSON.stringify({ snapshot: JSON.stringify(snap) }), 'utf8') < 16384);
  assert.ok(snap.counts.truncatedWorkers > 0);
  assert.ok(snap.counts.truncatedFields > 0);
});

test('merge retains unavailable source safely and disambiguates matching worker ids', () => {
  const one = snapshotFromState(state([{ workerId: 'w-same', state: 'running' }]), { sourceId: 'one' });
  const two = snapshotFromState(state([{ workerId: 'w-same', state: 'idle' }]), { sourceId: 'two' });
  const both = mergeSnapshots([{ source: source('one'), projection: one }, { source: source('two'), projection: two }], undefined) as any;
  assert.deepEqual(both.workers.map((worker: any) => `${worker.sourceId}:${worker.workerId}`).sort(), ['one:w-same', 'two:w-same']);
  both.workers.find((worker: any) => worker.sourceId === 'two').secret = 'never retain arbitrary cloud data';
  const partial = mergeSnapshots([{ source: source('one'), projection: snapshotFromState(state([{ workerId: 'fresh', state: 'running' }]), { sourceId: 'one' }) }, { source: source('two'), error: 'offline' }], both) as any;
  assert.equal(partial.counts.sourcesComplete, false);
  assert.equal(partial.sources.find((item: any) => item.sourceId === 'two').status, 'unavailable');
  assert.ok(partial.workers.some((worker: any) => worker.sourceId === 'two' && worker.workerId === 'w-same'));
  assert.doesNotMatch(JSON.stringify(partial), /never retain arbitrary cloud data/);
});

test('here.now access uses the actual access object and refuses public or malformed policies', async () => {
  for (const mode of ['password', 'restricted', 'account_members']) {
    await assert.doesNotReject(() => assertPrivateAccess('private-fleet', 'owner', async () => new Response(JSON.stringify(access(mode)), { status: 200 })));
  }
  for (const policy of [access('anyone_with_link'), access('public'), { access: {} }, {}]) {
    await assert.rejects(() => assertPrivateAccess('private-fleet', 'owner', async () => new Response(JSON.stringify(policy), { status: 200 })), /refusing cloud write/);
  }
});

test('one-record publisher rejects pagination ambiguity and sends auth only to owner APIs', async () => {
  await assert.rejects(() => listFleetRecord('private-fleet', 'owner', async () => new Response(JSON.stringify({ records: [], nextCursor: 'later' }), { status: 200 })), /ambiguous/);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const request = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/data/fleet') && init?.method !== 'POST') return new Response(JSON.stringify({ records: [] }), { status: 200 });
    if (String(url).endsWith('/access')) return new Response(JSON.stringify(access('password')), { status: 200 });
    return new Response(JSON.stringify({ id: 'one' }), { status: 200 });
  };
  const result = await publishSnapshot({ slug: 'private-fleet', snapshot: mergeSnapshots([{ source: source('one'), projection: snapshotFromState(state(), { sourceId: 'one' }) }]), auth: 'owner', request });
  assert.deepEqual(result, { action: 'created', recordId: 'one' });
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, 'Bearer owner');
  assert.equal((calls[2]?.init?.headers as Record<string, string>)['idempotency-key']?.length, 64);
});

test('all unavailable sources skip owner API/auth and lock records diagnosable owner metadata', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helm-fleet-offline-')); t.after(() => rm(home, { recursive: true, force: true }));
  const result = await syncOnce({ sources: [source('one', home)], slug: 'private-fleet', request: async () => { throw new Error('network must not run without serve.json'); } });
  assert.equal(result.action, 'unavailable');
  const release = acquirePublisherLock(home, 'site', [source('one')]);
  const lock = await readFile(join(home, '.fleet-site.lock'), 'utf8');
  assert.match(lock, /"pid":\d+/); assert.match(lock, /"sources":\["one"\]/);
  assert.throws(() => acquirePublisherLock(home, 'site'), /lock exists/); release();
});

test('two-source sync publishes a partial merged record when one source is unavailable', async (t) => {
  const one = await mkdtemp(join(tmpdir(), 'helm-fleet-one-')); const two = await mkdtemp(join(tmpdir(), 'helm-fleet-two-'));
  t.after(() => Promise.all([rm(one, { recursive: true, force: true }), rm(two, { recursive: true, force: true })]));
  await Promise.all([writeFile(join(one, 'serve.json'), '{"port":4101}'), writeFile(join(two, 'serve.json'), '{"port":4102}')]);
  const calls: string[] = [];
  const request = async (url: RequestInfo | URL, init?: RequestInit) => {
    const value = String(url); calls.push(value);
    if (value.includes(':4101/')) return new Response(JSON.stringify(state([{ workerId: 'one-worker', state: 'running' }])), { status: 200 });
    if (value.includes(':4102/')) throw new TypeError('second source offline');
    if (value.endsWith('/data/fleet') && init?.method !== 'POST') return new Response(JSON.stringify({ records: [] }), { status: 200 });
    if (value.endsWith('/access')) return new Response(JSON.stringify(access('password')), { status: 200 });
    return new Response(JSON.stringify({ id: 'record' }), { status: 200 });
  };
  const result = await syncOnce({ sources: [source('one', one), source('two', two)], slug: 'private-fleet', auth: 'owner', request }) as any;
  assert.equal(result.action, 'created'); assert.equal(result.snapshot.counts.sourcesComplete, false);
  assert.deepEqual(result.snapshot.workers.map((worker: any) => worker.sourceId), ['one']);
  assert.equal(result.snapshot.sources.find((item: any) => item.sourceId === 'two').status, 'unavailable');
  assert.ok(calls.some((value) => value.includes(':4101/'))); assert.ok(calls.some((value) => value.includes(':4102/')));
});

test('CLI validation supports repeatable absolute sources and rejects unsafe intervals', () => {
  const parsed = parseFleetArgs(['--site', 'private-fleet', '--source', 'one=/tmp/a', '--source', 'two=/tmp/b', '--interval', '10000']);
  assert.deepEqual(parsed.sources.map((item: any) => item.sourceId), ['one', 'two']);
  for (const args of [['--site', 'x', '--interval', '9999'], ['--site', 'x', '--source', 'bad=relative'], ['--site', 'x', '--home', '/tmp/a', '--source', 'b=/tmp/b']]) assert.throws(() => parseFleetArgs(args));
});


test('aggregation retains spend, daemon identity, and cached omission counts', () => {
  const now = new Date().toISOString();
  const projection = snapshotFromState(state([{ workerId: 'w-old', state: 'running' }], now), { sourceId: 'one' });
  const initial = mergeSnapshots([{ source: source('one'), projection }]) as any;
  assert.equal(initial.run.spendUsd, 1.2);
  assert.equal(initial.sources[0].daemon.version, '1.6.0');
  assert.equal(initial.sources[0].daemon.secret, undefined);
  initial.sources[0].totalWorkers = 10;
  const partial = mergeSnapshots([{ source: source('one'), error: 'offline' }], initial) as any;
  assert.equal(partial.run.spendUsd, 1.2);
  assert.equal(partial.sources[0].observedAt, now);
  assert.equal(partial.sources[0].daemon.version, '1.6.0');
  assert.equal(partial.counts.truncatedWorkers, 9);
  assert.equal(partial.counts.sourcesComplete, false);
  const unlimited = state([], now); unlimited.run.spendCapUsd = 0;
  const mixed = mergeSnapshots([{ source: source('one'), projection }, { source: source('two'), projection: snapshotFromState(unlimited) }]) as any;
  assert.equal(mixed.run.spendCapUsd, 0, 'an unlimited source cannot imply a finite combined cap');
});

test('empty successful-looking state and malformed owner listing fail closed', async () => {
  assert.throws(() => snapshotFromState({ ok: true, observedAt: new Date().toISOString(), run: {}, workers: [], models: [] }), /invalid/);
  assert.throws(() => snapshotFromState(state([null])), /invalid/);
  await assert.rejects(() => listFleetRecord('private-fleet', 'owner', async () => new Response('{}')), /malformed/);
  assert.throws(() => parseFleetArgs(['--site','test','--source','same=/tmp/a','--source','same=/tmp/b']), /uniquely/);
  const defaults = parseFleetArgs(['--site','test']);
  assert.equal(defaults.sources.length, 1);
  assert.equal(defaults.sources[0]!.home, resolve(process.env.HELM_HOME || join(homedir(), '.helm')));
  assert.equal(defaults.sources[0]!.label, 'Default Helm');
});


test('continuous publisher survives an owner API failure and releases its lock on stop', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helm-fleet-retry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'serve.json'), '{"port":4101}');
  const messages: string[] = [];
  await runPublisher({ sources: [source('one', home)], slug: 'test', auth: 'synthetic',
    request: async (url) => String(url).startsWith('http://127.0.0.1:')
      ? new Response(JSON.stringify(state([], new Date().toISOString()))) : new Response('{}', {status:503}),
    report: (message) => { messages.push(message); process.emit('SIGTERM'); },
  });
  assert.match(messages.join(' '), /publish unavailable.*previous snapshot retained/);
  await assert.rejects(() => readFile(join(home, '.fleet-test.lock')), /ENOENT/);
});
