/** Deterministic portfolio snapshots and local-day webhook delivery. */
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
    const stateAt = (w: typeof workers[number]) => String((store.sql.prepare("SELECT at FROM events WHERE workerId=? AND kind='state' AND json_extract(data,'$.to')=? ORDER BY seq DESC LIMIT 1").get(w.workerId, w.state) as Row | undefined)?.at ?? w.updatedAt);
    const stuck = workers.filter((w) => w.repoSlug === project && ['idle', 'waiting', 'failed'].includes(w.state) && now.getTime() - Date.parse(stateAt(w)) > 7_200_000).map((w) => ({ workerId: w.workerId, state: w.state }));
    const inbox = has(store, 'inbox') ? Number((store.sql.prepare("SELECT COUNT(*) AS n FROM inbox WHERE project=? AND state='open'").get(project) as Row).n) : 0;
    const budget = budgets.find((b) => b.project === project && b.closedAt === null);
    return { project, usd: score.usd, codexTokens: score.codexTokens, budget: budget ? { usd: budget.spentUsd, capUsd: budget.capUsd, codexTokens: budget.spentCodexTokens, capCodexTokens: budget.capCodexTokens } : null, merged: score.merged, cleanRate: outcomes.n ? outcomes.clean / outcomes.n : 0, firstPassGateRate: score.firstPassGateRate, openPrs, stuck, inbox, taps: score.taps };
  }));
  const total = rows.reduce((a, r) => ({ usd: a.usd + r.usd, codexTokens: a.codexTokens + r.codexTokens, merged: a.merged + r.merged, openPrs: a.openPrs + r.openPrs.length, stuck: a.stuck + r.stuck.length, inbox: a.inbox + r.inbox, taps: a.taps + r.taps }), { usd: 0, codexTokens: 0, merged: 0, openPrs: 0, stuck: 0, inbox: 0, taps: 0 });
  return { since, until: now.toISOString(), projects: rows, total };
}
export function formatPortfolio(report: Awaited<ReturnType<typeof portfolio>>): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`; const money = (n: number) => `$${n.toFixed(2)}`;
  const lines = [`Portfolio ${report.since} .. ${report.until}`];
  for (const r of report.projects) {
    lines.push(r.project.replace(/[\r\n]/g, ' '), `  Window: ${money(r.usd)}; Codex ${r.codexTokens} tokens`,
      r.budget ? `  Budget: ${money(r.budget.usd)}/${money(r.budget.capUsd)}; Codex ${r.budget.codexTokens}/${r.budget.capCodexTokens ?? 'uncapped'} tokens` : '  Budget: none',
      `  Merged ${r.merged}; clean ${pct(r.cleanRate)}; first-pass gate ${pct(r.firstPassGateRate)}`,
      `  PRs ${r.openPrs.length} (${r.openPrs.filter((p) => p.waiting === 'review').length} review, ${r.openPrs.filter((p) => p.waiting === 'merge').length} merge); stuck >2h ${r.stuck.length}; inbox ${r.inbox}; taps ${r.taps}`);
  }
  const t = report.total; lines.push(`Fleet: ${money(t.usd)}; Codex ${t.codexTokens} tokens; merged ${t.merged}; PRs ${t.openPrs}; stuck ${t.stuck}; inbox ${t.inbox}; taps ${t.taps}`);
  return lines.join('\n');
}
/** Bound a single Discord message, retaining the fleet total and a truncation marker. */
export function reportContent(text: string): string {
  if (text.length <= 2000) return text;
  const tail = `\n… report truncated\n${text.split('\n').at(-1)!.slice(0, 500)}`;
  const prefix = text.slice(0, 2000 - tail.length); const end = prefix.lastIndexOf('\n');
  return `${end > 0 ? prefix.slice(0, end) : prefix.replace(/[\uD800-\uDBFF]$/, '')}${tail}`;
}
export function createReportTicker(options: { store: Store; home: string; settings?: Settings; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => Date }) {
  const { store } = options; let sending = false;
  store.sql.exec('CREATE TABLE IF NOT EXISTS portfolio_report (id INTEGER PRIMARY KEY CHECK(id=1), lastSentDate TEXT NOT NULL)');
  return async () => {
    if (sending) return;
    const settings = options.settings ?? loadSettings(options.home);
    const env = { ...loadEnvFile(join(homedir(), '.config', 'helm', 'env')), ...process.env, ...options.env };
    const fallback = Object.values(settings.discord.projects)[0]?.webhookEnv;
    const url = (settings.report?.webhookEnv ? env[settings.report.webhookEnv]?.trim() : undefined) || (fallback ? env[fallback]?.trim() : undefined);
    if (!url) return;
    const now = options.now?.() ?? new Date(); const at = settings.report?.at ?? '06:00';
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const [hour = 6, minute = 0] = at.split(':').map(Number);
    if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return;
    const last = store.sql.prepare('SELECT lastSentDate FROM portfolio_report WHERE id=1').get() as Row | undefined;
    if (last?.lastSentDate === localDate) return;
    sending = true;
    try {
      const content = reportContent(formatPortfolio(await portfolio(store, settings, undefined, now)));
      const response = await (options.fetch ?? globalThis.fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15_000) });
      if (response.ok) store.sql.prepare('INSERT INTO portfolio_report VALUES (1,?) ON CONFLICT(id) DO UPDATE SET lastSentDate=excluded.lastSentDate').run(localDate);
    } catch { /* Retry on the next tick; never log webhook credentials. */ }
    finally { sending = false; }
  };
}
