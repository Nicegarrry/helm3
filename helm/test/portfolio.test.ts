import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachWorker, closeBudget, openBudget } from '../src/budget.js';
import { ensureTapTable } from '../src/envelope.js';
import { insertInbox } from '../src/inbox.js';
import { createReportTicker, formatPortfolio, portfolio, reportContent, startNotificationTickers } from '../src/portfolio.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { WorkerRow } from '../src/types.js';

const now = new Date('2026-10-01T12:00:00Z'); const old = '2026-09-28T00:00:00Z'; const recent = '2026-10-01T09:00:00Z';
function worker(id: string, project: string, state: WorkerRow['state'] = 'succeeded'): WorkerRow {
  return { workerId: id, repo: '/repo', repoSlug: project, role: 'builder', model: 'codex/luna', objective: id, acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'a', branch: id, worktree: '/repo/' + id, state, head: 'b', sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: old, updatedAt: recent };
}
function fixture(config: unknown = {}) {
  const home = mkdtempSync(join(tmpdir(), 'helm-portfolio-')); writeFileSync(join(home, 'helm.json'), JSON.stringify(config));
  const path = join(home, 'helm.sqlite'); const store = openStore(path);
  return { home, path, store, settings: loadSettings(home), close() { store.close(); rmSync(home, { recursive: true, force: true }); } };
}

test('seeded portfolio reuses scorecard activity, includes old workers, budget and current backlog in compact blocks', async () => {
  const f = fixture({ discord: { projects: { 'acme/empty': { webhookEnv: 'EMPTY' } } } });
  try {
    const budget = openBudget(f.store, { project: 'acme/one', label: 'sprint', capUsd: 10, capCodexTokens: 1000, openedAt: old });
    for (const [id, project, state] of [['clean', 'acme/one', 'succeeded'], ['rework', 'acme/one', 'succeeded'], ['failed', 'acme/two', 'failed'], ['idle', 'acme/two', 'idle'], ['waiting', 'acme/two', 'waiting']] as const) {
      f.store.insertWorker(worker(id, project, state)); f.store.setMeta(id, { issue: id === 'clean' ? 1 : id === 'rework' ? 2 : 3 });
    }
    f.store.insertWorker({ ...worker('touched', 'acme/two', 'idle'), updatedAt: '2026-10-01T11:59:00Z' }); f.store.appendEvent('touched', 'state', { to: 'idle' }, recent);
    f.store.insertWorker({ ...worker('boundary', 'acme/two', 'idle'), updatedAt: '2026-10-01T10:00:00Z' });
    for (const [id, passed] of [['clean', true], ['rework', false]] as const) { f.store.insertGate({ gateId: id, workerId: id, head: 'b', passed, checks: [], at: recent }); attachWorker(f.store, id, budget.id); }
    f.store.appendEvent('clean', 'pr.merged', {}, recent); f.store.appendEvent('clean', 'pr.merged', {}, recent);
    f.store.addSpend({ workerId: 'clean', model: 'codex/luna', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, at: recent });
    f.store.addSpend({ workerId: 'rework', model: 'pi/paid', inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 2, at: recent });
    f.store.addSpend({ workerId: 'rework', model: 'pi/paid', inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 3, at: old });
    for (const [number, state] of [[1, 'open'], [2, 'open'], [3, 'merged'], [4, 'closed']] as const) f.store.insertPr({ repoSlug: 'acme/one', workerId: 'clean', number, head: 'b', state, url: 'https://pr/' + number, createdAt: old });
    f.store.sql.exec('CREATE TABLE reviews (id INTEGER PRIMARY KEY,repoSlug TEXT,number INTEGER,head TEXT,verdict TEXT,at TEXT)');
    f.store.sql.prepare('INSERT INTO reviews VALUES (1,?,?,?,?,?)').run('acme/one', 2, 'b', 'approve', recent);
    insertInbox(f.store.sql, { id: 'q', project: 'acme/two', workerId: 'waiting', question: 'ask', createdAt: old });
    ensureTapTable(f.store); f.store.sql.prepare('INSERT INTO taps VALUES (?,?,?,?,?,?,?,0,?,NULL,NULL,?)').run('t', 'acme/one', 'test', 'a', 'h', 'h', 'used', recent, recent);
    const report = await portfolio(f.store, f.settings, undefined, now);
    assert.equal(report.since, '2026-09-30T12:00:00.000Z'); assert.equal(report.projects.length, 3);
    const one = report.projects.find((r) => r.project === 'acme/one')!;
    assert.equal(one.usd, 2); assert.equal(one.codexTokens, 120); assert.equal(one.budget?.usd, 5); assert.equal(one.budget?.capUsd, 10); assert.equal(one.budget?.capCodexTokens, 1000);
    assert.equal(one.merged, 1); assert.equal(one.cleanRate, 0.5); assert.equal(one.firstPassGateRate, 0.5); assert.equal(one.taps, 1);
    assert.deepEqual(one.openPrs, [{ number: 1, waiting: 'review' }, { number: 2, waiting: 'merge' }]);
    assert.equal(report.total.stuck, 1); assert.equal(report.total.inbox, 1);
    const content = formatPortfolio(report);
    const lines = content.split('\n');
    assert.match(lines[0]!, /^\*\*Helm · [A-Za-z]{3} \d{1,2} [A-Za-z]{3}\*\*$/);
    assert.deepEqual(lines.slice(1), ['1 merged · 2 PRs open (1 needs review) · 1 stuck · 1 ask', '$2.00 spent · $10.00 budgeted · Codex 120 tokens', '',
      '**one**: 1 merged, 2 PRs open (1 needs review), 50% gates pass first time, $2.00, 1 tap pending', '**two**: 1 stuck, 1 ask', 'Idle: empty']);
    assert.doesNotMatch(content, /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/, 'no ISO timestamps in the report');
    assert.doesNotMatch(content, /acme\//, 'repo names drop the owner prefix');
    assert.ok(!content.includes('clean'), 'clean rate is dropped');
    assert.equal(f.store.sql.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_outbox'").get(), undefined);
    assert.equal((await portfolio(f.store, f.settings, '2026-10-01T11:00:00Z', now)).total.usd, 0);
    await assert.rejects(portfolio(f.store, f.settings, 'yesterday', now), /ISO date/);
  } finally { f.close(); }
});

test('one compact line per active project; idle collapse after a blank line; a zero fleet says Nothing needs you', async () => {
  const f = fixture({ discord: { projects: { 'acme/idle-a': { webhookEnv: 'E1' }, 'acme/idle-b': { webhookEnv: 'E2' } } } });
  try {
    const zero = formatPortfolio(await portfolio(f.store, f.settings, undefined, now)).split('\n');
    assert.equal(zero[1], 'Nothing needs you');
    assert.deepEqual(zero.slice(2), ['$0.00 spent · Codex 0 tokens', '', 'Idle: idle-a, idle-b']);
    f.store.insertWorker(worker('paid', 'acme/active'));
    f.store.addSpend({ workerId: 'paid', model: 'pi/paid', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1, at: recent });
    assert.deepEqual(formatPortfolio(await portfolio(f.store, f.settings, undefined, now)).split('\n').slice(1), ['0 merged', '$1.00 spent · Codex 0 tokens', '', '**active**: $1.00', 'Idle: idle-a, idle-b']);
    f.store.insertPr({ repoSlug: 'acme/idle-a', workerId: 'paid', number: 201, head: 'b', state: 'open', url: 'https://pr/201', createdAt: old });
    const second = formatPortfolio(await portfolio(f.store, f.settings, undefined, now));
    assert.ok(second.includes('**idle-a**: 1 PR open (1 needs review)'), 'open PRs alone make a project active');
    assert.ok(second.includes('· 1 PR open (1 needs review)'), 'singular PR and needs in the headline');
    assert.match(second, /^Idle: idle-b$/m);
    f.store.insertPr({ repoSlug: 'acme/idle-b', workerId: 'paid', number: 202, head: 'b', state: 'open', url: 'https://pr/202', createdAt: old });
    const third = formatPortfolio(await portfolio(f.store, f.settings, undefined, now));
    assert.doesNotMatch(third, /Idle:/, 'no Idle line when none are idle');
    assert.ok(!third.includes('stuck'), 'stuck is omitted from the headline when zero');
    assert.ok(third.includes('· 2 PRs open (2 need review)'), 'plural PRs and need review in the headline');
    assert.ok(third.includes('**idle-b**: 1 PR open (1 needs review)'), 'project line stays singular');
    assert.doesNotMatch(third, /1 PRs|1 asks|1 needs review\) · 2 PRs/);
  } finally { f.close(); }
});

test('asks pluralise: 1 ask vs 2 asks on the project line and in the headline', async () => {
  const f = fixture();
  try {
    insertInbox(f.store.sql, { id: 'a1', project: 'acme/x', workerId: 'w', question: 'q', createdAt: old });
    let content = formatPortfolio(await portfolio(f.store, f.settings, undefined, now));
    assert.ok(content.includes('0 merged · 1 ask'), 'singular headline ask');
    assert.ok(content.includes('**x**: 1 ask'));
    insertInbox(f.store.sql, { id: 'a2', project: 'acme/x', workerId: 'w', question: 'q', createdAt: old });
    content = formatPortfolio(await portfolio(f.store, f.settings, undefined, now));
    assert.ok(content.includes('0 merged · 2 asks'), 'plural headline asks');
    assert.ok(content.includes('**x**: 2 asks'));
    assert.doesNotMatch(content, /1 asks/);
  } finally { f.close(); }
});

test('spend line totals window spend across all projects and shows the budget cap only while a budget is open', async () => {
  const f = fixture();
  try {
    openBudget(f.store, { project: 'acme/a', label: 'l', capUsd: 50, capCodexTokens: null, openedAt: old });
    f.store.insertWorker(worker('wa', 'acme/a')); f.store.insertWorker(worker('wb', 'acme/b'));
    f.store.addSpend({ workerId: 'wa', model: 'pi/paid', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.43, at: recent });
    f.store.addSpend({ workerId: 'wb', model: 'pi/paid', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 2, at: recent });
    const lines = formatPortfolio(await portfolio(f.store, f.settings, undefined, now)).split('\n');
    assert.equal(lines[2], '$2.43 spent · $50.00 budgeted · Codex 0 tokens', 'unbudgeted project spend is included in the total');
    assert.ok(lines.includes('**a**: $0.43') && lines.includes('**b**: $2.00'), 'per-project spend stays separate');
    closeBudget(f.store, 'acme/a', recent);
    const closed = formatPortfolio(await portfolio(f.store, f.settings, undefined, now)).split('\n');
    assert.equal(closed[2], '$2.43 spent · Codex 0 tokens', 'no budgeted segment when no budget is open');
  } finally { f.close(); }
});

test('taps count as visible activity: taps-only projects show 1 tap pending / 2 taps pending', async () => {
  const f = fixture();
  try {
    ensureTapTable(f.store);
    f.store.sql.prepare('INSERT INTO taps VALUES (?,?,?,?,?,?,?,0,?,NULL,NULL,?)').run('t1', 'acme/taps', 'test', 'a', 'h', 'h', 'used', recent, recent);
    assert.ok(formatPortfolio(await portfolio(f.store, f.settings, undefined, now)).includes('**taps**: 1 tap pending'), 'taps-only project is not dropped');
    f.store.sql.prepare('INSERT INTO taps VALUES (?,?,?,?,?,?,?,0,?,NULL,NULL,?)').run('t2', 'acme/taps', 'test', 'a', 'h', 'h', 'used', recent, recent);
    assert.ok(formatPortfolio(await portfolio(f.store, f.settings, undefined, now)).includes('**taps**: 2 taps pending'));
  } finally { f.close(); }
});

test('fleet token counts are humanised (17M, 850k)', async () => {
  for (const [tokens, expected] of [[17_000_000, 'Codex 17M tokens'], [850_000, 'Codex 850k tokens']] as const) {
    const f = fixture();
    try {
      f.store.insertWorker(worker('big', 'acme/big'));
      f.store.addSpend({ workerId: 'big', model: 'codex/luna', inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, at: recent });
      assert.ok(formatPortfolio(await portfolio(f.store, f.settings, undefined, now)).includes(expected));
    } finally { f.close(); }
  }
});

test('CLI portfolio supports compact text, --json and --since without a daemon', () => {
  const f = fixture();
  try {
    for (const args of [[], ['--json', '--since', '2026-10-01T00:00:00Z']]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'portfolio', ...args], { cwd: new URL('..', import.meta.url), env: { ...process.env, HELM_HOME: f.home }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      if (args.length) assert.equal(JSON.parse(result.stdout).since, '2026-10-01T00:00:00.000Z'); else assert.match(result.stdout, /\*\*Helm · /);
    }
  } finally { f.close(); }
});

function delivery(f: ReturnType<typeof fixture>, clock: { date: Date }, sent: { url: string; content: string }[], store = f.store, ok = true) {
  return createReportTicker({ store, home: f.home, env: { REPORT: 'https://example/report', FALLBACK: 'https://example/fallback', EMPTY: '' }, now: () => clock.date,
    fetch: (async (url, init) => { sent.push({ url: String(url), content: JSON.parse(String(init?.body)).content }); return new Response(null, { status: ok ? 204 : 500 }); }) as typeof fetch });
}

test('sends at or after 06:00 once per local day, including database reopen after restart', async () => {
  const f = fixture({ report: { at: '06:00', webhookEnv: 'REPORT' } }); const sent: { url: string; content: string }[] = []; const clock = { date: new Date(2026, 9, 1, 5, 59) };
  try {
    const tick = delivery(f, clock, sent); await tick(); assert.equal(sent.length, 0);
    clock.date = new Date(2026, 9, 1, 6); await Promise.all([tick(), tick()]); await tick(); assert.equal(sent.length, 1);
    f.store.close(); const restarted = openStore(f.path);
    try {
      const next = delivery(f, clock, sent, restarted); clock.date = new Date(2026, 9, 1, 20); await next(); assert.equal(sent.length, 1);
      clock.date = new Date(2026, 9, 2, 5, 59); await next(); assert.equal(sent.length, 1);
      clock.date = new Date(2026, 9, 2, 6, 1); await next(); assert.equal(sent.length, 2);
    } finally { restarted.close(); }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('first tick after downtime catches up for today and honors a configured later time', async () => {
  const f = fixture({ report: { at: '08:30', webhookEnv: 'REPORT' } }); const sent: { url: string; content: string }[] = []; const clock = { date: new Date(2026, 9, 1, 8, 29) };
  try { const tick = delivery(f, clock, sent); await tick(); assert.equal(sent.length, 0); clock.date = new Date(2026, 9, 1, 11); await tick(); await tick(); assert.equal(sent.length, 1); } finally { f.close(); }
});

test('fallback uses first configured Discord project when report env is unset or empty; no routes stays off', async () => {
  for (const report of [undefined, { webhookEnv: 'EMPTY' }, { webhookEnv: 'REPORT' }]) {
    const f = fixture({ report, discord: { projects: { one: { webhookEnv: 'FALLBACK' }, two: { webhookEnv: 'REPORT' } } } }); const sent: { url: string; content: string }[] = [];
    try { await delivery(f, { date: new Date(2026, 9, 1, 7) }, sent)(); assert.equal(sent[0]?.url, report?.webhookEnv === 'REPORT' ? 'https://example/report' : 'https://example/fallback'); } finally { f.close(); }
  }
  for (const config of [{}, { report: { webhookEnv: 'EMPTY' } }, { discord: { projects: { one: { webhookEnv: 'EMPTY' } } } }]) {
    const f = fixture(config); const sent: { url: string; content: string }[] = [];
    try { await delivery(f, { date: new Date(2026, 9, 1, 7) }, sent)(); assert.equal(sent.length, 0); assert.equal(f.store.sql.prepare('SELECT * FROM portfolio_report').get(), undefined); } finally { f.close(); }
  }
});

test('Discord truncation keeps the first three summary lines and marks dropped lines', async () => {
  assert.equal(reportContent('x'.repeat(2000)).length, 2000);
  const rows = ['**Helm · Wed 1 Oct**', '1 merged · 2 asks', '$2.43 spent · $50.00 budgeted · Codex 17.5M tokens',
    ...Array.from({ length: 120 }, (_, i) => `**project-${i}**: 1 ask, ${'😀'.repeat(30)}`)];
  const bounded = reportContent(rows.join('\n'));
  assert.ok(bounded.length <= 2000);
  assert.ok(bounded.startsWith(rows.slice(0, 3).join('\n') + '\n'), 'title, headline and spend/totals lines survive truncation');
  const dropped = Number(bounded.match(/\n…and (\d+) more$/)![1]);
  assert.equal(bounded.split('\n').length - 1 + dropped, rows.length, 'marker counts exactly the dropped lines');
  assert.doesNotMatch(bounded, /[\uD800-\uDBFF]\n/);
  const fallback = reportContent(['a'.repeat(1_200), 'b'.repeat(1_200), 'c'.repeat(1_200), 'd'].join('\n'));
  assert.ok(fallback.length <= 2000); assert.match(fallback, /\n…and 4 more$/);
  const f = fixture({ report: { webhookEnv: 'REPORT' }, discord: { projects: Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['project-' + i, { webhookEnv: 'EMPTY' }])) } }); const sent: { url: string; content: string }[] = [];
  try { for (let i = 0; i < 200; i++) insertInbox(f.store.sql, { id: 'bulk-' + i, project: 'project-' + i, workerId: 'w', question: 'q', createdAt: old }); await delivery(f, { date: new Date(2026, 9, 1, 7) }, sent)(); assert.equal(sent.length, 1); assert.ok(sent[0]!.content.length <= 2000); assert.match(sent[0]!.content, /\n…and \d+ more$/); assert.ok(sent[0]!.content.startsWith('**Helm')); assert.ok(sent[0]!.content.includes('200 asks'), 'headline totals survive the webhook truncation'); } finally { f.close(); }
});

test('unsuccessful webhook sends do not advance the persisted date and can retry', async () => {
  const f = fixture({ report: { webhookEnv: 'REPORT' } }); const sent: { url: string; content: string }[] = []; const clock = { date: new Date(2026, 9, 1, 7) };
  try {
    await delivery(f, clock, sent, f.store, false)(); assert.equal((f.store.sql.prepare('SELECT lastSentDate FROM portfolio_report').get() as { lastSentDate: string }).lastSentDate, '');
    clock.date = new Date(2026, 9, 1, 7, 5);
    await delivery(f, clock, sent)(); assert.equal(sent.length, 2); assert.equal((f.store.sql.prepare('SELECT lastSentDate FROM portfolio_report').get() as { lastSentDate: string }).lastSentDate, '2026-10-01');
  } finally { f.close(); }
});

test('report persists 5m and 15m backoff across restart, gives up after three attempts, logs once and resets next day', async () => {
  const f = fixture({ report: { webhookEnv: 'REPORT' } }); const clock = { date: new Date(2026, 9, 1, 7) }; const logs: string[] = []; let posts = 0;
  const create = (store = f.store) => createReportTicker({ store, home: f.home, now: () => clock.date, env: { REPORT: 'https://example/report' }, log: (line) => logs.push(line), fetch: (async () => { posts++; if (posts === 2) throw new Error('secret webhook URL'); return new Response(null, { status: 500 }); }) as typeof fetch });
  try {
    const tick = create(); await tick(); assert.equal(posts, 1);
    assert.equal((f.store.sql.prepare('SELECT lastAttemptAt FROM portfolio_report').get() as { lastAttemptAt: string }).lastAttemptAt, clock.date.toISOString());
    for (let second = 1; second < 300; second++) { clock.date = new Date(2026, 9, 1, 7, 0, second); await tick(); }
    assert.equal(posts, 1); assert.equal(logs.length, 0);
    f.store.close(); const restarted = openStore(f.path);
    try {
      const next = create(restarted); clock.date = new Date(2026, 9, 1, 7, 5); await next(); assert.equal(posts, 2);
      clock.date = new Date(2026, 9, 1, 7, 19, 59); await next(); assert.equal(posts, 2);
      clock.date = new Date(2026, 9, 1, 7, 20); await next(); assert.equal(posts, 3); assert.equal(logs.length, 1);
      assert.match(logs[0]!, /abandoned.*2026-10-01.*3 attempts/); assert.doesNotMatch(logs[0]!, /secret|https/);
      const state = restarted.sql.prepare('SELECT attempts,gaveUpDate,lastSentDate FROM portfolio_report').get() as { attempts: number; gaveUpDate: string; lastSentDate: string };
      assert.deepEqual({ ...state }, { attempts: 3, gaveUpDate: '2026-10-01', lastSentDate: '' });
      const anotherRestart = create(restarted); clock.date = new Date(2026, 9, 1, 22); await next(); await anotherRestart(); assert.equal(posts, 3); assert.equal(logs.length, 1);
      clock.date = new Date(2026, 9, 2, 7); await anotherRestart(); assert.equal(posts, 4);
      assert.equal((restarted.sql.prepare('SELECT attempts FROM portfolio_report').get() as { attempts: number }).attempts, 1);
    } finally { restarted.close(); }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test('report settings are re-read no more than once per minute and reload at the minute boundary', async () => {
  const f = fixture({ report: { webhookEnv: 'EMPTY' } }); let reads = 0; let posts = 0; let date = new Date(2026, 9, 1, 7);
  try {
    const tick = createReportTicker({ store: f.store, home: f.home, env: { EMPTY: '', REPORT: 'https://example/report' }, now: () => date, readSettings: (home) => { reads++; return loadSettings(home); }, fetch: (async () => { posts++; return new Response(null, { status: 204 }); }) as typeof fetch });
    await tick(); writeFileSync(join(f.home, 'helm.json'), JSON.stringify({ report: { webhookEnv: 'REPORT' } }));
    for (let second = 1; second < 60; second++) { date = new Date(2026, 9, 1, 7, 0, second); await tick(); }
    assert.equal(reads, 1); assert.equal(posts, 0);
    date = new Date(2026, 9, 1, 7, 1); await tick(); assert.equal(reads, 2); assert.equal(posts, 1);
  } finally { f.close(); }
});

test('independent notification tickers keep delivering Discord while a report POST is pending', async () => {
  const f = fixture({ report: { webhookEnv: 'REPORT' } }); let discordCalls = 0; let reportCalls = 0; let complete!: () => void;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  const report = createReportTicker({ store: f.store, home: f.home, now: () => new Date(2026, 9, 1, 7), env: { REPORT: 'https://example/report' }, fetch: (async () => { reportCalls++; await pending; return new Response(null, { status: 204 }); }) as typeof fetch });
  const timers = startNotificationTickers(async () => { discordCalls++; }, report);
  try {
    const running = timers.report.tick(); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(reportCalls, 1);
    await timers.discord.tick(); await timers.discord.tick(); assert.equal(discordCalls, 2); assert.equal(reportCalls, 1);
    complete(); await running; await timers.report.tick(); assert.equal(reportCalls, 1);
  } finally { complete(); timers.stop(); f.close(); }
});

test('stuck means old waiting/running/queued transitions or inactive idle builders with open PRs', async () => {
  const f = fixture();
  try {
    for (const state of ['waiting', 'running', 'queued', 'idle', 'failed', 'succeeded', 'stopped', 'unknown', 'interrupted'] as const) {
      f.store.insertWorker({ ...worker(state, 'acme/test', state), updatedAt: old });
      f.store.appendEvent(state, 'state', { to: state }, old);
    }
    for (const id of ['idle-pr', 'active-event', 'active-spend', 'active-gate', 'boundary', 'reviewer', 'closed-pr', 'fresh-running']) {
      f.store.insertWorker({ ...worker(id, 'acme/test', id === 'fresh-running' ? 'running' : 'idle'), updatedAt: id === 'boundary' ? '2026-10-01T10:00:00Z' : old, role: id === 'reviewer' ? 'reviewer' : 'builder' });
      f.store.insertPr({ repoSlug: 'acme/test', workerId: id, number: 100 + f.store.listPrs().length, head: 'b', state: id === 'closed-pr' ? 'closed' : 'open', url: 'https://pr/' + id, createdAt: old });
    }
    f.store.appendEvent('active-event', 'tool.call', {}, '2026-10-01T11:00:00Z');
    f.store.appendEvent('fresh-running', 'state', { to: 'running' }, '2026-10-01T11:00:00Z');
    f.store.addSpend({ workerId: 'active-spend', model: 'codex/luna', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, at: '2026-10-01T11:00:00Z' });
    f.store.insertGate({ workerId: 'active-gate', gateId: 'active', head: 'b', checks: [], passed: true, at: '2026-10-01T11:00:00Z' });
    const report = await portfolio(f.store, f.settings, undefined, now);
    assert.deepEqual(report.projects[0]!.stuck.map((w) => w.workerId).sort(), ['idle-pr', 'queued', 'running', 'waiting']);
  } finally { f.close(); }
});

test('fallback webhook order is report, global, first project; empty values fall through', async () => {
  for (const [report, global, expected] of [['REPORT', 'GLOBAL', 'report'], ['EMPTY', 'GLOBAL', 'global'], [undefined, 'GLOBAL', 'global'], ['EMPTY', 'EMPTY', 'project']] as const) {
    const f = fixture({ report: { webhookEnv: report }, discord: { globalWebhookEnv: global, projects: { one: { webhookEnv: 'PROJECT' }, two: { webhookEnv: 'SECOND' } } } }); const urls: string[] = [];
    try {
      await createReportTicker({ store: f.store, home: f.home, now: () => new Date(2026, 9, 1, 7), env: { REPORT: 'report', GLOBAL: 'global', PROJECT: 'project', SECOND: 'second', EMPTY: '' }, fetch: (async (url) => { urls.push(String(url)); return new Response(null, { status: 204 }); }) as typeof fetch })();
      assert.deepEqual(urls, [expected]);
    } finally { f.close(); }
  }
});

test('openStore owns report schema and upgrades legacy daily markers without losing the sent date', () => {
  const f = fixture();
  try {
    assert.ok(f.store.sql.prepare("SELECT 1 FROM sqlite_master WHERE name='portfolio_report'").get());
    f.store.sql.exec("DROP TABLE portfolio_report; CREATE TABLE portfolio_report (id INTEGER PRIMARY KEY CHECK(id=1),lastSentDate TEXT NOT NULL); INSERT INTO portfolio_report VALUES (1,'2026-10-01')");
    f.store.close(); const reopened = openStore(f.path);
    try {
      const state = reopened.sql.prepare('SELECT lastSentDate,lastAttemptAt,attempts FROM portfolio_report').get() as { lastSentDate: string; lastAttemptAt: null; attempts: number };
      assert.deepEqual({ ...state }, { lastSentDate: '2026-10-01', lastAttemptAt: null, attempts: 0 });
    } finally { reopened.close(); }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
