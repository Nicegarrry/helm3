import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { createCapacityAdmission } from '../src/capacity/admit.js';
import { loadSettings } from '../src/settings.js';
import { getTicket, insertTicket, refreshTickets, statusLines, statusSections, ticketView, ticketLane, bumpTicket, type Ticket } from '../src/tickets.js';

const at = new Date('2026-10-01T00:00:00.000Z');
function fixture(path = ':memory:') {
  const store = openStore(path);
  const capacity = createCapacityAdmission({ home: '/tmp/helm-ticket-history', store, maxWorkers: 2, settings: loadSettings('/missing'), now: () => at });
  return { store, capacity };
}
function ticket(id: string, patch: Partial<Ticket> = {}): Ticket {
  return { id, project: 'acme/app', repo: '/tmp/app', objective: 'work', acceptance: null, issue: 311, baseRef: 'main', statedPriority: 'normal', effectivePriority: 'normal', requestedBy: 'auto', state: 'queued', workerId: null, createdAt: at.toISOString(), dispatchedAt: null, finishedAt: null, etaAt: null, lastPosition: 0, loadClass: 'light', payload: '{}', idempotencyKey: null, quickCheck: '{}', ...patch };
}

test('ETA uses fourteen-day load-class medians, running remainder and concurrency', async () => {
  const { store, capacity } = fixture();
  try {
    const history = store.sql.prepare('INSERT INTO capacity_jobs (id,workerId,kind,loadClass,priority,queuedAt,startedAt,endedAt,durationMs) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const [id, load, minutes, days] of [['h1', 'light', 10, 1], ['h2', 'light', 30, 2], ['h3', 'heavy', 40, 1], ['old', 'light', 999, 15]] as const) {
      const ended = new Date(at.getTime() - days * 86400_000).toISOString();
      history.run(id, id, 'builder', load, 2, ended, ended, ended, minutes * 60_000);
    }
    history.run('running', 'w-running', 'builder', 'light', 2, at.toISOString(), new Date(at.getTime() - 10 * 60_000).toISOString(), null, null);
    for (const [id, loadClass] of [['t-a', 'light'], ['t-b', 'heavy'], ['t-c', 'medium']] as const) {
      insertTicket(store, ticket(id, { loadClass }));
      store.sql.prepare('INSERT INTO capacity_jobs (id,workerId,kind,loadClass,priority,queuedAt,rank) VALUES (?,?,?,?,?,?,?)').run(id, id, 'builder', loadClass, 2, at.toISOString(), '{"base":10,"reasons":[]}');
    }
    refreshTickets(store, 2, at);
    assert.deepEqual(['t-a', 't-b', 't-c'].map((id) => ticketView(getTicket(store, id)!, at).etaMinutes), [5, 15, 35]);
    assert.deepEqual(['t-a', 't-b', 't-c'].map((id) => getTicket(store, id)?.lastPosition), [1, 2, 3]);
    const previous = getTicket(store, 't-b'); refreshTickets(store, 2, at); assert.deepEqual(getTicket(store, 't-b'), previous);
    refreshTickets(store, 2, new Date(at.getTime() + 5 * 60_000));
    assert.equal(ticketView(getTicket(store, 't-a')!, new Date(at.getTime() + 5 * 60_000)).etaMinutes, 3);
  } finally { await capacity.close(); store.close(); }
});

test('ETA defaults to twenty minutes without history', async () => {
  const { store, capacity } = fixture();
  try {
    for (const id of ['t-a', 't-b']) {
      insertTicket(store, ticket(id));
      store.sql.prepare('INSERT INTO capacity_jobs (id,workerId,kind,loadClass,priority,queuedAt,rank) VALUES (?,?,?,?,?,?,?)').run(id, id, 'builder', 'light', 2, at.toISOString(), '{"base":10,"reasons":[]}');
    }
    refreshTickets(store, 1, at);
    assert.equal(ticketView(getTicket(store, 't-b')!, at).etaMinutes, 20);
  } finally { await capacity.close(); store.close(); }
});

test('status sections bound recent to twenty-four hours and ten rows, retain PR merge information, and stay compact', async () => {
  const { store, capacity } = fixture();
  try {
    for (let i = 0; i < 40; i++) insertTicket(store, ticket(`t-${i}`, { lastPosition: i + 1 }));
    for (let i = 0; i < 12; i++) insertTicket(store, ticket(`done-${i}`, { state: i % 2 ? 'failed' : 'done', workerId: `w-${i}`, finishedAt: at.toISOString() }));
    insertTicket(store, ticket('old', { state: 'done', finishedAt: new Date(at.getTime() - 25 * 3600_000).toISOString() }));
    store.insertPr({ workerId: 'w-0', number: 311, url: 'https://github.com/acme/app/pull/311', head: 'abc', createdAt: at.toISOString(), state: 'merged' });
    const sections = statusSections(store, at);
    assert.equal(sections.backlog.length, 40); assert.equal(sections.recent.length, 10);
    assert.equal(sections.recent.find((row) => row.workerId === 'w-0')?.merged, true);
    const lines = statusLines(sections);
    assert.match(lines, /Backlog\n/); assert.match(lines, /Working\n/); assert.match(lines, /Recent\n/);
    assert.ok(lines.split('\n').length <= 25); assert.match(lines, /PR#311 merged yes/);
  } finally { await capacity.close(); store.close(); }
});

test('CLI status shows sections and JSON retains the complete backlog', () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-ticket-cli-'));
  const store = openStore(join(home, 'helm.sqlite'));
  try {
    for (let i = 0; i < 30; i++) insertTicket(store, ticket(`t-${i}`, { lastPosition: i + 1 }));
    store.close();
    const run = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'status', ...args], { encoding: 'utf8', env: { ...process.env, HELM_HOME: home } });
    const compact = run([]); assert.match(compact, /Backlog\n/); assert.match(compact, /Working\n/); assert.match(compact, /Recent/); assert.ok(compact.trim().split('\n').length <= 25);
    assert.equal(JSON.parse(run(['--json'])).sections.backlog.length, 30);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('review tickets and review requests precede owner and urgent builders after bumps', async () => {
  const store = openStore(':memory:');
  const capacity = createCapacityAdmission({ home: '/tmp/helm-ticket-lanes', store, maxWorkers: 1, settings: loadSettings('/missing'), now: () => at });
  const started: string[] = [];
  try {
    await capacity.admit({ id: 'active', workerId: 'active', kind: 'builder', loadClass: 'light' }, () => {});
    const rows = [ticket('owner', { requestedBy: 'owner' }), ticket('urgent', { effectivePriority: 'urgent' }), ticket('reviewer', { payload: '{"input":{"role":"reviewer"}}' })];
    for (const row of rows) {
      insertTicket(store, row);
      await capacity.admit({ id: row.id, workerId: row.id, kind: row.id === 'reviewer' ? 'review' : 'builder', loadClass: 'light', priority: ticketLane(row) }, () => { started.push(row.id); });
    }
    await capacity.admit({ id: 'review-request', workerId: 'review-request', kind: 'review', loadClass: 'light' }, () => { started.push('review-request'); });
    bumpTicket(store, rows[2]!, 'urgent');
    assert.equal((store.sql.prepare('SELECT priority FROM capacity_jobs WHERE id = ?').get('reviewer') as { priority: number }).priority, 1);
    capacity.finish('active');
    await capacity.tick();
    assert.deepEqual(started, ['reviewer']);
    capacity.finish('reviewer');
    await capacity.tick();
    assert.deepEqual(started, ['reviewer', 'review-request']);
  } finally { await capacity.close(); store.close(); }
});
