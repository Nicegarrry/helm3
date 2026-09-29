import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkEnvelope, envelopePath } from '../src/envelope.js';
import type { Jev, JevAskInput } from '../src/jev.js';
import { envelopeCheckInput } from '../src/types.js';

const project = 'acme/app';

function home(): string { return mkdtempSync(join(tmpdir(), 'helm-envelope-check-')); }
function fakeJev(score: number | boolean, calls: JevAskInput[] = []): Jev {
  return { shadow: false, async ask(_purpose, input) { calls.push(input); return { ok: true, answers: Object.fromEntries(Object.keys(input.questions).map((key) => [key, { noul: score }])) }; } };
}
function putEnvelope(root: string, value: Record<string, unknown>): void {
  const path = envelopePath(root, project);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
async function one(action: string, jev: Jev | undefined, root: string, kind?: string) {
  return (await checkEnvelope(root, { project, actions: [action], kind }, { jev, envelopeTapAt: 0.5 }))[0]!;
}

test('every hard-rule category taps, while a near miss reaches Jev', async () => {
  const cases = [
    ['git push origin +main', 'git push origin feature/c3'],
    ['run deploy --admin', 'run admin report'],
    ['print API_TOKEN', 'print README'],
    ['delete prod customer data', 'delete staging customer data'],
    ['upgrade paid plan', 'read plan docs'],
    ['change provider account settings', 'read provider docs'],
    ['message Alex', 'message Nick'],
    ['raise budget cap', 'show budget status'],
    ['edit AGENTS.md hooks', 'read AGENTS.md'],
  ] as const;
  const root = home();
  try {
    for (const [positive, negative] of cases) {
      const positiveResult = await one(positive, fakeJev(0), root);
      assert.deepEqual(positiveResult, { action: positive, decision: 'tap', source: 'hard', pTap: null });
      const negativeResult = await one(negative, fakeJev(0), root);
      assert.deepEqual(negativeResult, { action: negative, decision: 'allow', source: 'jev', pTap: 0 });
    }
    const migration = await one('apply migration on prod', fakeJev(0), root, 'convex.migration');
    assert.equal(migration.source, 'hard');
    assert.equal(migration.decision, 'tap');
    assert.equal((await one('message Nick and Alex', fakeJev(0), root)).source, 'hard');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tapOnly and deploy never are enforced by the envelope', async () => {
  const root = home();
  try {
    putEnvelope(root, { rules: ['Only ship reviewed changes.'], budget: { maxSprintUsd: 1, maxSprintCodexTokens: 2 }, deploy: { prod: 'never' }, tapOnly: ['dependency.major'] });
    const calls: JevAskInput[] = [];
    const tapOnly = await one('upgrade dependency', fakeJev(0, calls), root, 'dependency.major');
    const never = await one('deploy the release', fakeJev(0, calls), root, 'deploy.prod');
    assert.equal(tapOnly.source, 'envelope');
    assert.equal(tapOnly.decision, 'tap');
    assert.equal(never.source, 'envelope');
    assert.equal(never.decision, 'never');
    assert.equal(calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Jev uses the 0.5 boundary and fails closed without a key or on error', async () => {
  const root = home();
  try {
    assert.deepEqual(await one('run the unit tests', fakeJev(0.49), root), { action: 'run the unit tests', decision: 'allow', source: 'jev', pTap: 0.49 });
    assert.deepEqual(await one('run the unit tests', fakeJev(0.5), root), { action: 'run the unit tests', decision: 'tap', source: 'jev', pTap: 0.5 });
    assert.deepEqual(await one('run the unit tests', undefined, root), { action: 'run the unit tests', decision: 'tap', source: 'jev', pTap: null });
    const errorJev: Jev = { shadow: false, async ask() { throw new Error('upstream'); } };
    assert.deepEqual(await one('run the unit tests', errorJev, root), { action: 'run the unit tests', decision: 'tap', source: 'jev', pTap: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('batches thirteen actions once, refuses fourteen, and quotes action text safely', async () => {
  const root = home();
  try {
    const calls: JevAskInput[] = [];
    const actions = Array.from({ length: 13 }, (_, i) => `run check ${i}`);
    const result = await checkEnvelope(root, { project, actions }, { jev: fakeJev(0, calls), envelopeTapAt: 0.5 });
    assert.equal(result.length, 13);
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]!.questions), actions.map((_, i) => `a${i}`));
    const injected = 'say "hi"\nnext';
    const escapedCalls: JevAskInput[] = [];
    await checkEnvelope(root, { project, actions: [injected] }, { jev: fakeJev(0, escapedCalls), envelopeTapAt: 0.5 });
    assert.match(escapedCalls[0]!.questions.a0!.instructions, /Proposed supervisor action: "say \\"hi\\"\\nnext"\nDoes this action/);
    assert.equal(envelopeCheckInput.safeParse({ project, actions }).success, true);
    assert.equal(envelopeCheckInput.safeParse({ project, actions: [...actions, 'fourteen'] }).success, false);
    await assert.rejects(() => checkEnvelope(root, { project, actions: [...actions, 'fourteen'] }, { jev: fakeJev(0), envelopeTapAt: 0.5 }), /1 to 13/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
