import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRetry } from '../src/retry.js';
import { openStore } from '../src/store.js';
import type { GitHub, WorkerRow } from '../src/types.js';
import { loadSettings } from '../src/settings.js';

const root = () => mkdtempSync(join(tmpdir(), 'helm-b8-'));
const worker = (id: string, state: WorkerRow['state'] = 'succeeded'): WorkerRow => ({
  workerId: id, repo: '/repo', repoSlug: 'o/r', role: 'builder', model: 'codex/luna', objective: 'x', acceptance: null,
  contextPaths: [], allowWorkflows: false, baseRef: 'main', baseSha: 'a'.repeat(40), branch: `helm/${id}`, worktree: '/repo/w',
  state, head: 'b'.repeat(40), sessionFile: '/session/immutable', result: null, rawResultText: null, idempotencyKey: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});
const github: GitHub = {
  async openPr() { return { number: 1, url: 'https://example.invalid' }; }, async prStatus() { throw new Error('unused'); },
  async comment() { return { body: 'REQUEST_CHANGES: fix the review body' }; }, async postComment() {}, async merge() {},
};
const settings = () => loadSettings(join(root(), 'missing'));

test('B8 names gate evidence and baseline test files, then preserves the worker row', async () => {
  const store = openStore(':memory:'); const log = join(root(), 'gate.log'); mkdirSync(join(log, '..'), { recursive: true }); writeFileSync(log, Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n'));
  store.insertWorker(worker('w-gate')); store.insertGate({ gateId: 'g', workerId: 'w-gate', head: 'b'.repeat(40), passed: false, at: '2026-01-02T00:00:00.000Z', checks: [{ name: 'typecheck', command: 'npm run typecheck', exitCode: 1, outputPath: log, durationMs: 1 }, { name: 'acceptance', command: 'npm test', exitCode: 1, outputPath: log, durationMs: 1 }] });
  store.sql.exec('CREATE TABLE baselines (id TEXT PRIMARY KEY, repoSlug TEXT, issue INTEGER, validatorId TEXT, baseRef TEXT, baseSha TEXT, testCommit TEXT, command TEXT, files TEXT, red INTEGER, outputPath TEXT, at TEXT)'); store.sql.prepare('INSERT INTO baselines (id, repoSlug, issue, validatorId, baseRef, baseSha, testCommit, command, files, red, outputPath, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('b1', 'o/r', 1, 'v', 'main', 'a'.repeat(40), 'c'.repeat(40), 'npm test', JSON.stringify(['test/b8.test.ts']), 1, log, '2026-01-01'); store.setMeta('w-gate', { baselineId: 'b1' });
  const service = createRetry({ store, settings: settings(), github }); let message = ''; const before = store.getWorker('w-gate')!.sessionFile;
  const result = await service.retry({ workerId: 'w-gate', kind: 'gate' }, async (_id, value) => { message = value; return { ok: true, turn: 2 }; });
  assert.equal(result.ok, true); assert.match(message, /typecheck/); assert.match(message, /line 44/); assert.match(message, /Do not edit test\/b8\.test\.ts/); assert.equal(store.getWorker('w-gate')!.sessionFile, before); store.close();
});

test('B8 names acceptance evidence and ignores a failure once the latest gate passes', async () => {
  const store = openStore(':memory:'); const log = join(root(), 'acceptance.log'); writeFileSync(log, 'acceptance failure'); store.insertWorker(worker('w-accept'));
  store.insertGate({ gateId: 'bad', workerId: 'w-accept', head: 'b'.repeat(40), passed: false, at: '2026-01-02', checks: [{ name: 'acceptance', command: 'npm test', exitCode: 1, outputPath: log, durationMs: 1 }] });
  const service = createRetry({ store, settings: settings(), github }); let message = ''; assert.equal((await service.retry({ workerId: 'w-accept', kind: 'acceptance' }, async (_id, value) => { message = value; return { ok: true, turn: 1 }; })).ok, true); assert.match(message, /acceptance/); assert.match(message, /acceptance failure/);
  store.insertGate({ gateId: 'good', workerId: 'w-accept', head: 'b'.repeat(40), passed: true, at: '2026-01-03', checks: [{ name: 'acceptance', command: 'npm test', exitCode: 0, outputPath: log, durationMs: 1 }] });
  const refused = await service.retry({ workerId: 'w-accept', kind: 'acceptance' }, async () => ({ ok: true, turn: 2 })); assert.equal(refused.ok, false); assert.match((refused as { reason: string }).reason, /no current acceptance failure at/); store.close();
});

test('B8 carries claims, review, tests-edited and conflict evidence and picks the latest failure', async () => {
  const store = openStore(':memory:'); store.insertWorker(worker('w-all')); store.insertPr({ number: 7, workerId: 'w-all', url: 'https://example.invalid/7', head: 'b'.repeat(40), createdAt: '2026-01-01' });
  store.sql.exec('CREATE TABLE claims_checks (workerId TEXT, head TEXT, passed INTEGER, detail JSON, jevCallId INTEGER, at TEXT); CREATE TABLE reviews (id INTEGER, repoSlug TEXT, number INTEGER, head TEXT, patchId TEXT, reviewer TEXT, stated TEXT, jevApprove REAL, verdict TEXT, commentUrl TEXT, at TEXT);');
  store.sql.prepare('INSERT INTO claims_checks VALUES (?, ?, 0, ?, NULL, ?)').run('w-all', 'b'.repeat(40), JSON.stringify({ failedClaims: ['claim text'], answers: { 'claim text': { choice: 'contradicts', supports: 0.2 } } }), '2026-01-04');
  store.sql.prepare('INSERT INTO reviews VALUES (1, ?, 7, ?, ?, ?, ?, ?, ?, ?, ?)').run('o/r', 'b'.repeat(40), 'p', 'reviewer', 'request_changes', 0, 'changes', 'https://github.com/o/r/issues/7#issuecomment-12', '2026-01-03');
  store.appendEvent('w-all', 'tool.refused', { tool: 'pr.open', head: 'b'.repeat(40), reason: 'baseline tests edited: test/a.ts, test/b.ts' }, '2026-01-02'); store.appendEvent('w-all', 'conflict', { head: 'b'.repeat(40), files: ['src/a.ts'] }, '2026-01-01');
  const service = createRetry({ store, settings: settings(), github }); const steer = async (_id: string, message: string) => ({ ok: true as const, turn: 1, message });
  assert.match((await service.retry({ workerId: 'w-all' }, steer) as { message: string }).message, /claim text.*contradicts.*0\.2/s);
  assert.match((await service.retry({ workerId: 'w-all', kind: 'claims' }, steer) as { message: string }).message, /claim text.*contradicts.*0\.2/s);
  assert.match((await service.retry({ workerId: 'w-all', kind: 'review' }, steer) as { message: string }).message, /review body/);
  assert.match((await service.retry({ workerId: 'w-all', kind: 'tests_edited' }, steer) as { message: string }).message, /test\/a\.ts/);
  assert.match((await service.retry({ workerId: 'w-all', kind: 'conflict' }, steer) as { message: string }).message, /src\/a\.ts/);
  store.close();
});

test('conflict retry uses the real service message with files and in-place commit instructions', async () => {
  const store = openStore(':memory:'); const current = 'c'.repeat(40); store.insertWorker(worker('w-conflict')); store.updateWorker('w-conflict', { head: current }); store.appendEvent('w-conflict', 'conflict', { head: current, files: ['src/conflicted.ts', 'docs/merge.md'] });
  const service = createRetry({ store, settings: settings(), github, workspace: { async head() { return current; } } }); let message = '';
  const result = await service.retry({ workerId: 'w-conflict', kind: 'conflict' }, async (_id, value) => { message = value; return { ok: true, turn: 1 }; });
  assert.equal(result.ok, true); assert.match(message, /src\/conflicted\.ts.*docs\/merge\.md/s); assert.match(message, /merge is IN PROGRESS/i); assert.match(message, /resolve the markers in place and commit/i); assert.match(message, /do NOT run `git merge --abort`, reset, or rebase/); store.close();
});

test('B8 omitted kind selects latest, limits one kind independently, and refuses unknown/running workers', async () => {
  const store = openStore(':memory:'); store.insertWorker(worker('w-limit')); store.appendEvent('w-limit', 'conflict', { head: 'b'.repeat(40), files: ['x.ts'] });
  const service = createRetry({ store, settings: settings(), github }); const steer = async () => ({ ok: true as const, turn: 1 });
  assert.equal((await service.retry({ workerId: 'w-limit', kind: 'conflict' }, steer)).ok, true); assert.equal((await service.retry({ workerId: 'w-limit', kind: 'conflict' }, steer)).ok, true);
  const third = await service.retry({ workerId: 'w-limit', kind: 'conflict' }, steer); assert.equal(third.ok, false); assert.match((third as { reason: string }).reason, /retry limit reached for conflict: respawn or ask Nick/);
  assert.equal((await service.retry({ workerId: 'w-limit', kind: 'gate' }, steer)).ok, false);
  store.insertWorker(worker('w-running', 'running')); assert.equal((await service.retry({ workerId: 'w-running' }, steer)).ok, false); assert.equal((await service.retry({ workerId: 'missing' }, steer)).ok, false); store.close();
});

test('B8 refuses a failure recorded at an old head', async () => {
  const store = openStore(':memory:'); store.insertWorker(worker('w-old'));
  store.insertGate({ gateId: 'old', workerId: 'w-old', head: 'a'.repeat(40), passed: false, at: '2026-01-05', checks: [{ name: 'test', command: 'npm test', exitCode: 1, outputPath: '/missing', durationMs: 1 }] });
  const service = createRetry({ store, settings: settings(), github }); const result = await service.retry({ workerId: 'w-old', kind: 'gate' }, async () => ({ ok: true, turn: 1 }));
  assert.equal(result.ok, false); assert.match((result as { reason: string }).reason, /no current gate failure at b{40}/); store.close();
});
