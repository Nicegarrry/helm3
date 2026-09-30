import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachWorker, openBudget } from '../src/budget.js';
import { createMemory } from '../src/memory.js';
import { createScorecard, cleanRateForRouting } from '../src/scorecard.js';
import { createPrTicker } from '../src/pr-watch.js';
import { ghGitHub } from '../src/github.js';
import { openStore } from '../src/store.js';
import type { WorkerRow } from '../src/types.js';

const base = '2026-09-30T00:00:00.000Z';
function worker(id: string, model: string, state: WorkerRow['state'] = 'succeeded', role: WorkerRow['role'] = 'builder'): WorkerRow {
  return { workerId: id, repo: '/repo', repoSlug: 'acme/widgets', role, model, objective: id, acceptance: null, contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'a'.repeat(40), branch: id, worktree: `/repo/${id}`, state, head: 'b'.repeat(40), sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: base, updatedAt: base };
}
function event(store: ReturnType<typeof openStore>, id: string, kind: string, at: string, data: Record<string, unknown> = {}): void { store.appendEvent(id, kind, data, `2026-09-30T00:00:${at}.000Z`); }

function seed() {
  const store = openStore(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'helm-scorecard-'));
  const budget = openBudget(store, { project: 'acme/widgets', label: 'sprint-1', capUsd: 5, openedAt: base });
  const clean = worker('w-clean', 'codex/luna'); const rework = worker('w-rework', 'codex/luna'); const failed = worker('w-failed', 'codex/terra'); const respawn = { ...worker('w-respawn', 'codex/terra'), createdAt: '2026-09-30T00:20:00.000Z' }; const validator = { ...worker('w-validator', 'codex/terra', 'succeeded', 'validator'), createdAt: '2026-09-30T00:10:00.000Z' };
  for (const row of [clean, rework, failed, respawn, validator]) store.insertWorker(row);
  store.setMeta(clean.workerId, { issue: 101, tier: 2 }); store.setMeta(rework.workerId, { issue: 102, tier: 3 }); store.setMeta(failed.workerId, { issue: 103, tier: 4 }); store.setMeta(respawn.workerId, { issue: 103, tier: 4 }); store.setMeta(validator.workerId, { issue: 101, tier: 2 });
  for (const id of [clean.workerId, rework.workerId, failed.workerId, respawn.workerId]) attachWorker(store, id, budget.id);
  event(store, clean.workerId, 'turn.start', '01'); event(store, clean.workerId, 'turn.end', '04'); event(store, clean.workerId, 'result', '05', { status: 'succeeded' }); event(store, clean.workerId, 'pr.merged', '06');
  event(store, rework.workerId, 'turn.start', '08'); event(store, rework.workerId, 'turn.end', '09'); event(store, rework.workerId, 'result', '10', { status: 'succeeded' }); event(store, rework.workerId, 'turn.start', '11'); event(store, rework.workerId, 'turn.end', '12');
  event(store, failed.workerId, 'result', '20', { status: 'succeeded' }); event(store, respawn.workerId, 'result', '21', { status: 'succeeded' });
  store.insertGate({ gateId: 'g-clean', workerId: clean.workerId, head: clean.head!, passed: true, checks: [], at: '2026-09-30T00:01:00.000Z' });
  store.insertGate({ gateId: 'g-rework', workerId: rework.workerId, head: rework.head!, passed: false, checks: [{ name: 'test', command: 'test', exitCode: 1, outputPath: '', durationMs: 1 }], at: '2026-09-30T00:02:00.000Z' });
  store.insertGate({ gateId: 'g-failed', workerId: failed.workerId, head: failed.head!, passed: false, checks: [{ name: 'test', command: 'test', exitCode: 1, outputPath: '', durationMs: 1 }], at: '2026-09-30T00:03:00.000Z' });
  store.sql.exec('CREATE TABLE claims_checks (workerId TEXT, head TEXT, passed INTEGER, detail JSON, jevCallId INTEGER, at TEXT); CREATE TABLE reviews (id INTEGER PRIMARY KEY, repoSlug TEXT, number INTEGER, head TEXT, patchId TEXT, reviewer TEXT, stated TEXT, jevApprove REAL, verdict TEXT, commentUrl TEXT, at TEXT); CREATE TABLE retries (workerId TEXT, kind TEXT, n INTEGER, at TEXT)');
  store.sql.prepare('INSERT INTO claims_checks VALUES (?, ?, ?, ?, NULL, ?)').run(clean.workerId, clean.head, 1, '{}', '2026-09-30T00:04:00.000Z'); store.sql.prepare('INSERT INTO claims_checks VALUES (?, ?, ?, ?, NULL, ?)').run(rework.workerId, rework.head, 1, '{}', '2026-09-30T00:04:00.000Z'); store.sql.prepare('INSERT INTO claims_checks VALUES (?, ?, ?, ?, NULL, ?)').run(failed.workerId, failed.head, 0, '{}', '2026-09-30T00:04:00.000Z');
  store.insertPr({ number: 1, workerId: clean.workerId, url: 'https://pr/1', head: clean.head!, createdAt: base }); store.insertPr({ number: 2, workerId: rework.workerId, url: 'https://pr/2', head: rework.head!, createdAt: base });
  store.sql.prepare('INSERT INTO reviews VALUES (3,?,?,?,?,?,?,?,?,?,?)').run('other/repo', 1, clean.head, 'p', 'r', 'request_changes', 0, 'changes', 'u', '2026-09-30T00:04:00.000Z'); store.sql.prepare('INSERT INTO reviews VALUES (1,?,?,?,?,?,?,?,?,?,?)').run('acme/widgets', 1, clean.head, 'p', 'r', 'approve', 1, 'approve', 'u', '2026-09-30T00:05:00.000Z'); store.sql.prepare('INSERT INTO reviews VALUES (2,?,?,?,?,?,?,?,?,?,?)').run('acme/widgets', 2, rework.head, 'p', 'r', 'request_changes', 0, 'changes', 'u', '2026-09-30T00:05:00.000Z');
  store.sql.prepare('INSERT INTO retries VALUES (?,?,?,?)').run(rework.workerId, 'review', 1, '2026-09-30T00:06:00.000Z'); store.sql.prepare('INSERT INTO retries VALUES (?,?,?,?)').run(failed.workerId, 'gate', 1, '2026-09-30T00:06:00.000Z');
  store.addSpend({ workerId: clean.workerId, model: clean.model, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, at: base }); store.addSpend({ workerId: rework.workerId, model: rework.model, inputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, at: base });
  store.sql.prepare('UPDATE budgets SET closedAt = ? WHERE id = ?').run('2026-09-30T00:30:00.000Z', budget.id);
  const memory = createMemory({ store, home: dir, now: () => new Date('2026-09-30T00:40:00.000Z') });
  return { store, dir, budget, scorecard: createScorecard({ store, memory, now: () => new Date('2026-09-30T00:40:00.000Z') }) };
}

test('scorecard snapshot classifies tickets and tolerates missing deploys/taps', async () => {
  const seeded = seed();
  try {
    const result = await seeded.scorecard.export({ project: 'acme/widgets', budgetId: seeded.budget.id });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.json, { project: 'acme/widgets', window: { budgetId: seeded.budget.id, label: 'sprint-1', openedAt: base, closedAt: '2026-09-30T00:30:00.000Z' }, tickets: 3, merged: 1, firstPassGateRate: 0.3333, claimsPassRate: 0.6667, firstReviewApprovalRate: 0.5, retriesPerTicket: { gate: 0.3333, review: 0.3333 }, activeMinutes: 0.08, codexTokens: 160, usd: 0, jevCalls: 0, jevCost: null, deploys: 0, rollbacks: 0, taps: 0, outcomes: [{ model: 'codex/luna', tier: 3, clean: 0, rework: 1, failed: 0 }, { model: 'codex/luna', tier: 2, clean: 1, rework: 0, failed: 0 }, { model: 'codex/terra', tier: 4, clean: 1, rework: 0, failed: 1 }] });
    assert.match(result.markdown, /## Model × tier/);
    assert.match(result.markdown, /\| codex\/luna \| 2 \| 1 \| 0 \| 0 \|/);
    assert.match(result.markdown, /\| codex\/luna \| 3 \| 0 \| 1 \| 0 \|/);
  } finally { seeded.store.close(); rmSync(seeded.dir, { recursive: true, force: true }); }
});

test('a single steer turn is rework even without a failed gate or request changes', async () => {
  const seeded = seed();
  try {
    seeded.store.sql.prepare("UPDATE gates SET passed = 1 WHERE gateId = 'g-rework'").run();
    seeded.store.sql.prepare('DELETE FROM reviews WHERE id = 2').run();
    const result = await seeded.scorecard.export({ project: 'acme/widgets', budgetId: seeded.budget.id });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.json.outcomes.find((outcome) => outcome.model === 'codex/luna' && outcome.tier === 3), { model: 'codex/luna', tier: 3, clean: 0, rework: 1, failed: 0 });
  } finally { seeded.store.close(); rmSync(seeded.dir, { recursive: true, force: true }); }
});

test('budget.closed writes one page and handles a failing export once', async () => {
  const seeded = seed();
  try {
    seeded.store.appendEvent('project:acme/widgets', 'budget.closed', { project: 'acme/widgets', budgetId: seeded.budget.id }, '2026-09-30T00:40:00.000Z');
    await seeded.scorecard.consume(); await seeded.scorecard.consume();
    const first = await (await import('../src/memory.js')).createMemory({ store: seeded.store, home: seeded.dir }).list({ project: 'acme/widgets', type: 'scorecard' });
    assert.equal(first.ok ? first.memories.length : -1, 1);
    assert.equal((seeded.store.sql.prepare('SELECT COUNT(*) AS count FROM memory_outbox').get() as { count: number }).count, 1);
    seeded.store.appendEvent('project:acme/widgets', 'budget.closed', { project: 'acme/widgets', budgetId: 'missing-token=secret' }, '2026-09-30T00:41:00.000Z');
    await seeded.scorecard.consume(); await seeded.scorecard.consume(); await seeded.scorecard.consume();
    const failed = seeded.store.sql.prepare("SELECT data FROM events WHERE kind = 'scorecard.failed'").all() as Array<{ data: string }>;
    assert.equal(failed.length, 1); const detail = JSON.parse(failed[0]!.data) as { error: string }; assert.doesNotMatch(detail.error, /secret/); assert.match(detail.error, /redacted/);
  } finally { seeded.store.close(); rmSync(seeded.dir, { recursive: true, force: true }); }
});

test('budget ids keep same-label scorecards on separate memory pages', async () => {
  const seeded = seed();
  try {
    assert.equal((await seeded.scorecard.export({ project: 'acme/widgets', budgetId: seeded.budget.id })).ok, true);
    const second = openBudget(seeded.store, { project: 'acme/widgets', label: 'sprint-1', capUsd: 5, openedAt: '2026-10-01T00:00:00.000Z' });
    seeded.store.sql.prepare('UPDATE budgets SET closedAt = ? WHERE id = ?').run('2026-10-01T00:30:00.000Z', second.id);
    assert.equal((await seeded.scorecard.export({ project: 'acme/widgets', budgetId: second.id })).ok, true);
    const pages = await (await import('../src/memory.js')).createMemory({ store: seeded.store, home: seeded.dir }).list({ project: 'acme/widgets', type: 'scorecard' });
    assert.equal(pages.ok ? pages.memories.length : -1, 2);
    if (pages.ok) { assert.notEqual(pages.memories[0]!.path, pages.memories[1]!.path); assert.ok(pages.memories.some((page) => page.path.includes(seeded.budget.id))); assert.ok(pages.memories.some((page) => page.path.includes(second.id))); }
  } finally { seeded.store.close(); rmSync(seeded.dir, { recursive: true, force: true }); }
});

test('scorecard since accepts ISO dates and rejects invalid values', async () => {
  const seeded = seed();
  try {
    assert.deepEqual(await seeded.scorecard.export({ project: 'acme/widgets', since: 'yesterday' }), { ok: false, reason: 'since must be an ISO date' });
    assert.equal((await seeded.scorecard.export({ project: 'acme/widgets', since: '2026-09-30' })).ok, true);
  } finally { seeded.store.close(); rmSync(seeded.dir, { recursive: true, force: true }); }
});

test('rerun overwrites one memory page and budget.closed consumer exports', async () => {
  const seeded = seed();
  try {
    const eventAt = '2026-09-30T00:40:00.000Z'; seeded.store.appendEvent('project:acme/widgets', 'budget.closed', { project: 'acme/widgets', budgetId: seeded.budget.id }, eventAt); await seeded.scorecard.consume(); await seeded.scorecard.export({ project: 'acme/widgets', budgetId: seeded.budget.id });
    const pages = (await seeded.scorecard.export({ project: 'acme/widgets', budgetId: seeded.budget.id })); assert.equal(pages.ok, true);
    const files = await (await import('../src/memory.js')).createMemory({ store: seeded.store, home: seeded.dir }).list({ project: 'acme/widgets', type: 'scorecard' });
    assert.equal(files.ok ? files.memories.length : -1, 1); assert.equal((seeded.store.sql.prepare('SELECT COUNT(*) AS count FROM memory_outbox').get() as { count: number }).count, 3);
    assert.ok(files.ok); assert.match(readFileSync(join(seeded.dir, 'memory', files.memories[0]!.path), 'utf8'), /# Scorecard/);
  } finally { seeded.store.close(); rmSync(seeded.dir, { recursive: true, force: true }); }
});

test('an adopted external merge with an inferred issue counts in scorecard and routing', async () => {
  const seeded = seed();
  try {
    const remote = JSON.parse(readFileSync(new URL('./fixtures/gh-pr-list.json', import.meta.url), 'utf8'))[0];
    const row = { ...worker('w-03d20cc7', 'codex/external'), branch: remote.headRefName };
    seeded.store.insertWorker(row);
    seeded.store.setMeta(row.workerId, { tier: 2 });
    const github = ghGitHub(async () => ({ stdout: JSON.stringify([remote]), stderr: '', code: 0 }));
    const tick = createPrTicker({ store: seeded.store, github, now: () => new Date('2026-10-01T00:00:00Z') });
    await tick(); await tick();
    const result = await seeded.scorecard.export({ project: 'acme/widgets' });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.json.tickets, 4);
    assert.equal(result.json.merged, 2);
    assert.deepEqual(result.json.outcomes.find((outcome) => outcome.model === row.model), { model: row.model, tier: 2, clean: 1, rework: 0, failed: 0 });
    assert.deepEqual(cleanRateForRouting(seeded.store, row.model, 2, new Date('2026-10-01T00:00:00Z'), row.repoSlug), { clean: 1, n: 1 });
  } finally { seeded.store.close(); rmSync(seeded.dir, { recursive: true, force: true }); }
});
