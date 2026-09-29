/** Mechanical sprint scorecards. Queries are deliberately read-only; memory owns persistence. */
import { z } from 'zod';
import { consumer } from './daemon.js';
import type { MemoryService } from './memory.js';
import type { Store, ToolOutcome } from './types.js';

const isoDate = z.string().min(1).refine((value) => {
  const shape = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
  return shape.test(value) && !Number.isNaN(Date.parse(value));
}, 'since must be an ISO date');
export const scorecardExportInput = z.object({ project: z.string().min(1), budgetId: z.string().min(1).optional(), since: isoDate.optional() }).strict();
export type ScorecardExportInput = z.infer<typeof scorecardExportInput>;
export type ScorecardJson = Readonly<{
  project: string;
  window: Readonly<{ budgetId?: string; label?: string; since?: string; openedAt?: string; closedAt?: string }>;
  tickets: number; merged: number; firstPassGateRate: number; claimsPassRate: number; firstReviewApprovalRate: number;
  retriesPerTicket: Readonly<Record<string, number>>;
  activeMinutes: number; codexTokens: number; usd: number; jevCalls: number; jevCost: number | null;
  deploys: number; rollbacks: number; taps: number;
  outcomes: ReadonlyArray<Readonly<{ model: string; band: string; clean: number; rework: number; failed: number }>>;
}>;
export type ScorecardService = Readonly<{
  export(input: ScorecardExportInput): Promise<ToolOutcome<{ markdown: string; json: ScorecardJson }>>;
  consume(): Promise<void>;
}>;

type Row = Record<string, unknown>;
type MutableScorecard = { -readonly [K in keyof ScorecardJson]: ScorecardJson[K] };
type Worker = { workerId: string; issue: number | null; role: string; model: string; band: string; state: string; createdAt: string };
type OutcomeKind = 'clean' | 'rework' | 'failed';
const n = (value: unknown): number => Number(value ?? 0);
const rate = (yes: number, total: number): number => total ? Math.round((yes / total) * 10000) / 10000 : 0;
const round = (value: number): number => Math.round(value * 100) / 100;
const hasTable = (store: Store, name: string): boolean => Boolean(store.sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const columns = (store: Store, name: string): Set<string> => new Set((store.sql.prepare(`PRAGMA table_info(${name})`).all() as Row[]).map((row) => String(row.name)));
const redactError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b(?:api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .slice(0, 1000);
};

function between(column: string, from?: string, to?: string): { sql: string; args: string[] } {
  const clauses: string[] = []; const args: string[] = [];
  if (from) { clauses.push(`${column} >= ?`); args.push(from); }
  if (to) { clauses.push(`${column} <= ?`); args.push(to); }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', args };
}

function classifyOutcome(input: { later: boolean; state: string; failedGate: boolean; requestChanges: boolean; turns: number }): OutcomeKind {
  if (input.later || ['failed', 'stopped', 'unknown'].includes(input.state)) return 'failed';
  if (input.failedGate || input.requestChanges || input.turns > 1) return 'rework';
  return 'clean';
}

export function cleanRateForRouting(store: Store, model: string, band: string, now = new Date(), project?: string): { clean: number; n: number } {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const projectSql = project ? ' AND w.repoSlug=?' : '';
  const workers = store.sql.prepare(`SELECT w.workerId,w.state,w.createdAt,wm.issue FROM workers w JOIN worker_meta wm ON wm.workerId=w.workerId WHERE w.role='builder' AND wm.issue IS NOT NULL AND w.model=? AND wm.band=? AND w.createdAt>=?${projectSql}`).all(model, band, since, ...(project ? [project] : [])) as Row[];
  const projectWorkers = store.sql.prepare(`SELECT w.workerId,w.createdAt,wm.issue FROM workers w JOIN worker_meta wm ON wm.workerId=w.workerId WHERE w.role='builder' AND wm.issue IS NOT NULL${projectSql}`).all(...(project ? [project] : [])) as Row[];
  const reviews = hasTable(store, 'reviews') && hasTable(store, 'prs') ? store.sql.prepare("SELECT p.workerId,r.verdict FROM reviews r JOIN prs p ON p.number=r.number").all() as Row[] : [];
  let clean = 0;
  for (const worker of workers) {
    const workerId = String(worker.workerId);
    const issue = worker.issue === null || worker.issue === undefined ? undefined : n(worker.issue);
    const later = issue !== undefined && projectWorkers.some((row) => n(row.issue) === issue && String(row.createdAt) > String(worker.createdAt));
    const turns = n((store.sql.prepare("SELECT COUNT(*) AS count FROM events WHERE workerId=? AND kind='turn.start'").get(workerId) as Row | undefined)?.count);
    const failedGate = Boolean(store.sql.prepare('SELECT 1 FROM gates WHERE workerId=? AND passed=0 LIMIT 1').get(workerId));
    const requestChanges = reviews.some((row) => String(row.workerId) === workerId && (row.verdict === 'changes' || row.verdict === 'disputed'));
    if (classifyOutcome({ later, state: String(worker.state), failedGate, requestChanges, turns }) === 'clean') clean += 1;
  }
  return { clean, n: workers.length };
}

function markdown(json: ScorecardJson): string {
  const label = json.window.label ?? json.window.since ?? 'all';
  const window = [json.window.openedAt ?? json.window.since, json.window.closedAt].filter(Boolean).join(' .. ') || 'all recorded data';
  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  const lines = [
    `# Scorecard ${json.project} — ${label}`,
    '', `Window: ${window}`, '', '## Delivery', '',
    '| Metric | Value |', '| --- | ---: |',
    `| Tickets | ${json.tickets} |`, `| Merged | ${json.merged} |`,
    `| First-pass gate rate | ${pct(json.firstPassGateRate)} |`, `| Claims pass rate | ${pct(json.claimsPassRate)} |`,
    `| First-review approval rate | ${pct(json.firstReviewApprovalRate)} |`, `| Active minutes | ${json.activeMinutes} |`,
    `| Codex tokens | ${json.codexTokens} |`, `| USD | ${json.usd.toFixed(4)} |`,
    `| Jev calls | ${json.jevCalls} |`, `| Jev cost | ${json.jevCost === null ? 'n/a (not recorded)' : json.jevCost.toFixed(4)} |`,
    `| Deploys | ${json.deploys} |`, `| Rollbacks | ${json.rollbacks} |`, `| Taps | ${json.taps} |`,
    '', '## Retries per ticket', '', '| Kind | Retries per ticket |', '| --- | ---: |',
  ];
  for (const [kind, count] of Object.entries(json.retriesPerTicket)) lines.push(`| ${kind} | ${count.toFixed(4)} |`);
  lines.push('', '## Model × complexity band', '', '| Model | Band | Clean | Rework | Failed |', '| --- | --- | ---: | ---: | ---: |');
  for (const outcome of json.outcomes) lines.push(`| ${outcome.model} | ${outcome.band} | ${outcome.clean} | ${outcome.rework} | ${outcome.failed} |`);
  return `${lines.join('\n')}\n`;
}

export function createScorecard(options: { store: Store; memory: MemoryService; now?: () => Date }): ScorecardService {
  const { store, memory } = options; const now = options.now ?? (() => new Date());
  async function exportScorecard(input: ScorecardExportInput): Promise<ToolOutcome<{ markdown: string; json: ScorecardJson }>> {
    if (input.since && !scorecardExportInput.safeParse(input).success) return { ok: false, reason: 'since must be an ISO date' };
    const budget = input.budgetId ? store.sql.prepare('SELECT * FROM budgets WHERE id = ?').get(input.budgetId) as Row | undefined : undefined;
    if (input.budgetId && !budget) return { ok: false, reason: `budget not found: ${input.budgetId}` };
    if (budget && String(budget.project) !== input.project) return { ok: false, reason: `budget ${input.budgetId} belongs to ${String(budget.project)}` };
    const from = budget ? String(budget.openedAt) : input.since; const to = budget ? (budget.closedAt ? String(budget.closedAt) : now().toISOString()) : undefined;
    const budgetWorkers = input.budgetId ? (store.sql.prepare('SELECT workerId FROM worker_budget WHERE budgetId = ?').all(input.budgetId) as Row[]).map((row) => String(row.workerId)) : [];
    const workerRows = (input.budgetId ? budgetWorkers.length ? store.sql.prepare(`SELECT w.workerId,w.role,w.model,w.state,w.createdAt,wm.issue,wm.band FROM workers w LEFT JOIN worker_meta wm ON wm.workerId=w.workerId WHERE w.workerId IN (${budgetWorkers.map(() => '?').join(',')}) ORDER BY w.createdAt,w.workerId`).all(...budgetWorkers) : [] : store.sql.prepare(`SELECT w.workerId,w.role,w.model,w.state,w.createdAt,wm.issue,wm.band FROM workers w LEFT JOIN worker_meta wm ON wm.workerId=w.workerId WHERE w.repoSlug = ?${from ? ' AND w.createdAt >= ?' : ''} ORDER BY w.createdAt,w.workerId`).all(input.project, ...(from ? [from] : []))) as Row[];
    const workers: Worker[] = workerRows.map((row) => ({ workerId: String(row.workerId), issue: row.issue === null || row.issue === undefined ? null : n(row.issue), role: String(row.role), model: String(row.model), band: String(row.band || 'unbanded'), state: String(row.state), createdAt: String(row.createdAt) }));
    const ids = workers.map((worker) => worker.workerId); const inList = ids.map(() => '?').join(',');
    const empty = (): ScorecardJson => ({ project: input.project, window: { ...(input.budgetId ? { budgetId: input.budgetId } : {}), ...(budget ? { label: String(budget.label), openedAt: String(budget.openedAt), ...(budget.closedAt ? { closedAt: String(budget.closedAt) } : {}) } : input.since ? { since: input.since } : {}) }, tickets: 0, merged: 0, firstPassGateRate: 0, claimsPassRate: 0, firstReviewApprovalRate: 0, retriesPerTicket: {}, activeMinutes: 0, codexTokens: 0, usd: 0, jevCalls: 0, jevCost: null, deploys: 0, rollbacks: 0, taps: 0, outcomes: [] });
    const json = empty() as MutableScorecard;
    if (ids.length) {
      const args = [...ids]; const eventWindow = between('e.at', from, to); const events: Row[] = (store.sql.prepare(`SELECT e.* FROM events e WHERE e.workerId IN (${inList})${eventWindow.sql} ORDER BY e.at,e.seq`).all(...args, ...eventWindow.args) as Row[]).map((row): Row => ({ ...row, data: row.data ? JSON.parse(String(row.data)) as Row : {} }));
      const builders = workers.filter((worker) => worker.role === 'builder' && worker.issue !== null);
      const firstByIssue = new Map<number, Worker>(); for (const worker of builders) if (!firstByIssue.has(worker.issue!)) firstByIssue.set(worker.issue!, worker);
      json.tickets = firstByIssue.size;
      json.merged = new Set(events.filter((event) => event.kind === 'pr.merged').map((event) => firstByIssue.get(workers.find((worker) => worker.workerId === String(event.workerId))?.issue ?? -1)?.issue).filter((issue): issue is number => issue !== undefined)).size;
      const firstGateRows = store.sql.prepare(`SELECT g.workerId,g.passed,g.at FROM gates g WHERE g.workerId IN (${inList})${between('g.at', from, to).sql} ORDER BY g.at,g.gateId`).all(...args, ...between('g.at', from, to).args) as Row[];
      const firstGates = new Map<string, Row>(); for (const row of firstGateRows) if (!firstGates.has(String(row.workerId))) firstGates.set(String(row.workerId), row);
      json.firstPassGateRate = rate([...firstGates.values()].filter((row) => Boolean(row.passed)).length, firstGates.size);
      const claimRows = hasTable(store, 'claims_checks') ? store.sql.prepare(`SELECT c.* FROM claims_checks c WHERE c.workerId IN (${inList})${between('c.at', from, to).sql} ORDER BY c.at DESC`).all(...args, ...between('c.at', from, to).args) as Row[] : [];
      const claims = new Map<string, Row>(); for (const row of claimRows) if (!claims.has(String(row.workerId))) claims.set(String(row.workerId), row);
      json.claimsPassRate = rate([...claims.values()].filter((row) => Boolean(row.passed)).length, claims.size);
      const reviews = hasTable(store, 'reviews') ? store.sql.prepare(`SELECT r.*,p.workerId FROM reviews r JOIN prs p ON p.number=r.number JOIN workers pw ON pw.workerId=p.workerId AND pw.repoSlug=r.repoSlug WHERE p.workerId IN (${inList})${between('r.at', from, to).sql} ORDER BY r.at,r.id`).all(...args, ...between('r.at', from, to).args) as Row[] : [];
      const firstReviews = new Map<number, Row>(); for (const row of reviews) if (!firstReviews.has(n(row.number))) firstReviews.set(n(row.number), row); json.firstReviewApprovalRate = rate([...firstReviews.values()].filter((row) => row.verdict === 'approve').length, firstReviews.size);
      const retryRows = hasTable(store, 'retries') ? store.sql.prepare(`SELECT r.kind,COUNT(*) AS count FROM retries r WHERE r.workerId IN (${inList})${between('r.at', from, to).sql} GROUP BY r.kind ORDER BY r.kind`).all(...args, ...between('r.at', from, to).args) as Row[] : [];
      json.retriesPerTicket = Object.fromEntries(retryRows.map((row) => [String(row.kind), Math.round((n(row.count) / Math.max(json.tickets, 1)) * 10000) / 10000]));
      const starts = new Map<string, number>(); let active = 0; for (const event of events) { if (event.kind === 'turn.start') starts.set(String(event.workerId), Date.parse(String(event.at))); if (event.kind === 'turn.end' && starts.has(String(event.workerId))) { active += Math.max(0, Date.parse(String(event.at)) - starts.get(String(event.workerId))!); starts.delete(String(event.workerId)); } } json.activeMinutes = round(active / 60_000);
      const spend = store.sql.prepare(`SELECT COALESCE(SUM(CASE WHEN model LIKE 'codex/%' THEN inputTokens+outputTokens ELSE 0 END),0) AS tokens,COALESCE(SUM(CASE WHEN costUsd IS NULL THEN 0 ELSE costUsd END),0) AS usd FROM spend WHERE workerId IN (${inList})${between('at', from, to).sql}`).get(...args, ...between('at', from, to).args) as Row; json.codexTokens = n(spend.tokens); json.usd = n(spend.usd);
      const jev = hasTable(store, 'jev_calls'); const jevCols = jev ? columns(store, 'jev_calls') : new Set<string>(); const jevCost = jevCols.has('costUsd') ? ',SUM(costUsd) AS cost' : jevCols.has('cost') ? ',SUM(cost) AS cost' : ',NULL AS cost'; const jevRows = jev ? store.sql.prepare(`SELECT COUNT(*) AS count${jevCost} FROM jev_calls j WHERE (j.workerId IN (${inList}) OR (j.project = ? AND j.workerId IS NULL))${between('j.at', from, to).sql}`).get(...args, input.project, ...between('j.at', from, to).args) as Row : {}; json.jevCalls = n(jevRows.count); json.jevCost = jevRows.cost === null || jevRows.cost === undefined ? null : n(jevRows.cost);
      const outcomeMap = new Map<string, { model: string; band: string; clean: number; rework: number; failed: number }>(); const projectWorkers = (store.sql.prepare("SELECT w.workerId,w.createdAt,wm.issue FROM workers w JOIN worker_meta wm ON wm.workerId=w.workerId WHERE w.repoSlug=? AND w.role='builder'").all(input.project) as Row[]);
      for (const worker of builders) { const later = projectWorkers.some((row) => n(row.issue) === worker.issue && String(row.createdAt) > worker.createdAt); const workerEvents = events.filter((event) => String(event.workerId) === worker.workerId); const turns = workerEvents.filter((event) => event.kind === 'turn.start').length; const failedGate = firstGateRows.some((row) => String(row.workerId) === worker.workerId && !Boolean(row.passed)); const requestChanges = reviews.some((row) => String(row.workerId) === worker.workerId && (row.verdict === 'changes' || row.verdict === 'disputed')); const kind = classifyOutcome({ later, state: worker.state, failedGate, requestChanges, turns }); const key = `${worker.model}\u0000${worker.band}`; const value = outcomeMap.get(key) ?? { model: worker.model, band: worker.band, clean: 0, rework: 0, failed: 0 }; value[kind]++; outcomeMap.set(key, value); }
      json.outcomes = [...outcomeMap.values()].sort((a, b) => a.model.localeCompare(b.model) || a.band.localeCompare(b.band));
    }
    const projectWindow = between('at', from, to); if (hasTable(store, 'deploys')) { const rows = store.sql.prepare(`SELECT id,state,at FROM deploys WHERE project=?${projectWindow.sql}`).all(input.project, ...projectWindow.args) as Row[]; json.deploys = rows.length; json.rollbacks = rows.filter((row) => String(row.state).toLowerCase() === 'rolledback').length; } if (hasTable(store, 'taps')) json.taps = (store.sql.prepare(`SELECT COUNT(*) AS count FROM taps WHERE project=?${between('requestedAt', from, to).sql}`).get(input.project, ...between('requestedAt', from, to).args) as Row).count as number;
    const result = { markdown: markdown(json), json }; const label = json.window.label ?? input.since ?? 'all'; const title = `Scorecard ${label}${input.budgetId ? ` ${input.budgetId}` : ''}`; const saved = await memory.write({ scope: 'project', project: input.project, type: 'scorecard', title, summary: `${json.tickets} tickets; ${json.merged} merged`, truth: result.markdown }); if (!saved.ok) return saved; return { ok: true, ...result };
  }
  const consume = consumer(store, 'scorecard-export', async (events) => { for (const event of events.filter((candidate) => candidate.kind === 'budget.closed')) { const project = typeof event.data.project === 'string' ? event.data.project : event.workerId.replace(/^project:/, ''); const budgetId = typeof event.data.budgetId === 'string' ? event.data.budgetId : undefined; if (!project) continue; try { const result = await exportScorecard({ project, ...(budgetId ? { budgetId } : {}) }); if (!result.ok) throw new Error(result.reason); } catch (error) { store.appendEvent(event.workerId, 'scorecard.failed', { project, ...(budgetId ? { budgetId } : {}), error: redactError(error) }); } } });
  return { export: exportScorecard, consume };
}
