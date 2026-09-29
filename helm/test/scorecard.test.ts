import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachWorker, openBudget } from '../src/budget.js';
import { createMemory } from '../src/memory.js';
import { createScorecard } from '../src/scorecard.js';
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
  store.setMeta(clean.workerId, { issue: 101, band: 'small' }); store.setMeta(rework.workerId, { issue: 102, band: 'medium' }); store.setMeta(failed.workerId, { issue: 103, band: 'large' }); store.setMeta(respawn.workerId, { issue: 103, band: 'large' }); store.setMeta(validator.workerId, { issue: 101, band: 'small' });
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
    assert.deepEqual(result.json, { project: 'acme/widgets', window: { budgetId: seeded.budget.id, label: 'sprint-1', openedAt: base, closedAt: '2026-09-30T00:30:00.000Z' }, tickets: 3, merged: 1, firstPassGateRate: 0.3333, claimsPassRate: 0.6667, firstReviewApprovalRate: 0.5, retriesPerTicket: { gate: 0.3333, review: 0.3333 }, activeMinutes: 0.08, codexTokens: 160, usd: 0, jevCalls: 0, jevCost: null, deploys: 0, rollbacks: 0, taps: 0, outcomes: [{ model: 'codex/luna', band: 'medium', clean: 0, rework: 1, failed: 0 }, { model: 'codex/luna', band: 'small', clean: 1, rework: 0, failed: 0 }, { model: 'codex/terra', band: 'large', clean: 1, rework: 0, failed: 1 }] });
    assert.equal(result.markdown, '# Scorecard acme/widgets — sprint-1\n\nWindow: 2026-09-30T00:00:00.000Z .. 2026-09-30T00:30:00.000Z\n\n## Delivery\n\n| Metric | Value |\n| --- | ---: |\n| Tickets | 3 |\n| Merged | 1 |\n| First-pass gate rate | 33.33% |\n| Claims pass rate | 66.67% |\n| First-review approval rate | 50.00% |\n| Active minutes | 0.08 |\n| Codex tokens | 160 |\n| USD | 0.0000 |\n| Jev calls | 0 |\n| Jev cost | n/a (not recorded) |\n| Deploys | 0 |\n| Rollbacks | 0 |\n| Taps | 0 |\n\n## Retries per ticket\n\n| Kind | Retries per ticket |\n| --- | ---: |\n| gate | 0.3333 |\n| review | 0.3333 |\n\n## Model × complexity band\n\n| Model | Band | Clean | Rework | Failed |\n| --- | --- | ---: | ---: | ---: |\n| codex/luna | medium | 0 | 1 | 0 |\n| codex/luna | small | 1 | 0 | 0 |\n| codex/terra | large | 1 | 0 | 1 |\n');
  } finally { seeded.store.close(); rmSync(seeded.dir, { recursive: true, force: true }); }
});

test('a single steer turn is rework even without a failed gate or request changes', async () => {
  const seeded = seed();
  try {
    seeded.store.sql.prepare("UPDATE gates SET passed = 1 WHERE gateId = 'g-rework'").run();
    seeded.store.sql.prepare('DELETE FROM reviews WHERE id = 2').run();
    const result = await seeded.scorecard.export({ project: 'acme/widgets', budgetId: seeded.budget.id });
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.json.outcomes.find((outcome) => outcome.model === 'codex/luna' && outcome.band === 'medium'), { model: 'codex/luna', band: 'medium', clean: 0, rework: 1, failed: 0 });
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
