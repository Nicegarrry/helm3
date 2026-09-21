const STALE_MS = 90_000;
const POLL_MS = 30_000;
export const APPEARANCE_STORAGE_KEY = 'helm-fleet-appearance';
const $ = (id) => document.getElementById(id);
let snapshot;
let lastReceived = 0;
let offline = false;
let loading = false;
let selectedProject = '';

export function normalizeAppearance(value) {
  return ['system', 'light', 'dark'].includes(value) ? value : 'system';
}

export function readAppearance(storage) {
  try { return normalizeAppearance(storage?.getItem(APPEARANCE_STORAGE_KEY)); } catch { return 'system'; }
}

export function persistAppearance(value, storage) {
  if (!storage) return false;
  try { storage.setItem(APPEARANCE_STORAGE_KEY, normalizeAppearance(value)); return true; } catch { return false; }
}

export function resolvedTheme(appearance, systemDark) {
  const selected = normalizeAppearance(appearance);
  return selected === 'system' ? (systemDark ? 'dark' : 'light') : selected;
}

function text(node, value) {
  node.textContent = value == null || value === '' ? '—' : String(value);
}

function money(value) {
  if (typeof value !== 'number') return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
export function validSnapshot(value) {
  const object = (item) => item && typeof item === 'object' && !Array.isArray(item);
  const count = (item) => Number.isInteger(item) && item >= 0;
  return object(value) && value.schemaVersion === 2 && isTimestamp(value.observedAt)
    && object(value.run) && object(value.counts)
    && ['totalWorkers', 'activeWorkers', 'publishedWorkers', 'truncatedWorkers'].every((key) => count(value.counts[key]))
    && typeof value.counts.sourcesComplete === 'boolean'
    && Array.isArray(value.sources) && value.sources.length > 0
    && value.sources.every((item) => object(item) && typeof item.sourceId === 'string'
      && ['live', 'stale', 'unavailable'].includes(item.status)
      && (isTimestamp(item.observedAt) || (item.status === 'unavailable' && item.observedAt == null)))
    && Array.isArray(value.workers) && value.workers.every((item) => object(item) && typeof item.workerId === 'string' && typeof item.sourceId === 'string')
    && Array.isArray(value.models) && value.models.every((item) => object(item) && typeof item.model === 'string');
}

export function sourceStatus(source, now = Date.now()) {
  if (!source) return 'unknown';
  return source.status === 'live' && now - Date.parse(source.observedAt) > STALE_MS ? 'stale' : source.status;
}

function recordSnapshot(payload) {
  if (payload?.nextCursor || (payload?.records && payload.records.length !== 1)) throw new Error('no unique snapshot');
  const raw = payload?.records?.[0]?.data?.snapshot ?? payload?.snapshot;
  if (typeof raw !== 'string') throw new Error('no fleet snapshot is available yet');
  return JSON.parse(raw);
}
function setOptions(id, values, label) {
  const select = $(id);
  const oldValue = select.value;
  select.replaceChildren(new Option(label, ''));
  for (const value of values) select.add(new Option(value, value));
  select.value = values.includes(oldValue) ? oldValue : '';
}

export function projectFilters(workers) {
  const slugs = [...new Set(workers.map((worker) => worker.repoSlug).filter(Boolean))].sort();
  const names = new Map();
  for (const slug of slugs) {
    const name = slug.split('/').pop() || slug;
    const matches = slugs.filter((candidate) => (candidate.split('/').pop() || candidate) === name);
    names.set(slug, matches.length > 1 ? `${name} (${slug})` : name);
  }
  return slugs.map((slug) => ({ key: slug, label: names.get(slug), title: slug }));
}

function renderProjectFilters() {
  const group = $('project-filters');
  const filters = [{ key: '', label: 'All', title: 'All projects' }, ...projectFilters(snapshot.workers)];
  if (!filters.some((filter) => filter.key === selectedProject)) selectedProject = '';
  const existing = new Map([...group.querySelectorAll('button')].map((button) => [button.dataset.project, button]));
  const ordered = [];
  for (const filter of filters) {
    const button = existing.get(filter.key) || document.createElement('button');
    button.type = 'button'; button.dataset.project = filter.key; button.title = filter.title;
    button.textContent = filter.label; button.setAttribute('aria-pressed', String(selectedProject === filter.key));
    button.className = selectedProject === filter.key ? 'selected' : '';
    if (!existing.has(filter.key)) button.addEventListener('click', () => { selectedProject = filter.key; renderProjectFilters(); renderWorkers(); });
    ordered.push(button);
  }
  if (ordered.some((button, index) => group.children[index] !== button)) group.replaceChildren(...ordered);
}

function freshness() {
  const node = $('freshness');
  if (!snapshot) {
    node.className = `status ${offline ? 'offline' : 'waiting'}`;
    text(node, offline ? 'Offline · waiting for first snapshot' : 'Waiting for first snapshot');
    return;
  }
  const stale = Date.now() - Date.parse(snapshot.observedAt) > STALE_MS;
  const partial = snapshot.counts?.sourcesComplete === false;
  node.className = `status ${offline ? 'offline' : stale ? 'stale' : partial ? 'partial' : 'live'}`;
  text(node, offline ? 'Offline · last snapshot retained' : stale ? 'Stale · awaiting publisher' : partial ? 'Partial · last-known totals' : 'Live snapshot');
  text($('updated'), `Snapshot ${new Date(snapshot.observedAt).toLocaleTimeString()} · checked ${new Date(lastReceived).toLocaleTimeString()}`);
}

function sourceHealth() {
  const health = $('source-health');
  health.replaceChildren();
  for (const source of snapshot.sources) {
    const item = document.createElement('li');
    const status = sourceStatus(source);
    item.className = `source-${status}`;
    const observed = isTimestamp(source.observedAt) ? ` · ${new Date(source.observedAt).toLocaleTimeString()}` : '';
    text(item, `${source.label || source.sourceId}: ${status}${observed}${source.daemon?.version ? ` · Helm ${source.daemon.version}` : ''}`);
    health.append(item);
  }
}

function workerDetails(worker) {
  const details = document.createElement('div');
  details.className = 'worker-details';
  const rows = [
    ['Repository', worker.repoSlug], ['Runner', worker.sourceId],
    ['Role', worker.role],
    ['Elapsed', worker.elapsedMs == null ? undefined : `${Math.round(worker.elapsedMs / 1000)}s`],
    ['Spend', money(worker.spendUsd)], ['Tokens', worker.tokens], ['Updated', worker.updatedAt], ['Head', worker.head],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    const key = document.createElement('span');
    const content = document.createElement('span');
    text(key, label); text(content, value);
    row.append(key, content); details.append(row);
  }
  return details;
}

function renderWorkers() {
  const list = $('worker-list');
  const open = new Set([...list.querySelectorAll('details[open]')].map((item) => item.dataset.worker));
  const state = $('state').value;
  const sourceId = $('source').value;
  const workers = snapshot.workers.filter((worker) => (!selectedProject || worker.repoSlug === selectedProject) && (!state || worker.state === state) && (!sourceId || worker.sourceId === sourceId));
  list.replaceChildren();
  if (!workers.length) {
    const empty = document.createElement('p');
    text(empty, 'No workers match these filters.'); list.append(empty);
    return;
  }
  for (const worker of workers) {
    const card = document.createElement('details'); const workerKey = `${worker.sourceId}:${worker.workerId}`;
    card.className = 'worker'; card.dataset.worker = workerKey; card.open = open.has(workerKey);
    const summary = document.createElement('summary'); const left = document.createElement('span'); const name = document.createElement('strong'); const meta = document.createElement('span'); const pill = document.createElement('span');
    meta.className = 'meta'; pill.className = `pill state-${worker.state || 'unknown'}`;
    text(name, worker.workerId); text(meta, `Repository: ${worker.repoSlug || 'unknown'} · Runner: ${worker.sourceId || 'unknown'} (${sourceStatus(snapshot.sources.find((source) => source.sourceId === worker.sourceId))}) · ${worker.model || 'model unknown'}`); text(pill, worker.state || 'unknown');
    left.append(name, document.createElement('br'), meta); summary.append(left, pill); card.append(summary, workerDetails(worker)); list.append(card);
  }
}

function renderModels() {
  const models = $('models'); models.replaceChildren();
  for (const model of snapshot.models) {
    const row = document.createElement('div'); const name = document.createElement('span'); const total = document.createElement('span');
    row.className = 'model'; text(name, `${model.sourceId || 'source'} · ${model.model || 'unknown model'}`); text(total, `${model.active ?? 0} active · ${money(model.spendUsd)}`); row.append(name, total); models.append(row);
  }
}

function render() {
  if (!snapshot) return;
  const counts = snapshot.counts || {};
  text($('spend'), `${money(snapshot.run?.spendUsd)}${snapshot.run?.spendCapUsd > 0 ? ` / ${money(snapshot.run.spendCapUsd)}` : ''}`);
  text($('workers-count'), `${counts.activeWorkers ?? 0} active · ${counts.totalWorkers ?? 0} ${counts.sourcesComplete ? 'total' : 'last known'}`); text($('unknown'), snapshot.run?.unknownCostEvents ?? '—');
  text($('notice'), `${counts.truncatedWorkers || 0} workers and ${counts.truncatedModels || 0} model rows omitted for the private size limit.`); $('notice').hidden = !(counts.truncatedWorkers || counts.truncatedModels || counts.truncatedFields);
  renderProjectFilters();
  setOptions('state', [...new Set(snapshot.workers.map((worker) => worker.state).filter(Boolean))].sort(), 'All states');
  setOptions('source', [...new Set(snapshot.sources.map((item) => item.sourceId).filter(Boolean))].sort(), 'All runners');
  sourceHealth(); renderWorkers(); renderModels(); freshness();
}

async function load() {
  if (document.hidden || loading) return;
  loading = true;
  try {
    const response = await fetch('./.herenow/data/fleet?limit=1', { cache: 'no-store', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const candidate = recordSnapshot(await response.json());
    if (!validSnapshot(candidate)) throw new Error('invalid fleet snapshot');
    snapshot = candidate; offline = false; lastReceived = Date.now(); render();
  } catch { offline = true; freshness(); }
  finally { loading = false; }
}

if (typeof document !== 'undefined') {
  const storage = () => {
    try { return window.localStorage; } catch { return undefined; }
  };
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
  let appearance = readAppearance(storage());
  const applyAppearance = (value) => {
    appearance = normalizeAppearance(value);
    const root = document.documentElement;
    if (appearance === 'system') root.removeAttribute('data-theme');
    else root.dataset.theme = appearance;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute('content', resolvedTheme(appearance, Boolean(media?.matches)) === 'dark' ? '#201f1c' : '#f5f2ec');
    $('appearance').value = appearance;
  };
  const onSystemThemeChange = () => { if (appearance === 'system') applyAppearance('system'); };
  applyAppearance(appearance);
  $('appearance').addEventListener('change', (event) => {
    const value = normalizeAppearance(event.currentTarget.value);
    persistAppearance(value, storage());
    applyAppearance(value);
  });
  if (media?.addEventListener) media.addEventListener('change', onSystemThemeChange);
  else media?.addListener?.(onSystemThemeChange);
  for (const id of ['state', 'source']) $(id).addEventListener('change', renderWorkers);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
  setInterval(() => {
    void load();
    freshness();
    if (snapshot) { sourceHealth(); renderWorkers(); }
  }, POLL_MS);
  void load();
}
