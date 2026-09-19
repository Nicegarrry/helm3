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
:root { color-scheme: light dark;
  --bg:#eef0f5; --bg-a:#dfe8ff; --bg-b:#ffe6f0; --bg-c:#e3fbf1;
  --glass:rgba(255,255,255,.62); --glass-strong:rgba(255,255,255,.78); --glass-edge:rgba(255,255,255,.85); --glass-line:rgba(0,0,0,.06);
  --fg:#111114; --mute:#6e6e73; --hover:rgba(0,0,0,.04); --sel:rgba(0,122,255,.12);
  --blue:#007aff; --green:#34c759; --red:#ff3b30; --amber:#ff9500; --gray:#8e8e93;
  --blue-bg:rgba(0,122,255,.14); --green-bg:rgba(52,199,89,.16); --red-bg:rgba(255,59,48,.14); --amber-bg:rgba(255,149,0,.18); --gray-bg:rgba(142,142,147,.18);
  --shadow: 0 1px 0 rgba(255,255,255,.7) inset, 0 10px 30px rgba(20,30,60,.10), 0 1px 2px rgba(20,30,60,.06);
  --r: 26px; --r-sm: 18px; }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) {
  --bg:#0b0b0f; --bg-a:#16204a; --bg-b:#3a1030; --bg-c:#0d2b24;
  --glass:rgba(40,40,48,.55); --glass-strong:rgba(44,44,52,.72); --glass-edge:rgba(255,255,255,.14); --glass-line:rgba(255,255,255,.08);
  --fg:#f5f5f7; --mute:#9a9aa1; --hover:rgba(255,255,255,.05); --sel:rgba(10,132,255,.22);
  --blue:#0a84ff; --green:#30d158; --red:#ff453a; --amber:#ff9f0a; --gray:#98989d;
  --blue-bg:rgba(10,132,255,.22); --green-bg:rgba(48,209,88,.22); --red-bg:rgba(255,69,58,.22); --amber-bg:rgba(255,159,10,.22); --gray-bg:rgba(152,152,157,.22);
  --shadow: 0 1px 0 rgba(255,255,255,.08) inset, 0 12px 36px rgba(0,0,0,.5), 0 1px 2px rgba(0,0,0,.4); } }
:root[data-theme=dark] {
  --bg:#0b0b0f; --bg-a:#16204a; --bg-b:#3a1030; --bg-c:#0d2b24;
  --glass:rgba(40,40,48,.55); --glass-strong:rgba(44,44,52,.72); --glass-edge:rgba(255,255,255,.14); --glass-line:rgba(255,255,255,.08);
  --fg:#f5f5f7; --mute:#9a9aa1; --hover:rgba(255,255,255,.05); --sel:rgba(10,132,255,.22);
  --blue:#0a84ff; --green:#30d158; --red:#ff453a; --amber:#ff9f0a; --gray:#98989d;
  --blue-bg:rgba(10,132,255,.22); --green-bg:rgba(48,209,88,.22); --red-bg:rgba(255,69,58,.22); --amber-bg:rgba(255,159,10,.22); --gray-bg:rgba(152,152,157,.22);
  --shadow: 0 1px 0 rgba(255,255,255,.08) inset, 0 12px 36px rgba(0,0,0,.5), 0 1px 2px rgba(0,0,0,.4); }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 30px 34px 48px; color: var(--fg); min-height: 100vh;
  background: var(--bg);
  background-image: radial-gradient(1100px 600px at -5% -10%, var(--bg-a), transparent 60%), radial-gradient(900px 560px at 105% 0%, var(--bg-b), transparent 60%), radial-gradient(900px 700px at 50% 120%, var(--bg-c), transparent 60%);
  background-attachment: fixed;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Inter, Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; letter-spacing: -0.01em; }
code, .mono { font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; letter-spacing: 0; }
.glass { background: var(--glass); -webkit-backdrop-filter: blur(28px) saturate(180%); backdrop-filter: blur(28px) saturate(180%);
  border: 1px solid var(--glass-edge); box-shadow: var(--shadow); }
header { display:flex; flex-wrap:wrap; align-items:center; gap: 14px 18px; margin-bottom: 24px; }
h1 { font-size: 34px; font-weight: 700; letter-spacing: -0.03em; margin: 0; display:flex; align-items:center; gap:.4em; }
h2 { font-size: 17px; font-weight: 600; margin: 0 0 14px; letter-spacing: -0.015em; }
.live { width: 11px; height: 11px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 5px var(--green-bg), 0 0 12px var(--green); animation: p 2.2s infinite; }
.live.down { background: var(--red); box-shadow: 0 0 0 5px var(--red-bg); animation: none; }
#conn { color: var(--red); font-size: 13px; font-weight: 600; display:none; } #conn.on { display:inline; }
@keyframes p { 50% { opacity:.4; } }
.stats { display:flex; flex-wrap:wrap; gap: 10px; margin-left: auto; }
.stat { background: var(--glass); -webkit-backdrop-filter: blur(28px) saturate(180%); backdrop-filter: blur(28px) saturate(180%); border: 1px solid var(--glass-edge); box-shadow: var(--shadow);
  border-radius: 22px; padding: 10px 16px 11px; min-width: 138px; display:flex; flex-direction:column; gap:2px; }
.stat .l { font-size: 11px; font-weight: 600; color: var(--mute); text-transform: uppercase; letter-spacing: .07em; white-space: nowrap; }
.stat .v { font-size: 19px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; white-space: nowrap; } .stat .v span { color: var(--mute); font-weight: 500; font-size: 13px; letter-spacing: 0; }
.bar { display:block; width: 100%; height: 5px; margin-top: 7px; background: var(--glass-line); border-radius: 3px; overflow: hidden; }
.bar i { display:block; height:100%; background: var(--blue); width:0; border-radius: 3px; transition: width .4s; } .bar.warn i { background: var(--amber); } .bar.hot i { background: var(--red); }
.card { background: var(--glass); -webkit-backdrop-filter: blur(28px) saturate(180%); backdrop-filter: blur(28px) saturate(180%); border: 1px solid var(--glass-edge); box-shadow: var(--shadow);
  border-radius: var(--r); padding: 20px 22px; margin-bottom: 22px; min-width: 0; }
.grid2 { display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 22px; align-items:start; }
@media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } body { padding: 16px; } .stats { margin-left: 0; } h1 { font-size: 28px; } }
.tablewrap { overflow-x: auto; margin: 0 -8px; }
table { border-collapse: separate; border-spacing: 0; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align:left; vertical-align:top; padding: 11px 10px; border-bottom:1px solid var(--glass-line); }
tbody tr:last-child td { border-bottom: 0; }
th { color: var(--mute); font-weight: 600; font-size: 12px; letter-spacing: .01em; }
td.num, th.num { text-align:right; white-space:nowrap; } td.obj { max-width: 30ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
td.ev { min-width: 24ch; max-width: 40ch; overflow-wrap:anywhere; color: var(--mute); } td.ev code { color: var(--fg); }
td.head { white-space:nowrap; } td.model { overflow-wrap:anywhere; max-width: 26ch; }
tbody tr.w { cursor: pointer; transition: background .15s; } tbody tr.w:hover td { background: var(--hover); } tbody tr.w.sel td { background: var(--sel); }
tbody tr.w td:first-child { border-radius: 14px 0 0 14px; } tbody tr.w td:last-child { border-radius: 0 14px 14px 0; }
small { color: var(--mute); font-size: 12px; } td:first-child small { white-space: nowrap; }
.pill { display:inline-block; padding: 3px 11px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space:nowrap; line-height: 1.4;
  box-shadow: 0 1px 0 rgba(255,255,255,.35) inset; }
.s-running { color: var(--blue); background: var(--blue-bg); } .s-succeeded { color: var(--green); background: var(--green-bg); }
.s-failed, .s-unknown { color: var(--red); background: var(--red-bg); } .s-idle, .s-interrupted, .s-queued { color: var(--amber); background: var(--amber-bg); }
.s-stopped { color: var(--gray); background: var(--gray-bg); }
.tools { display:flex; gap: 10px; align-items:center; flex-wrap:wrap; margin: 0 0 14px; }
.seg { display:inline-flex; background: var(--hover); border: 1px solid var(--glass-line); border-radius: 999px; padding: 3px; gap: 2px; }
.seg button { border: 0; background: transparent; color: var(--mute); font: inherit; font-size: 13px; font-weight: 600; padding: 6px 14px; border-radius: 999px; cursor: pointer; transition: background .15s, color .15s; }
.seg button.on { background: var(--glass-strong); color: var(--fg); box-shadow: 0 1px 0 rgba(255,255,255,.6) inset, 0 2px 8px rgba(0,0,0,.12); }
input[type=search] { font: inherit; color: inherit; background: var(--hover); border: 1px solid var(--glass-line); border-radius: 999px; padding: 7px 14px; flex: 1 1 18ch; max-width: 36ch; outline: none; }
input[type=search]:focus { border-color: var(--blue); box-shadow: 0 0 0 4px var(--blue-bg); }
button.plain { font: inherit; font-size: 13px; font-weight: 600; color: var(--blue); background: var(--blue-bg); border: 1px solid transparent; border-radius: 999px; padding: 6px 14px; cursor: pointer; }
button.plain:hover { filter: brightness(1.05); }
canvas { width: 100%; height: 200px; display:block; }
#events { max-height: 24rem; overflow: auto; font-size: 13px; }
#events div { display:grid; grid-template-columns: 7ch 11ch 12ch 1fr; gap: 12px; padding: 8px 6px; border-bottom: 1px solid var(--glass-line); overflow-wrap: anywhere; }
#events div:last-child { border-bottom: 0; }
#events .t { color: var(--mute); font-variant-numeric: tabular-nums; } #events .k { font-weight: 600; } #events .w { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; color: var(--mute); }
#events .red { color: var(--red); } #events .green { color: var(--green); }
#drawer { position: fixed; top: 14px; right: 14px; bottom: 14px; width: min(540px, calc(100vw - 28px)); border-radius: 30px;
  background: var(--glass-strong); -webkit-backdrop-filter: blur(40px) saturate(200%); backdrop-filter: blur(40px) saturate(200%); border: 1px solid var(--glass-edge);
  box-shadow: 0 1px 0 rgba(255,255,255,.5) inset, 0 30px 80px rgba(0,0,0,.28); padding: 24px 26px; overflow:auto;
  transform: translateX(calc(100% + 28px)) scale(.98); opacity: 0; transition: transform .28s cubic-bezier(.2,.9,.2,1), opacity .2s; z-index: 5; }
#drawer.open { transform: none; opacity: 1; }
#drawer .top { display:flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 8px; }
#drawer .top h2 { font-size: 22px; margin: 0; font-weight: 700; text-transform: none; letter-spacing: 0; color: var(--fg); }
#drawer h2 { font-size: 12px; font-weight: 600; color: var(--mute); text-transform: uppercase; letter-spacing: .07em; margin: 22px 0 8px; }
#dsub { color: var(--mute); font-size: 13px; margin-bottom: 4px; }
#drawer pre { background: var(--hover); border: 1px solid var(--glass-line); padding: 12px 14px; border-radius: 16px; overflow:auto; max-height: 14rem; font-size: 12.5px; white-space: pre-wrap; margin: 0; }
#drawer .ok { color: var(--green); } #drawer .no { color: var(--red); } .kv { color: var(--mute); } .kv b { color: var(--fg); font-weight: 600; }
#dev div { padding: 9px 0; border-bottom: 1px solid var(--glass-line); } #dev div:last-child { border-bottom: 0; }
a { color: var(--blue); text-decoration: none; } a:hover { text-decoration: underline; }
footer { margin-top: 8px; color: var(--mute); font-size: 12px; text-align: center; }
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
  $('barfill').style.width = pct + '%'; $('bar').className = 'bar' + (pct >= 90 ? ' hot' : (run.aboveSoftCap ? ' warn' : ''));
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
  var fg = getComputedStyle(document.body).color; g.font = '11px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, sans-serif'; g.fillStyle = fg; g.strokeStyle = fg;
  var pts = (state && state.spendSeries || []).map(function (p) { return { t: Date.parse(p.at), y: Number(p.spendUsd) || 0 }; }).filter(function (p) { return isFinite(p.t); });
  var cap = state ? state.run.spendCapUsd : 0;
  if (pts.length < 2) { g.globalAlpha = .55; g.fillText(pts.length ? 'collecting...' : 'no spend yet', 8, 14); g.globalAlpha = 1; return; }
  var t0 = pts[0].t, t1 = pts[pts.length - 1].t, ymax = Math.max(cap > 0 ? cap : 0, pts.reduce(function (m, p) { return Math.max(m, p.y); }, 0)) || 1;
  var L = 8, R = 8, T = 8, B = 16, X = function (t) { return L + (W - L - R) * (t1 > t0 ? (t - t0) / (t1 - t0) : 0); }, Y = function (y) { return T + (H - T - B) * (1 - y / ymax); };
  g.lineWidth = 2; g.lineJoin = 'round'; g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--blue').trim() || '#0071e3'; g.beginPath();
  pts.forEach(function (p, i) { i ? g.lineTo(X(p.t), Y(p.y)) : g.moveTo(X(p.t), Y(p.y)); }); g.stroke();
  if (cap > 0) { g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--red').trim() || '#ff3b30'; g.setLineDash([4, 4]); g.lineWidth = 1; g.beginPath(); g.moveTo(L, Y(cap)); g.lineTo(W - R, Y(cap)); g.stroke(); g.setLineDash([]); }
  g.globalAlpha = .7; g.fillText(fmtUsd(ymax), L, T + 9); g.fillText(fmtUsd(0), L, H - B - 2);
  g.fillText(tod(t0), L, H - 4); var e = tod(t1); g.fillText(e, W - R - g.measureText(e).width, H - 4); g.globalAlpha = 1;
}
function renderEvents() {
  var box = $('events'); box.textContent = '';
  if (!events.length) { add(box, el('small', null, 'no events yet')); return; }
  events.forEach(function (ev) {
    var cls = ev.kind === 'tool.refused' || ev.kind === 'error' ? 'red' : ev.kind === 'result' ? 'green' : '';
    add(box, add(el('div', cls), el('span', 't', tod(ev.at)), el('span', 'w', ev.workerId), el('span', 'k', ev.kind), el('span', null, summarize(ev.kind, ev.data))));
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
<script>(function(){var m=/[?&]theme=(dark|light)/.exec(location.search);if(m)document.documentElement.setAttribute('data-theme',m[1]);})();</script>
</head>
<body>
<header><h1><span class="live" id="dot"></span>Helm <span id="conn">disconnected</span></h1>
<div class="stats">
<div class="stat"><span class="l">Spend</span><span class="v"><b id="spend">-</b><span id="cap"></span></span><span class="bar" id="bar"><i id="barfill"></i></span></div>
<div class="stat"><span class="l">Workers</span><span class="v"><b id="active">-</b> <span>/ <span id="max">-</span> active</span></span></div>
<div class="stat"><span class="l">Unknown cost</span><span class="v"><b id="unk">-</b> <span>events</span></span></div>
<div class="stat"><span class="l">Observed</span><span class="v"><span id="observed">-</span></span></div>
</div></header>
<section class="card">
<h2>Workers</h2>
<div class="tools"><div class="seg"><button class="on" data-f="all">All</button><button data-f="active">Active</button><button data-f="done">Done</button><button data-f="failed">Failed</button></div>
<input id="q" type="search" placeholder="Filter by id, model or objective" autocomplete="off"></div>
<div class="tablewrap"><table><thead><tr><th>Worker</th><th>State</th><th>Role</th><th>Model</th><th class="num">Spend</th><th class="num">Tokens</th><th class="num">Elapsed</th><th>Head</th><th>Objective</th><th>Last event</th></tr></thead>
<tbody id="wbody"><tr><td colspan="10"><small>loading...</small></td></tr></tbody></table></div>
</section>
<div class="grid2">
<section class="card">
<h2>Models</h2>
<table><thead><tr><th>Model</th><th class="num">Workers</th><th class="num">Active</th><th class="num">Spend</th><th class="num">Tokens</th></tr></thead>
<tbody id="mbody"><tr><td colspan="5"><small>loading...</small></td></tr></tbody></table>
</section>
<section class="card">
<h2>Spend</h2>
<canvas id="chart"></canvas>
</section>
</div>
<section class="card">
<h2>Live events</h2>
<div id="events"><small>waiting for events...</small></div>
</section>
<footer>Read only &middot; JSON at <code>/api/state</code> &middot; tools over MCP at <code>/mcp</code></footer>
<div id="drawer"><div class="top"><h2 id="dtitle" class="mono">worker</h2><button id="close" class="plain" title="Esc">Close</button></div>
<div id="dsub"></div><div id="dbody"></div></div>
<script>${JS}</script>
</body></html>`;
}
