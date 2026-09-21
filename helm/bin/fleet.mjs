/** Read-only mobile fleet snapshot publisher. It never opens SQLite or controls Helm. */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const API_ORIGIN = 'https://here.now';
export const SNAPSHOT_MAX_BYTES = 15000;
export const SITE_DATA_MAX_BYTES = 16384;
export const DEFAULT_INTERVAL_MS = 30000;
export const REQUEST_TIMEOUT_MS = 5000;
export const STALE_MS = 90000;

const ACTIVE = new Set(['queued', 'running']);
const VALUE_LIMIT = 256;
const DEFAULT_SOURCES = () => [
  { sourceId: 'default', label: 'Default Helm', home: resolve(process.env.HELM_HOME || join(homedir(), '.helm')) },
];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const bodyBytes = (snapshot) => Buffer.byteLength(JSON.stringify({ snapshot: JSON.stringify(snapshot) }), 'utf8');
const fits = (snapshot) => jsonBytes(snapshot) < SNAPSHOT_MAX_BYTES && bodyBytes(snapshot) < SITE_DATA_MAX_BYTES;

function scalar(value, counters) {
  if (typeof value === 'string') {
    if (value.length <= VALUE_LIMIT) return value;
    counters.truncatedFields++;
    return `${value.slice(0, VALUE_LIMIT - 1)}…`;
  }
  return typeof value === 'boolean' || isFiniteNumber(value) ? value : undefined;
}

function pick(value, keys, counters) {
  const output = {};
  for (const key of keys) {
    const safe = scalar(value?.[key], counters);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

function validateState(state) {
  if (!isObject(state) || state.ok !== true || !isObject(state.run) || !Array.isArray(state.workers) || !Array.isArray(state.models) || !isTimestamp(state.observedAt)
    || !['spendUsd', 'spendCapUsd', 'activeWorkers', 'maxWorkers', 'unknownCostEvents'].every((key) => isFiniteNumber(state.run[key]) && state.run[key] >= 0)
    || !state.workers.every((worker) => isObject(worker) && typeof worker.workerId === 'string' && typeof worker.state === 'string')
    || !state.models.every((model) => isObject(model) && typeof model.model === 'string')) {
    throw new Error('daemon returned an invalid /api/state shape');
  }
}

/** Project one daemon response. Unknown nested data is never copied into the cloud record. */
export function snapshotFromState(state, { sourceId } = {}) {
  validateState(state);
  const counters = { truncatedFields: 0 };
  const worker = (value) => ({
    ...(sourceId ? { sourceId } : {}),
    ...pick(value, ['workerId', 'repoSlug', 'state', 'role', 'model', 'createdAt', 'updatedAt', 'elapsedMs', 'spendUsd', 'tokens', 'unknownCostEvents', 'head'], counters),
  });
  const model = (value) => pick(value, ['model', 'workers', 'active', 'spendUsd', 'tokens', 'unknownCostEvents'], counters);
  const workers = state.workers.map(worker).sort((a, b) => Number(ACTIVE.has(b.state)) - Number(ACTIVE.has(a.state)) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return {
    observedAt: state.observedAt,
    run: pick(state.run, ['spendUsd', 'spendCapUsd', 'spendWarnUsd', 'aboveSoftCap', 'activeWorkers', 'maxWorkers', 'unknownCostEvents'], counters),
    daemon: pick(state.run.daemon ?? state.daemon, ['version', 'revision', 'phase'], counters),
    workers,
    models: state.models.map(model),
    totalWorkers: workers.length,
    activeWorkers: workers.filter((item) => ACTIVE.has(item.state)).length,
    truncatedFields: counters.truncatedFields,
  };
}

function sourceSummary(source, projection, status) {
  return {
    sourceId: source.sourceId,
    label: source.label,
    status,
    ...(projection ? { observedAt: projection.observedAt, totalWorkers: projection.totalWorkers, activeWorkers: projection.activeWorkers, run: projection.run, daemon: projection.daemon } : {}),
  };
}

function priorProjection(snapshot, sourceId) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.sources)) return undefined;
  const source = snapshot.sources.find((candidate) => candidate?.sourceId === sourceId);
  if (!source || !isTimestamp(source.observedAt)) return undefined;
  const counters = { truncatedFields: 0 };
  const workers = Array.isArray(snapshot.workers)
    ? snapshot.workers.filter((worker) => worker?.sourceId === sourceId).map((worker) => ({ sourceId, ...pick(worker, ['workerId', 'repoSlug', 'state', 'role', 'model', 'createdAt', 'updatedAt', 'elapsedMs', 'spendUsd', 'tokens', 'unknownCostEvents', 'head'], counters) }))
    : [];
  const models = Array.isArray(snapshot.models)
    ? snapshot.models.filter((model) => model?.sourceId === sourceId).map((model) => ({ sourceId, ...pick(model, ['model', 'workers', 'active', 'spendUsd', 'tokens', 'unknownCostEvents'], counters) }))
    : [];
  return { observedAt: source.observedAt, daemon: pick(source.daemon, ['version', 'revision', 'phase'], counters), run: pick(source.run, ['spendUsd', 'spendCapUsd', 'spendWarnUsd', 'aboveSoftCap', 'activeWorkers', 'maxWorkers', 'unknownCostEvents'], counters), workers, models, totalWorkers: Number(source.totalWorkers) || workers.length, activeWorkers: Number(source.activeWorkers) || 0, truncatedFields: counters.truncatedFields };
}

/** Merge live source projections with retained cloud data for unavailable sources. */
export function mergeSnapshots(results, previous, now = new Date().toISOString()) {
  const sources = [];
  const candidates = [];
  const models = [];
  let complete = true;
  let totalWorkers = 0;
  let activeWorkers = 0;
  let spendUsd = 0;
  let spendCapUsd = 0;
  let uncapped = false;
  let unknownCostEvents = 0;
  let truncatedFields = 0;
  for (const result of results) {
    const projection = result.projection ?? priorProjection(previous, result.source.sourceId);
    const status = result.projection ? (Date.now() - Date.parse(result.projection.observedAt) > STALE_MS ? 'stale' : 'live') : 'unavailable';
    if (status !== 'live') complete = false;
    if (!projection) { sources.push(sourceSummary(result.source, undefined, 'unavailable')); continue; }
    sources.push(sourceSummary(result.source, projection, status));
    totalWorkers += projection.totalWorkers;
    activeWorkers += projection.activeWorkers;
    spendUsd += Number(projection.run?.spendUsd) || 0;
    spendCapUsd += Number(projection.run?.spendCapUsd) || 0;
    if (!projection.run?.spendCapUsd) uncapped = true;
    unknownCostEvents += Number(projection.run?.unknownCostEvents) || 0;
    truncatedFields += projection.truncatedFields ?? 0;
    candidates.push(...projection.workers.map((worker) => ({ ...worker, sourceId: result.source.sourceId })));
    models.push(...projection.models.map((model) => ({ ...model, sourceId: result.source.sourceId })));
  }
  candidates.sort((a, b) => Number(ACTIVE.has(b.state)) - Number(ACTIVE.has(a.state)) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  const snapshot = {
    schemaVersion: 2,
    observedAt: now,
    run: { spendUsd, spendCapUsd: uncapped ? 0 : spendCapUsd, unknownCostEvents, activeWorkers },
    counts: { totalWorkers, activeWorkers, publishedWorkers: 0, truncatedWorkers: 0, totalModels: models.length, publishedModels: 0, truncatedModels: 0, truncatedFields, sourcesComplete: complete, availableSources: sources.filter((source) => source.status !== 'unavailable').length, unavailableSources: sources.filter((source) => source.status === 'unavailable').length },
    sources,
    workers: [],
    models: [],
  };
  for (const worker of candidates) {
    snapshot.workers.push(worker);
    if (!fits(snapshot)) { snapshot.workers.pop(); break; }
  }
  snapshot.counts.publishedWorkers = snapshot.workers.length;
  snapshot.counts.truncatedWorkers = Math.max(0, totalWorkers - snapshot.workers.length);
  for (const model of models) {
    snapshot.models.push(model);
    snapshot.counts.publishedModels = snapshot.models.length;
    snapshot.counts.truncatedModels = models.length - snapshot.models.length;
    if (!fits(snapshot)) { snapshot.models.pop(); break; }
  }
  snapshot.counts.publishedModels = snapshot.models.length;
  snapshot.counts.truncatedModels = models.length - snapshot.models.length;
  while (!fits(snapshot) && (snapshot.models.length || snapshot.workers.length)) {
    if (snapshot.models.length) snapshot.models.pop();
    else snapshot.workers.pop();
    snapshot.counts.publishedModels = snapshot.models.length;
    snapshot.counts.truncatedModels = models.length - snapshot.models.length;
    snapshot.counts.publishedWorkers = snapshot.workers.length;
    snapshot.counts.truncatedWorkers = Math.max(0, totalWorkers - snapshot.workers.length);
  }
  if (!fits(snapshot)) throw new Error('safe fleet summary exceeds the Site Data size limit');
  return snapshot;
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
  if (!existsSync(servePath)) throw new Error('Helm daemon is not advertising serve.json');
  const response = await request(stateUrl(parseServeJson(readFileSync(servePath, 'utf8'))), { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Helm /api/state returned HTTP ${response.status}`);
  const state = await response.json();
  validateState(state);
  return state;
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
  } catch { /* Plaintext credentials are also accepted by the local helper. */ }
  if (text) return text;
  throw new Error('Here.now credentials are unavailable');
}

async function json(request, url, options) {
  const response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    const error = new Error(`Here.now returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  try { return await response.json(); } catch { throw new Error('Here.now returned invalid JSON'); }
}

export async function assertPrivateAccess(slug, auth, request = fetch) {
  const policy = await json(request, `${API_ORIGIN}/api/v1/publish/${encodeURIComponent(slug)}/access`, { headers: ownerHeaders(auth) });
  const mode = typeof policy?.access === 'string' ? policy.access : policy?.access?.mode;
  if (!['password', 'restricted', 'account_members'].includes(mode)) throw new Error('refusing cloud write: site access must be password, restricted, or account_members');
  return policy;
}

export async function listFleetRecord(slug, auth, request = fetch) {
  const base = `${API_ORIGIN}/api/v1/publishes/${encodeURIComponent(slug)}/data/fleet`;
  const listed = await json(request, base, { headers: ownerHeaders(auth) });
  if (!Array.isArray(listed.records)) throw new Error('fleet record list is malformed');
  const records = listed.records;
  if (records.length > 1 || listed.nextCursor) throw new Error('refusing ambiguous Site Data record list');
  if (records.length === 1 && (typeof records[0]?.id !== 'string' || typeof records[0]?.data?.snapshot !== 'string')) throw new Error('fleet record is malformed');
  let previous;
  if (records.length === 1) {
    try { previous = JSON.parse(records[0].data.snapshot); } catch { throw new Error('fleet record snapshot is invalid JSON'); }
  }
  return { base, records, previous };
}

/** Update exactly one record. Access is checked immediately before the mutating request. */
export async function publishSnapshot({ slug, snapshot, auth = readLocalAuth(), request = fetch, listed }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug)) throw new Error('invalid site slug');
  const recordList = listed ?? await listFleetRecord(slug, auth, request);
  const body = JSON.stringify({ snapshot: JSON.stringify(snapshot) });
  if (Buffer.byteLength(body, 'utf8') >= SITE_DATA_MAX_BYTES) throw new Error('fleet Site Data body exceeds 16KB');
  await assertPrivateAccess(slug, auth, request);
  const headers = ownerHeaders(auth);
  if (recordList.records.length === 1) {
    const id = recordList.records[0].id;
    await json(request, `${recordList.base}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body });
    return { action: 'updated', recordId: id };
  }
  const idempotencyKey = createHash('sha256').update(`helm-fleet-v2:${slug}`).digest('hex');
  const created = await json(request, recordList.base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body });
  return { action: 'created', recordId: created.id ?? created.record?.id ?? null };
}

export async function retryPublish(operation, sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))) {
  let failure;
  for (const delay of [0, 200, 600]) {
    if (delay) await sleep(delay);
    try { return await operation(); } catch (error) {
      failure = error;
      const status = error && typeof error === 'object' ? error.status : undefined;
      if (!(error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name) || status === 429 || (typeof status === 'number' && status >= 500))) break;
    }
  }
  throw failure;
}

export function acquirePublisherLock(home, slug, sources = []) {
  mkdirSync(home, { recursive: true });
  const path = join(home, `.fleet-${slug.replace(/[^a-z0-9_-]/gi, '_')}.lock`);
  let fd;
  try { fd = openSync(path, 'wx'); } catch { throw new Error(`fleet publisher lock exists: ${path}`); }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), site: slug, sources: sources.map((source) => source.sourceId) })); }
  catch (error) { closeSync(fd); rmSync(path, { force: true }); throw error; }
  return () => { try { closeSync(fd); } finally { rmSync(path, { force: true }); } };
}

export async function collectSources(sources, request = fetch) {
  return Promise.all(sources.map(async (source) => {
    try { return { source, projection: snapshotFromState(await fetchState(source.home, request), { sourceId: source.sourceId }) }; }
    catch (error) { return { source, error: error instanceof Error ? error.message : 'source unavailable' }; }
  }));
}

/** A source-only failure does not read credentials or owner APIs; its previous cloud record stays untouched. */
export async function syncOnce({ sources, slug, auth, request = fetch }) {
  const results = await collectSources(sources, request);
  if (!results.some((result) => result.projection)) return { action: 'unavailable', results };
  const effectiveAuth = auth ?? readLocalAuth();
  const listed = await listFleetRecord(slug, effectiveAuth, request);
  const snapshot = mergeSnapshots(results, listed.previous);
  return { ...await retryPublish(() => publishSnapshot({ slug, snapshot, auth: effectiveAuth, request, listed })), snapshot, results };
}

function waitFor(interval, signal) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(done, interval);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolvePromise(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function runPublisher({ sources, slug, interval = DEFAULT_INTERVAL_MS, once = false, auth, request = fetch, report = console.log }) {
  if (!Number.isInteger(interval) || interval < 10000) throw new Error('--interval must be an integer of at least 10000ms');
  const release = acquirePublisherLock(sources[0]?.home ?? join(homedir(), '.helm'), slug, sources);
  const stop = new AbortController();
  const stopNow = () => stop.abort();
  process.once('SIGINT', stopNow); process.once('SIGTERM', stopNow);
  try {
    do {
      try {
        const result = await syncOnce({ sources, slug, auth, request });
        report(result.action === 'unavailable' ? 'fleet sources unavailable; cloud snapshot retained unchanged' : `fleet ${result.action}: ${result.snapshot.counts.publishedWorkers}/${result.snapshot.counts.totalWorkers} workers`);
      } catch (error) {
        report(`fleet publish unavailable: ${error instanceof Error ? error.message : 'request failed'}; previous snapshot retained`);
        if (once) throw error;
      }
      if (!once && !stop.signal.aborted) await waitFor(interval, stop.signal);
    } while (!once && !stop.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stopNow); process.removeListener('SIGTERM', stopNow); release();
  }
}

export function parseFleetArgs(args) {
  let slug; let home; let interval = DEFAULT_INTERVAL_MS; let once = false;
  const sources = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = () => { const next = args[++index]; if (!next || next.startsWith('--')) throw new Error(`missing value for ${arg}`); return next; };
    if (arg === '--site') slug = value();
    else if (arg === '--home') home = value();
    else if (arg === '--source') {
      const [sourceId, path, extra] = value().split('=');
      if (!sourceId || !path || extra || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(sourceId) || !path.startsWith('/')) throw new Error('--source must be label=/absolute/home');
      sources.push({ sourceId, label: sourceId, home: resolve(path) });
    } else if (arg === '--interval') interval = Number(value());
    else if (arg === '--once') once = true;
    else throw new Error(`unknown fleet option: ${arg}`);
  }
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug)) throw new Error('usage: helm fleet sync --site <slug> [--source label=/absolute/home]... [--home <HELM_HOME>] [--interval <ms>] [--once]');
  if (home && sources.length) throw new Error('--home cannot be combined with --source');
  if (home) sources.push({ sourceId: 'default', label: 'Default Helm', home: resolve(home) });
  if (!sources.length) sources.push(...DEFAULT_SOURCES());
  if (sources.length > 16 || new Set(sources.map((source) => source.sourceId)).size !== sources.length) throw new Error('use at most 16 uniquely labelled sources');
  if (!Number.isInteger(interval) || interval < 10000) throw new Error('--interval must be an integer of at least 10000ms');
  return { slug, sources, interval, once };
}

async function main(args) {
  if (args[0] !== 'sync') throw new Error('usage: helm fleet sync --site <slug> [--source label=/absolute/home]... [--home <HELM_HOME>] [--interval <ms>] [--once]');
  await runPublisher(parseFleetArgs(args.slice(1)));
}

if (process.argv[1] && process.argv[1].endsWith('/fleet.mjs')) main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
