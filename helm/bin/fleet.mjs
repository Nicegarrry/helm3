/** Read-only mobile fleet snapshot publisher. It never opens SQLite or controls Helm. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const API_ORIGIN = 'https://here.now';
export const SNAPSHOT_MAX_BYTES = 15000;
export const DEFAULT_INTERVAL_MS = 30000;
export const REQUEST_TIMEOUT_MS = 5000;
const ACTIVE = new Set(['queued', 'running']);
const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value));
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => scalar(value?.[key])).map((key) => [key, value[key]]));
const textBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const bodyBytes = (value) => Buffer.byteLength(JSON.stringify({ snapshot: JSON.stringify(value) }), 'utf8');
const fits = (value) => textBytes(value) < SNAPSHOT_MAX_BYTES && bodyBytes(value) < 16384;

/** Strictly project the daemon's public /api/state response into an intentionally small cloud record. */
export function snapshotFromState(state, now = new Date().toISOString()) {
  if (!state || typeof state !== 'object' || state.ok === false) throw new Error('daemon returned an invalid /api/state response');
  const sourceWorkers = Array.isArray(state.workers) ? state.workers : [];
  const sorted = sourceWorkers.slice().sort((a, b) => {
    const active = Number(ACTIVE.has(b?.state)) - Number(ACTIVE.has(a?.state));
    return active || String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? ''));
  });
  const worker = (value) => pick(value, ['workerId', 'repoSlug', 'state', 'role', 'model', 'createdAt', 'updatedAt', 'elapsedMs', 'spendUsd', 'tokens', 'unknownCostEvents', 'head']);
  const model = (value) => pick(value, ['model', 'workers', 'active', 'spendUsd', 'tokens', 'unknownCostEvents']);
  const run = pick(state.run, ['spendUsd', 'spendCapUsd', 'spendWarnUsd', 'aboveSoftCap', 'activeWorkers', 'maxWorkers', 'unknownCostEvents']);
  const daemon = pick(state.run?.daemon ?? state.daemon, ['version', 'revision', 'phase']);
  const snap = {
    schemaVersion: 1,
    observedAt: typeof state.observedAt === 'string' ? state.observedAt : now,
    run,
    ...(Object.keys(daemon).length ? { daemon } : {}),
    counts: { totalWorkers: sourceWorkers.length, activeWorkers: sorted.filter((item) => ACTIVE.has(item?.state)).length, publishedWorkers: 0, truncatedWorkers: 0, totalModels: 0, publishedModels: 0, truncatedModels: 0 },
    workers: [],
    models: [],
  };
  const sourceModels = Array.isArray(state.models) ? state.models : [];
  snap.counts.totalModels = sourceModels.length;
  for (const value of sorted) {
    const candidate = worker(value);
    snap.workers.push(candidate);
    if (!fits(snap)) { snap.workers.pop(); break; }
  }
  snap.counts.publishedWorkers = snap.workers.length;
  snap.counts.truncatedWorkers = sourceWorkers.length - snap.workers.length;
  // Preserve a valid useful core even for unusually long scalar values from a daemon.
  while (!fits(snap) && snap.workers.length) {
    snap.workers.pop();
    snap.counts.publishedWorkers = snap.workers.length;
    snap.counts.truncatedWorkers = sourceWorkers.length - snap.workers.length;
  }
  // Active workers take priority over historical model rollups when the cloud record is tight.
  for (const value of sourceModels) {
    snap.models.push(model(value));
    snap.counts.publishedModels = snap.models.length;
    snap.counts.truncatedModels = sourceModels.length - snap.models.length;
    if (!fits(snap)) { snap.models.pop(); break; }
  }
  snap.counts.publishedModels = snap.models.length;
  snap.counts.truncatedModels = sourceModels.length - snap.models.length;
  if (!fits(snap)) throw new Error('safe fleet summary exceeds the Site Data size limit');
  return snap;
}

export function parseServeJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('serve.json is not valid JSON'); }
  if (!Number.isInteger(value?.port) || value.port < 1 || value.port > 65535) throw new Error('serve.json has an invalid loopback port');
  return value.port;
}

export function stateUrl(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid loopback port');
  return `http://127.0.0.1:${port}/api/state`;
}

export async function fetchState(home, request = fetch) {
  const servePath = join(home, 'serve.json');
  if (!existsSync(servePath)) throw new Error('Helm daemon is not advertising serve.json; retained snapshot will become stale');
  const port = parseServeJson(readFileSync(servePath, 'utf8'));
  const response = await request(stateUrl(port), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Helm /api/state returned HTTP ${response.status}`);
  return response.json();
}

export function ownerHeaders(auth) {
  if (!auth || typeof auth !== 'string') throw new Error('Here.now owner authentication is unavailable');
  return { authorization: `Bearer ${auth}`, accept: 'application/json' };
}

export function readLocalAuth(env = process.env) {
  if (env.HERENOW_API_KEY) return env.HERENOW_API_KEY;
  const path = join(env.HOME || homedir(), '.herenow', 'credentials');
  if (!existsSync(path)) throw new Error('Here.now credentials are unavailable');
  const text = readFileSync(path, 'utf8').trim();
  try {
    const parsed = JSON.parse(text);
    const value = parsed.apiKey ?? parsed.token ?? parsed.accessToken;
    if (typeof value === 'string' && value) return value;
  } catch { /* plaintext credentials are also supported by here.now's local helper. */ }
  if (text) return text;
  throw new Error('Here.now credentials are unavailable');
}

async function json(request, url, options) {
  const response = await request(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    const error = new Error(`Here.now returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  try { return await response.json(); } catch { throw new Error('Here.now returned invalid JSON'); }
}

export async function assertPrivateAccess(slug, auth, request = fetch) {
  const policy = await json(request, `${API_ORIGIN}/api/v1/publish/${encodeURIComponent(slug)}/access`, { headers: ownerHeaders(auth) });
  const mode = policy.access ?? policy.mode ?? policy.visibility;
  if (!['password', 'restricted', 'account_members'].includes(mode)) throw new Error('refusing cloud write: site access must be password, restricted, or account_members');
  return policy;
}

/** Update exactly one record. Access is checked immediately before the mutating request. */
export async function publishSnapshot({ slug, snapshot, auth = readLocalAuth(), request = fetch }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug)) throw new Error('invalid site slug');
  const headers = ownerHeaders(auth);
  const base = `${API_ORIGIN}/api/v1/publishes/${encodeURIComponent(slug)}/data/fleet`;
  const listed = await json(request, base, { headers });
  const records = Array.isArray(listed.records) ? listed.records : [];
  if (records.length > 1) throw new Error('refusing ambiguous Site Data: more than one fleet record exists');
  if (records.length === 1 && typeof records[0]?.data?.snapshot !== 'string') throw new Error('fleet record has no snapshot string');
  const body = JSON.stringify({ snapshot: JSON.stringify(snapshot) });
  if (Buffer.byteLength(body, 'utf8') >= 16384) throw new Error('fleet Site Data body exceeds 16KB');
  await assertPrivateAccess(slug, auth, request);
  if (records.length === 1) {
    const id = records[0]?.id;
    if (typeof id !== 'string' || !id) throw new Error('fleet record has no id');
    await json(request, `${base}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body });
    return { action: 'updated', recordId: id };
  }
  const idempotencyKey = createHash('sha256').update(`helm-fleet-v1:${slug}`).digest('hex');
  const created = await json(request, base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body });
  return { action: 'created', recordId: created.id ?? created.record?.id ?? null };
}

/** A small bounded retry for transient outbound failures; it never retries source reads or daemon mutations. */
export async function retryPublish(operation, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let failure;
  for (const delay of [0, 200, 600]) {
    if (delay) await sleep(delay);
    try { return await operation(); } catch (error) {
      failure = error;
      const status = error && typeof error === 'object' ? error.status : undefined;
      if (!(error instanceof TypeError || error?.name === 'AbortError' || status === 429 || (typeof status === 'number' && status >= 500))) break;
    }
  }
  throw failure;
}

export function acquirePublisherLock(home, slug) {
  mkdirSync(home, { recursive: true });
  const path = join(home, `.fleet-${slug.replace(/[^a-z0-9_-]/gi, '_')}.lock`);
  let fd;
  try { fd = openSync(path, 'wx'); } catch { throw new Error('fleet publisher is already running for this home and site'); }
  return () => { try { closeSync(fd); } finally { rmSync(path, { force: true }); } };
}

export async function syncOnce({ home, slug, auth, request }) {
  const state = await fetchState(home, request);
  const snapshot = snapshotFromState(state);
  return { ...await retryPublish(() => publishSnapshot({ slug, snapshot, auth, request })), snapshot };
}

export async function runPublisher({ home, slug, interval = DEFAULT_INTERVAL_MS, once = false, auth, request = fetch, report = console.log }) {
  if (!Number.isFinite(interval) || interval < 1000) throw new Error('--interval must be at least 1000ms');
  const release = acquirePublisherLock(home, slug);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    do {
      try {
        const result = await syncOnce({ home, slug, auth, request });
        report(`fleet ${result.action}: ${result.snapshot.counts.publishedWorkers}/${result.snapshot.counts.totalWorkers} workers`);
      } catch (error) {
        report(`fleet source/publish unavailable: ${error instanceof Error ? error.message : 'unknown error'}; retained snapshot is unchanged`);
        if (once) throw error;
      }
      if (!once && !stopping) await new Promise((resolve) => setTimeout(resolve, interval));
    } while (!once && !stopping);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); release();
  }
}

export function parseFleetArgs(args) {
  let site; let home = process.env.HELM_HOME || join(homedir(), '.helm'); let interval = DEFAULT_INTERVAL_MS; let once = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--site') site = args[++i];
    else if (arg === '--home') home = args[++i];
    else if (arg === '--interval') interval = Number(args[++i]);
    else if (arg === '--once') once = true;
    else throw new Error(`unknown fleet option: ${arg}`);
  }
  if (!site) throw new Error('usage: helm fleet sync --site <slug> [--home <HELM_HOME>] [--interval <ms>] [--once]');
  return { site, home, interval, once };
}

async function main(args) {
  if (args[0] !== 'sync') throw new Error('usage: helm fleet sync --site <slug> [--home <HELM_HOME>] [--interval <ms>] [--once]');
  await runPublisher(parseFleetArgs(args.slice(1)));
}

if (process.argv[1] && process.argv[1].endsWith('/fleet.mjs')) main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
