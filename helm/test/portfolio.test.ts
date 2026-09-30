import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachWorker, openBudget } from '../src/budget.js';
import { ensureTapTable } from '../src/envelope.js';
import { insertInbox } from '../src/inbox.js';
import { createReportTicker, formatPortfolio, portfolio, reportContent } from '../src/portfolio.js';
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
    assert.equal(report.total.stuck, 4); assert.equal(report.total.inbox, 1);
    const content = formatPortfolio(report); assert.ok(content.split('\n').length <= 25); assert.match(content, /Fleet: \$2.00; Codex 120 tokens; merged 1/);
    assert.equal(f.store.sql.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_outbox'").get(), undefined);
    assert.equal((await portfolio(f.store, f.settings, '2026-10-01T11:00:00Z', now)).total.usd, 0);
    await assert.rejects(portfolio(f.store, f.settings, 'yesterday', now), /ISO date/);
  } finally { f.close(); }
});

test('CLI portfolio supports compact text, --json and --since without a daemon', () => {
  const f = fixture();
  try {
    for (const args of [[], ['--json', '--since', '2026-10-01T00:00:00Z']]) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'portfolio', ...args], { cwd: new URL('..', import.meta.url), env: { ...process.env, HELM_HOME: f.home }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      if (args.length) assert.equal(JSON.parse(result.stdout).since, '2026-10-01T00:00:00.000Z'); else assert.match(result.stdout, /Fleet:/);
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

test('Discord payload truncates cleanly at 2000 chars and preserves fleet total', async () => {
  assert.equal(reportContent('x'.repeat(2000)).length, 2000);
  const text = Array.from({ length: 100 }, () => 'a project line').join('\n') + '\n' + '😀'.repeat(1000) + '\nFleet: total';
  const bounded = reportContent(text); assert.ok(bounded.length <= 2000); assert.match(bounded, /… report truncated\nFleet: total$/); assert.doesNotMatch(bounded, /[\uD800-\uDBFF]\n/);
  const f = fixture({ report: { webhookEnv: 'REPORT' }, discord: { projects: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['project-' + i, { webhookEnv: 'EMPTY' }])) } }); const sent: { url: string; content: string }[] = [];
  try { await delivery(f, { date: new Date(2026, 9, 1, 7) }, sent)(); assert.equal(sent.length, 1); assert.ok(sent[0]!.content.length <= 2000); assert.match(sent[0]!.content, /truncated/); } finally { f.close(); }
});

test('unsuccessful webhook sends do not advance the persisted date and can retry', async () => {
  const f = fixture({ report: { webhookEnv: 'REPORT' } }); const sent: { url: string; content: string }[] = []; const clock = { date: new Date(2026, 9, 1, 7) };
  try {
    await delivery(f, clock, sent, f.store, false)(); assert.equal(f.store.sql.prepare('SELECT * FROM portfolio_report').get(), undefined);
    await delivery(f, clock, sent)(); assert.equal(sent.length, 2); assert.equal((f.store.sql.prepare('SELECT lastSentDate FROM portfolio_report').get() as { lastSentDate: string }).lastSentDate, '2026-10-01');
  } finally { f.close(); }
});
