/**
 * Live read-only dashboard shell for GET /. A single self-contained HTML document (inline CSS + vanilla JS,
 * no external resources) that polls the loopback JSON endpoints: /api/state and /api/events every 2s,
 * /api/worker/<id> when a row is clicked. All dynamic text goes through textContent, never innerHTML.
 */

/** Escape text for safe interpolation into HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const CSS = `
:root { color-scheme: light dark; --ok:#2e9e5b; --run:#2f7de1; --bad:#d64545; --warn:#c98a11; --mute:color-mix(in srgb, currentColor 55%, transparent);
  --line:color-mix(in srgb, currentColor 14%, transparent); --bg:Canvas; --fg:CanvasText; --panel:color-mix(in srgb, currentColor 5%, transparent); }
* { box-sizing: border-box; }
body { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1rem 1.25rem; background: var(--bg); color: var(--fg); }
header { display:flex; gap:1rem; align-items:baseline; flex-wrap:wrap; margin-bottom: .75rem; }
h1 { font-size: 16px; margin: 0; } h2 { font-size: 13px; margin: 1.25rem 0 .4rem; opacity:.8; text-transform: uppercase; letter-spacing:.04em; }
.live { display:inline-block; width:.55em; height:.55em; border-radius:50%; background:var(--ok); margin-right:.4em; animation: p 1.6s infinite; }
.live.down { background: var(--bad); animation: none; } #conn { color: var(--bad); font-size: 11px; display:none; } #conn.on { display:inline; }
@keyframes p { 50% { opacity:.3; } }
.stat { color: var(--mute); white-space: nowrap; } .stat b { color: inherit; font-weight:600; }
.bar { display:inline-block; width: 8ch; height: 4px; vertical-align: middle; margin-left: .4em; background: var(--line); border-radius: 2px; overflow: hidden; }
.bar i { display:block; height:100%; background: var(--run); width:0; } .bar.hot i { background: var(--bad); }
.grid2 { display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5rem; align-items:start; margin-top: .5rem; }
@media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
section { min-width: 0; } .tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; } th, td { text-align:left; vertical-align:top; padding:.35rem .55rem; border-bottom:1px solid var(--line); }
th { color: var(--mute); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
td.num, th.num { text-align:right; white-space:nowrap; } td.obj { max-width: 28ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
td.ev { min-width: 24ch; max-width: 40ch; overflow-wrap:anywhere; } td.head { white-space:nowrap; } td.model { overflow-wrap:anywhere; max-width: 26ch; }
tbody tr.w { cursor: pointer; } tbody tr.w:hover, tbody tr.w.sel { background: var(--panel); }
small { color: var(--mute); } td:first-child small { white-space: nowrap; } code { font: inherit; }
.pill { display:inline-block; padding:0 .45em; border-radius:.6em; border:1px solid currentColor; font-size:11px; white-space:nowrap; }
.s-running { color: var(--run); } .s-succeeded { color: var(--ok); } .s-failed, .s-unknown { color: var(--bad); }
.s-idle, .s-interrupted, .s-stopped, .s-queued { color: var(--warn); }
.tools { display:flex; gap:.4rem; align-items:center; flex-wrap:wrap; margin: .25rem 0 .5rem; }
button, input { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: .4em; padding: .15em .6em; }
button.on { border-color: currentColor; background: var(--panel); } button:hover { background: var(--panel); cursor: pointer; }
input { flex: 1 1 18ch; max-width: 40ch; }
canvas { width: 100%; height: 180px; display:block; border: 1px solid var(--line); border-radius: .4em; }
#events { max-height: 22rem; overflow: auto; border: 1px solid var(--line); border-radius: .4em; padding: .3rem .5rem; }
#events div { white-space: pre-wrap; overflow-wrap: anywhere; } #events .t { color: var(--mute); } #events .k { font-weight: 600; }
#events .red { color: var(--bad); } #events .green { color: var(--ok); }
#drawer { position: fixed; top:0; right:0; bottom:0; width: min(56ch, 100vw); background: var(--bg); border-left: 1px solid var(--line);
  box-shadow: -8px 0 24px color-mix(in srgb, currentColor 12%, transparent); padding: 1rem 1.25rem; overflow:auto; transform: translateX(105%); transition: transform .15s; z-index: 5; }
#drawer.open { transform: none; } #drawer h2:first-of-type { margin-top: 0; }
#drawer .top { display:flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
#drawer pre { background: var(--panel); padding: .5rem; border-radius: .4em; overflow:auto; max-height: 14rem; font-size: 12px; white-space: pre-wrap; }
#drawer .ok { color: var(--ok); } #drawer .no { color: var(--bad); } .kv { color: var(--mute); } .kv b { color: inherit; font-weight: 600; }
#dev div { padding: .15rem 0; border-bottom: 1px solid var(--line); } a { color: var(--run); }
footer { margin-top: 1.25rem; }
`;

const JS = `
'use strict';
var $ = function (id) { return document.getElementById(id); };
function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
function add(p) { for (var i = 1; i < arguments.length; i++) if (arguments[i] != null) p.appendChild(arguments[i]); return p; }
var nf4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 });
var nf2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtUsd(n) { n = Number(n) || 0; return n < 1 ? nf4.format(n) : nf2.format(n); }
function fmtTokens(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function fmtElapsed(ms) { var s = Math.max(0, Math.floor(ms / 1000)); if (s < 60) return s + 's'; var m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; }
function rel(at) { var ms = Date.now() - Date.parse(at); if (!isFinite(ms)) return '-'; return fmtElapsed(ms) + ' ago'; }
function tod(at) { var d = new Date(at); return isNaN(d) ? '--:--:--' : d.toTimeString().slice(0, 8); }
function str(d, k) { return typeof d[k] === 'string' ? d[k] : undefined; }
function summarize(kind, data) {
  var d = data && typeof data === 'object' ? data : {};
  switch (kind) {
    case 'tool.call': return ((str(d, 'tool') || '') + ' ' + (str(d, 'summary') || '')).trim();
    case 'tool.refused': return ((str(d, 'tool') || '') + ' refused: ' + (str(d, 'reason') || '')).trim();
    case 'state': return (str(d, 'from') || '?') + ' -> ' + (str(d, 'to') || '?');
    case 'result': return ((str(d, 'status') || '') + ' ' + (str(d, 'summary') || '')).trim();
    case 'error': return str(d, 'message') || '';
    case 'gate': return d.passed ? 'passed' : 'failed';
    case 'pr': return str(d, 'url') || '';
    default: for (var k in d) if (typeof d[k] === 'string') return d[k]; return '';
  }
}
var ACTIVE = { queued: 1, running: 1, idle: 1 }, DONE = { succeeded: 1, stopped: 1 }, FAILED = { failed: 1, unknown: 1, interrupted: 1 };
var state = null, receivedAt = 0, lastSeq = 0, events = [], filter = 'all', query = '', openId = null, pinned = true, down = false;

function setDown(v) { down = v; $('dot').className = 'live' + (v ? ' down' : ''); $('conn').className = v ? 'on' : ''; }
async function getJson(url) { var r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('http ' + r.status); var j = await r.json(); if (!j.ok) throw new Error(j.reason || 'not ok'); return j; }

function renderHeader() {
  var run = state.run, cap = run.spendCapUsd > 0;
  $('spend').textContent = fmtUsd(run.spendUsd); $('cap').textContent = cap ? ' / ' + fmtUsd(run.spendCapUsd) + ' cap' : ' (no cap)';
  var pct = cap ? Math.min(100, 100 * run.spendUsd / run.spendCapUsd) : 0;
  $('barfill').style.width = pct + '%'; $('bar').className = 'bar' + (pct >= 90 ? ' hot' : '');
  $('active').textContent = run.activeWorkers; $('max').textContent = run.maxWorkers; $('unk').textContent = run.unknownCostEvents;
  $('observed').textContent = rel(state.observedAt);
}
function matches(w) {
  if (filter === 'active' && !ACTIVE[w.state]) return false;
  if (filter === 'done' && !DONE[w.state]) return false;
  if (filter === 'failed' && !FAILED[w.state]) return false;
  if (!query) return true;
  var q = query.toLowerCase();
  return (w.workerId + ' ' + w.model + ' ' + w.objective).toLowerCase().indexOf(q) >= 0;
}
function renderWorkers() {
  var tb = $('wbody'); tb.textContent = '';
  var rows = state.workers.filter(matches);
  if (!rows.length) { var td = el('td', null, null); td.colSpan = 10; add(td, el('small', null, state.workers.length ? 'no workers match' : 'no workers yet')); add(tb, add(el('tr'), td)); return; }
  rows.forEach(function (w) {
    var tr = el('tr', 'w' + (w.workerId === openId ? ' sel' : '')); tr.dataset.id = w.workerId;
    var c1 = add(el('td'), el('code', null, w.workerId), el('br'), el('small', null, w.repoSlug + ' \\u00b7 ' + w.branch));
    var c2 = add(el('td'), el('span', 'pill s-' + w.state, w.state)); if (w.resultStatus) add(c2, el('br'), el('small', null, w.resultStatus));
    var c5 = el('td', 'num', fmtUsd(w.spendUsd)); if (w.unknownCostEvents) add(c5, el('br'), el('small', null, w.unknownCostEvents + ' unknown'));
    var c7 = el('td', 'num', fmtElapsed(w.elapsedMs)); if (ACTIVE[w.state]) { c7.dataset.base = w.elapsedMs; c7.className += ' tick'; }
    var c9 = el('td', 'obj', w.objective); c9.title = w.objective;
    var c10 = el('td', 'ev'); if (w.lastEvent) add(c10, el('code', null, w.lastEvent.kind), document.createTextNode(' ' + w.lastEvent.summary)); else c10.textContent = '-';
    add(tb, add(tr, c1, c2, el('td', null, w.role), el('td', 'model', w.model), c5, el('td', 'num', fmtTokens(w.tokens)), c7,
      add(el('td', 'head'), el('code', null, w.head ? w.head.slice(0, 8) : '-')), c9, c10));
  });
}
function renderModels() {
  var tb = $('mbody'); tb.textContent = '';
  if (!state.models.length) { var td = el('td'); td.colSpan = 5; add(td, el('small', null, 'none observed')); add(tb, add(el('tr'), td)); return; }
  state.models.forEach(function (m) {
    add(tb, add(el('tr'), el('td', null, m.model), el('td', 'num', m.workers), el('td', 'num', m.active), el('td', 'num', fmtUsd(m.spendUsd)), el('td', 'num', fmtTokens(m.tokens))));
  });
}
function drawChart() {
  var cv = $('chart'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  var g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  var fg = getComputedStyle(document.body).color; g.font = '10px ui-monospace, monospace'; g.fillStyle = fg; g.strokeStyle = fg;
  var pts = (state && state.spendSeries || []).map(function (p) { return { t: Date.parse(p.at), y: Number(p.spendUsd) || 0 }; }).filter(function (p) { return isFinite(p.t); });
  var cap = state ? state.run.spendCapUsd : 0;
  if (pts.length < 2) { g.globalAlpha = .55; g.fillText(pts.length ? 'collecting...' : 'no spend yet', 8, 14); g.globalAlpha = 1; return; }
  var t0 = pts[0].t, t1 = pts[pts.length - 1].t, ymax = Math.max(cap > 0 ? cap : 0, pts.reduce(function (m, p) { return Math.max(m, p.y); }, 0)) || 1;
  var L = 8, R = 8, T = 8, B = 16, X = function (t) { return L + (W - L - R) * (t1 > t0 ? (t - t0) / (t1 - t0) : 0); }, Y = function (y) { return T + (H - T - B) * (1 - y / ymax); };
  g.lineWidth = 1.5; g.strokeStyle = '#2f7de1'; g.beginPath();
  pts.forEach(function (p, i) { i ? g.lineTo(X(p.t), Y(p.y)) : g.moveTo(X(p.t), Y(p.y)); }); g.stroke();
  if (cap > 0) { g.strokeStyle = '#d64545'; g.setLineDash([4, 4]); g.lineWidth = 1; g.beginPath(); g.moveTo(L, Y(cap)); g.lineTo(W - R, Y(cap)); g.stroke(); g.setLineDash([]); }
  g.globalAlpha = .7; g.fillText(fmtUsd(ymax), L, T + 9); g.fillText(fmtUsd(0), L, H - B - 2);
  g.fillText(tod(t0), L, H - 4); var e = tod(t1); g.fillText(e, W - R - g.measureText(e).width, H - 4); g.globalAlpha = 1;
}
function renderEvents() {
  var box = $('events'); box.textContent = '';
  if (!events.length) { add(box, el('small', null, 'no events yet')); return; }
  events.forEach(function (ev) {
    var cls = ev.kind === 'tool.refused' || ev.kind === 'error' ? 'red' : ev.kind === 'result' ? 'green' : '';
    add(box, add(el('div', cls), el('span', 't', tod(ev.at) + '  '), el('span', null, ev.workerId + '  '), el('span', 'k', ev.kind), document.createTextNode('  ' + summarize(ev.kind, ev.data))));
  });
  if (pinned) box.scrollTop = 0;
}
function renderDrawer(d) {
  var dr = $('drawer'), body = $('dbody'); body.textContent = ''; var w = d.worker;
  $('dtitle').textContent = w.workerId; $('dsub').textContent = ''; add($('dsub'), el('span', 'pill s-' + w.state, w.state), document.createTextNode(' ' + w.role + ' \\u00b7 ' + w.model + ' \\u00b7 ' + w.repoSlug + ' \\u00b7 ' + w.branch));
  add(body, el('h2', null, 'Objective'), el('div', null, w.objective));
  add(body, el('h2', null, 'Result'));
  if (d.result) { add(body, add(el('div', 'kv'), el('b', null, d.result.status), document.createTextNode(' ' + d.result.summary))); if (d.result.notes) add(body, el('pre', null, d.result.notes)); }
  else if (d.rawResultText) add(body, el('pre', null, d.rawResultText)); else add(body, el('small', null, 'none yet'));
  add(body, el('h2', null, 'Gates'));
  if (!d.gates || !d.gates.length) add(body, el('small', null, 'no gate runs'));
  (d.gates || []).forEach(function (gt) {
    add(body, add(el('div', 'kv'), el('b', gt.passed ? 'ok' : 'no', gt.passed ? 'passed' : 'failed'), document.createTextNode(' @ ' + String(gt.head || '').slice(0, 8) + ' \\u00b7 ' + rel(gt.at))));
    (gt.checks || []).forEach(function (c) { add(body, add(el('div', c.exitCode === 0 ? 'ok' : 'no'), document.createTextNode('  ' + (c.exitCode === 0 ? '\\u2713' : '\\u2717') + ' ' + c.name + ' exit ' + c.exitCode + ' (' + fmtElapsed(c.durationMs) + ')  '), el('small', null, c.command))); });
  });
  add(body, el('h2', null, 'PR'));
  if (d.pr) { var a = el('a', null, '#' + d.pr.number + ' ' + d.pr.url); a.href = d.pr.url; a.target = '_blank'; a.rel = 'noopener'; add(body, a); } else add(body, el('small', null, 'none'));
  add(body, el('h2', null, 'Diff stat'), d.diffStat ? el('pre', null, d.diffStat) : el('small', null, 'no diff'));
  add(body, el('h2', null, 'Events (' + (d.events || []).length + ')'));
  var list = el('div'); list.id = 'dev';
  (d.events || []).slice().reverse().forEach(function (ev) { add(list, add(el('div'), el('span', 'k', ev.kind), document.createTextNode('  ' + summarize(ev.kind, ev.data) + '  '), el('small', null, rel(ev.at)))); });
  add(body, list); dr.className = 'open';
}
async function openWorker(id) {
  openId = id; if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id); try { renderDrawer(await getJson('/api/worker/' + encodeURIComponent(id))); } catch (e) { $('dtitle').textContent = id; $('dsub').textContent = ''; $('dbody').textContent = 'load failed: ' + e.message; $('drawer').className = 'open'; }
  if (state) renderWorkers();
}
function closeDrawer() { openId = null; if (location.hash) history.replaceState(null, '', location.pathname); $('drawer').className = ''; if (state) renderWorkers(); }
async function pollState() {
  try { state = await getJson('/api/state'); receivedAt = Date.now(); setDown(false); renderHeader(); renderWorkers(); renderModels(); drawChart(); if (openId) openWorker(openId); }
  catch (e) { setDown(true); }
}
async function pollEvents() {
  try {
    var j = await getJson('/api/events?after=' + lastSeq + '&limit=200');
    if (!j.events.length) return;
    j.events.forEach(function (ev) { if (ev.seq > lastSeq) lastSeq = ev.seq; });
    events = j.events.slice().sort(function (a, b) { return b.seq - a.seq; }).concat(events).slice(0, 100);
    renderEvents();
  } catch (e) { setDown(true); }
}
function poll() { if (document.hidden) return; pollState(); pollEvents(); }
function tick() {
  if (!state) return; var dt = Date.now() - receivedAt;
  document.querySelectorAll('td.tick').forEach(function (td) { td.textContent = fmtElapsed(Number(td.dataset.base) + dt); });
  $('observed').textContent = rel(state.observedAt);
}
document.addEventListener('DOMContentLoaded', function () {
  $('wbody').addEventListener('click', function (e) { var tr = e.target.closest('tr.w'); if (tr) openWorker(tr.dataset.id); });
  $('close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  document.querySelectorAll('.tools button').forEach(function (b) { b.addEventListener('click', function () {
    filter = b.dataset.f; document.querySelectorAll('.tools button').forEach(function (x) { x.className = x === b ? 'on' : ''; }); if (state) renderWorkers(); }); });
  $('q').addEventListener('input', function () { query = $('q').value.trim(); if (state) renderWorkers(); });
  $('events').addEventListener('scroll', function () { pinned = $('events').scrollTop < 4; });
  window.addEventListener('resize', drawChart);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  poll(); setInterval(poll, 2000); setInterval(tick, 1000);
  if (/^#w-[0-9a-f]+$/.test(location.hash)) openWorker(location.hash.slice(1));
  window.addEventListener('hashchange', function () { if (/^#w-[0-9a-f]+$/.test(location.hash)) openWorker(location.hash.slice(1)); else closeDrawer(); });
});
`;

/** The dashboard document. Static: all data arrives later via fetch, so nothing here needs escaping. */
export function renderDashboardShell(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Helm</title>
<style>${CSS}</style>
</head>
<body>
<header><h1><span class="live" id="dot"></span>Helm <span id="conn">disconnected</span></h1>
<span class="stat">spend <b id="spend">-</b><span id="cap"></span><span class="bar" id="bar"><i id="barfill"></i></span></span>
<span class="stat">workers <b id="active">-</b> / <span id="max">-</span> active</span>
<span class="stat">unknown-cost events <b id="unk">-</b></span>
<span class="stat">observed <span id="observed">-</span></span></header>
<section>
<h2>Workers</h2>
<div class="tools"><button class="on" data-f="all">all</button><button data-f="active">active</button><button data-f="done">done</button><button data-f="failed">failed</button>
<input id="q" type="search" placeholder="filter id, model, objective" autocomplete="off"></div>
<table><thead><tr><th>Worker</th><th>State</th><th>Role</th><th>Model</th><th class="num">Spend</th><th class="num">Tokens</th><th class="num">Elapsed</th><th>Head</th><th>Objective</th><th>Last event</th></tr></thead>
<tbody id="wbody"><tr><td colspan="10"><small>loading...</small></td></tr></tbody></table>
</section>
<div class="grid2">
<section>
<h2>Models</h2>
<table><thead><tr><th>Model</th><th class="num">Workers</th><th class="num">Active</th><th class="num">Spend</th><th class="num">Tokens</th></tr></thead>
<tbody id="mbody"><tr><td colspan="5"><small>loading...</small></td></tr></tbody></table>
</section>
<section>
<h2>Spend</h2>
<canvas id="chart"></canvas>
</section>
</div>
<h2>Live events</h2>
<div id="events"><small>waiting for events...</small></div>
<footer><small>Read only. JSON at <code>/api/state</code>; tools over MCP at <code>/mcp</code>.</small></footer>
<div id="drawer"><div class="top"><h2 id="dtitle">worker</h2><button id="close" title="Esc">close</button></div>
<div id="dsub"></div><div id="dbody"></div></div>
<script>${JS}</script>
</body></html>`;
}
