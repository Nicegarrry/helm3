/** Deterministic portfolio snapshots and local-day webhook delivery. */
import { appendFileSync } from 'node:fs';
import { startTicker } from './daemon.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listBudgetStatuses } from './budget.js';
import { createScorecard, scorecardExportInput } from './scorecard.js';
import { loadEnvFile, loadSettings, type Settings } from './settings.js';
import type { Store } from './types.js';
type Row = Record<string, unknown>;
const has = (store: Store, table: string) => Boolean(store.sql.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(table));
export async function portfolio(store: Store, settings: Settings, since?: string, now = new Date()) {
  if (since && !scorecardExportInput.safeParse({ project: 'portfolio', since }).success) throw new Error('since must be an ISO date');
  since = since ? new Date(since).toISOString() : new Date(now.getTime() - 86_400_000).toISOString();
  const workers = store.listWorkers(); const prs = store.listPrs(); const budgets = listBudgetStatuses(store);
  const projects = new Set([...workers.map((w) => w.repoSlug), ...prs.map((p) => p.repoSlug), ...budgets.map((b) => b.project), ...Object.keys(settings.discord.projects)]);
  for (const table of ['supervisors', 'inbox', 'taps']) if (has(store, table)) for (const row of store.sql.prepare(`SELECT DISTINCT project FROM ${table}`).all() as Row[]) projects.add(String(row.project));
  const scorecard = createScorecard({ store, now: () => now });
  const rows = await Promise.all([...projects].sort().map(async (project) => {
    const result = await scorecard.read({ project, since }); if (!result.ok) throw new Error(result.reason);
    const score = result.json; const outcomes = score.outcomes.reduce((a, o) => ({ clean: a.clean + o.clean, n: a.n + o.clean + o.rework + o.failed }), { clean: 0, n: 0 });
    const openPrs = prs.filter((p) => p.repoSlug === project && (p.state === 'open' || p.state === null)).map((p) => {
      const approved = has(store, 'reviews') && store.sql.prepare("SELECT verdict FROM reviews WHERE repoSlug=? AND number=? AND head=? ORDER BY at DESC,id DESC LIMIT 1").get(project, p.number, p.head) as Row | undefined;
      return { number: p.number, waiting: approved && approved.verdict === 'approve' ? 'merge' : 'review' };
    });
    const stateAt = (w: typeof workers[number]) => String((store.sql.prepare("SELECT at FROM events WHERE workerId=? AND kind='state' ORDER BY seq DESC LIMIT 1").get(w.workerId) as Row | undefined)?.at ?? w.updatedAt);
    const activityAt = (w: typeof workers[number]) => Math.max(Date.parse(w.updatedAt), ...[
      "SELECT MAX(at) AS at FROM events WHERE workerId=?", "SELECT MAX(at) AS at FROM spend WHERE workerId=?", "SELECT MAX(at) AS at FROM gates WHERE workerId=?", "SELECT MAX(createdAt) AS at FROM prs WHERE workerId=?",
    ].map((sql) => Date.parse(String((store.sql.prepare(sql).get(w.workerId) as Row).at ?? w.updatedAt))));
    const stuck = workers.filter((w) => {
      if (w.repoSlug !== project) return false;
      if (['waiting', 'running', 'queued'].includes(w.state)) return now.getTime() - Date.parse(stateAt(w)) > 7_200_000;
      return w.state === 'idle' && w.role === 'builder' && prs.some((p) => p.workerId === w.workerId && p.repoSlug === project && (p.state === 'open' || p.state === null)) && now.getTime() - activityAt(w) > 7_200_000;
    }).map((w) => ({ workerId: w.workerId, state: w.state }));
    const inbox = has(store, 'inbox') ? Number((store.sql.prepare("SELECT COUNT(*) AS n FROM inbox WHERE project=? AND state='open'").get(project) as Row).n) : 0;
    const budget = budgets.find((b) => b.project === project && b.closedAt === null);
    return { project, usd: score.usd, codexTokens: score.codexTokens, budget: budget ? { usd: budget.spentUsd, capUsd: budget.capUsd, codexTokens: budget.spentCodexTokens, capCodexTokens: budget.capCodexTokens } : null, merged: score.merged, cleanRate: outcomes.n ? outcomes.clean / outcomes.n : 0, firstPassGateRate: score.firstPassGateRate, openPrs, stuck, inbox, taps: score.taps };
  }));
  const total = rows.reduce((a, r) => ({ usd: a.usd + r.usd, codexTokens: a.codexTokens + r.codexTokens, merged: a.merged + r.merged, openPrs: a.openPrs + r.openPrs.length, stuck: a.stuck + r.stuck.length, inbox: a.inbox + r.inbox, taps: a.taps + r.taps }), { usd: 0, codexTokens: 0, merged: 0, openPrs: 0, stuck: 0, inbox: 0, taps: 0 });
  return { since, until: now.toISOString(), projects: rows, total };
}
const humanTokens = (n: number): string => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${+(n / 1_000).toFixed(1)}k` : `${n}`;
export function formatPortfolio(report: Awaited<ReturnType<typeof portfolio>>): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`; const money = (n: number) => `$${n.toFixed(2)}`;
  const short = (project: string) => project.split('/').pop()!.replace(/[\r\n]/g, ' ');
  const word = (n: number, one: string, many: string) => n === 1 ? one : many;
  type Row = Awaited<ReturnType<typeof portfolio>>['projects'][number];
  const active = (r: Row) => r.usd > 0 || r.codexTokens > 0 || r.merged > 0 || r.openPrs.length > 0 || r.stuck.length > 0 || r.inbox > 0 || r.taps > 0;
  const prsFact = (open: number, review: number) => open === 0 ? null : review > 0 ? `${open} ${word(open, 'PR', 'PRs')} open (${review} ${word(review, 'needs', 'need')} review)` : `${open} ${word(open, 'PR', 'PRs')} waiting merge`;
  const t = report.total;
  const day = new Date(report.until).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const lines = [`**Helm · ${day}**`];
  if (t.merged === 0 && t.openPrs === 0 && t.stuck === 0 && t.inbox === 0 && t.taps === 0 && t.usd === 0 && t.codexTokens === 0) lines.push('Nothing needs you');
  else {
    const review = report.projects.reduce((a, r) => a + r.openPrs.filter((p) => p.waiting === 'review').length, 0);
    const headline = [`${t.merged} merged`, t.openPrs ? (review ? `${t.openPrs} ${word(t.openPrs, 'PR', 'PRs')} open (${review} ${word(review, 'needs', 'need')} review)` : `${t.openPrs} ${word(t.openPrs, 'PR', 'PRs')} open`) : null, t.stuck ? `${t.stuck} stuck` : null, t.inbox ? `${t.inbox} ${word(t.inbox, 'ask', 'asks')}` : null].filter(Boolean);
    lines.push(headline.join(' · '));
  }
  const caps = report.projects.filter((r) => r.budget);
  const spend = `${money(t.usd)} spent${caps.length ? ` · ${money(caps.reduce((a, r) => a + r.budget!.capUsd, 0))} budgeted` : ''}`;
  lines.push(`${spend} · Codex ${humanTokens(t.codexTokens)} tokens`);
  const idle: string[] = [];
  const blocks = report.projects.filter(active).map((r) => {
    const review = r.openPrs.filter((p) => p.waiting === 'review').length;
    const facts = [r.merged ? `${r.merged} merged` : null, prsFact(r.openPrs.length, review), r.merged > 0 ? `${pct(r.firstPassGateRate)} gates pass first time` : null, r.stuck.length ? `${r.stuck.length} stuck` : null, r.inbox ? `${r.inbox} ${word(r.inbox, 'ask', 'asks')}` : null, r.usd > 0 ? money(r.usd) : null].filter(Boolean);
    return facts.length ? `**${short(r.project)}**: ${facts.join(', ')}` : null;
  }).filter((line): line is string => line !== null);
  for (const r of report.projects) if (!active(r)) idle.push(short(r.project));
  if (blocks.length || idle.length) { lines.push(''); lines.push(...blocks); if (idle.length) lines.push(`Idle: ${idle.join(', ')}`); }
  return lines.join('\n');
}
/** Bound a single Discord message, retaining the fleet total and a truncation marker. */
export function reportContent(text: string): string {
  if (text.length <= 2000) return text;
  const tail = `\n… report truncated\n${text.split('\n').at(-1)!.slice(0, 500)}`;
  const prefix = text.slice(0, 2000 - tail.length); const end = prefix.lastIndexOf('\n');
  return `${end > 0 ? prefix.slice(0, end) : prefix.replace(/[\uD800-\uDBFF]$/, '')}${tail}`;
}
/** Separate timers ensure a slow report POST cannot hold the Discord consumer open. */
export function startNotificationTickers(discord: () => Promise<void>, report: () => Promise<void>) {
  const discordTicker = startTicker(1000, [discord]);
  const reportTicker = startTicker(60_000, [report]);
  return { discord: discordTicker, report: reportTicker, stop() { discordTicker(); reportTicker(); } };
}
export function createReportTicker(options: { store: Store; home: string; settings?: Settings; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => Date; readSettings?: typeof loadSettings; log?: (line: string) => void }) {
  const { store } = options; let sending = false;
  let settings = options.settings; let settingsReadAt = -Infinity; let env: NodeJS.ProcessEnv = {};
  const log = options.log ?? ((line: string) => { try { appendFileSync(join(options.home, 'daemon.log'), `${line}\n`); } catch { /* logging must not break delivery */ } });
  const giveUp = (day: string) => {
    const result = store.sql.prepare('UPDATE portfolio_report SET gaveUpDate=? WHERE id=1 AND (gaveUpDate IS NULL OR gaveUpDate<>?)').run(day, day);
    if (result.changes) log(`Portfolio report abandoned for ${day} after 3 attempts`);
  };
  return async () => {
    if (sending) return;
    const now = options.now?.() ?? new Date();
    if (now.getTime() - settingsReadAt >= 60_000) {
      settings = options.settings ?? (options.readSettings ?? loadSettings)(options.home); settingsReadAt = now.getTime();
      env = { ...loadEnvFile(join(homedir(), '.config', 'helm', 'env')), ...process.env, ...options.env };
    }
    const current = settings!;
    const names = [current.report?.webhookEnv, current.discord.globalWebhookEnv, Object.values(current.discord.projects)[0]?.webhookEnv];
    const url = names.map((name) => name ? env[name]?.trim() : undefined).find(Boolean);
    if (!url) return;
    const at = current.report?.at ?? '06:00';
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const [hour = 6, minute = 0] = at.split(':').map(Number);
    if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return;
    const last = store.sql.prepare('SELECT * FROM portfolio_report WHERE id=1').get() as Row | undefined;
    if (last?.lastSentDate === localDate || last?.gaveUpDate === localDate) return;
    const attempts = last?.attemptDate === localDate ? Number(last.attempts) : 0;
    if (attempts >= 3) { giveUp(localDate); return; }
    const delay = attempts === 1 ? 5 * 60_000 : 15 * 60_000;
    if (attempts && now.getTime() - Date.parse(String(last?.lastAttemptAt)) < delay) return;
    sending = true;
    try {
      store.sql.prepare(`INSERT INTO portfolio_report (id,lastSentDate,attemptDate,lastAttemptAt,attempts) VALUES (1,'',?,?,?)
        ON CONFLICT(id) DO UPDATE SET attemptDate=excluded.attemptDate,lastAttemptAt=excluded.lastAttemptAt,attempts=excluded.attempts`).run(localDate, now.toISOString(), attempts + 1);
      const content = reportContent(formatPortfolio(await portfolio(store, current, undefined, now)));
      const response = await (options.fetch ?? globalThis.fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15_000) });
      if (response.ok) { store.sql.prepare('UPDATE portfolio_report SET lastSentDate=? WHERE id=1').run(localDate); return; }
    } catch { /* Back off without logging webhook credentials. */ }
    finally { sending = false; }
    if (attempts + 1 >= 3) giveUp(localDate);
  };
}
