import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevCheck } from '../src/jevcheck.js';
import type { Jev } from '../src/jev.js';
import { createJev } from '../src/jev.js';
import { openStore } from '../src/store.js';
import { loadSettings } from '../src/settings.js';

function fakeJev(answers: Record<string, unknown>, calls: Array<{ purpose: string; input: unknown }> = []): Jev {
  return { shadow: true, async ask(purpose, input) { calls.push({ purpose, input }); return { ok: true, answers: answers as never }; } };
}

test('issue flags use the exact 0.5 boundaries', async () => {
  const store = openStore(':memory:');
  try {
    const calls: Array<{ purpose: string; input: unknown }> = [];
    const check = createJevCheck({ jev: fakeJev({ testable: { noul: 0.49 }, too_big: { noul: 0.5 }, complexity: { score: 1.2, probabilities: { '0': 0, '1': 1, '2': 0 } } }, calls), store });
    const result = await check.check({ preset: 'issue', input: 'ticket' });
    assert.deepEqual(result.ok && result.flags, { testable: true, too_big: true });
    assert.deepEqual((calls[0]?.input as { questions: unknown }).questions, {
      testable: { type: 'noul', instructions: 'Does this ticket state a concrete, checkable definition of done (specific commands, tests, files or observable behaviour an automated gate or reviewer can verify)?', criteria: { true: 'done is objectively checkable', false: 'done is vague or left to judgement' } },
      too_big: { type: 'noul', instructions: 'Is this ticket too big or too multi-part for one coding worker in one session, such that it should have been split into smaller tickets?', criteria: { true: 'should be split', false: 'fits one worker' } },
      complexity: { type: 'score', instructions: 'How much engineering work will a competent coding agent need to complete this ticket (reading, editing, testing), judged from its scope and number of moving parts?', criteria: ['trivial: a mechanical copy, one-line change or read-only check', 'small: one file or one focused function plus a test', 'medium: several files or one subsystem, needs design judgement', 'large: many files across subsystems, UI plus backend, or several loosely related items'] },
    });
    const boundary = createJevCheck({ jev: fakeJev({ testable: { noul: 0.5 }, too_big: { noul: 0.49 }, complexity: { score: 0.5 } }), store });
    const second = await boundary.check({ preset: 'issue', input: 'ticket' });
    assert.deepEqual(second.ok && second.flags, { testable: false, too_big: false });
    assert.deepEqual(second.ok && second.complexity, { score: 0.5, band: 'trivial' });
  } finally { store.close(); }
});

test('dedupe calls once per pair, uses indexed probabilities, and limits concurrency to four', async () => {
  const store = openStore(':memory:'); const calls: Array<{ purpose: string; input: unknown }> = []; let active = 0; let maximum = 0;
  try {
    const jev: Jev = { shadow: true, async ask(purpose, input) { calls.push({ purpose, input }); active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1; return { ok: true, answers: { relation: { score: 2, probabilities: { '0': 0, '1': 0, '2': 0.5 } } } }; } };
    const check = createJevCheck({ jev, store });
    const result = await check.check({ preset: 'dedupe', input: { candidate: 'new', against: Array.from({ length: 45 }, (_, number) => ({ number, title: 'a'.repeat(4000), body: 'b'.repeat(4000) })) } });
    assert.equal(calls.length, 40); assert.equal(maximum, 4); assert.equal(result.ok, true);
    const state = (calls[0]?.input as { state: string }).state;
    assert.equal(state.startsWith('Ticket A: new\n\nTicket B: '), true);
    assert.equal(state.length <= 6_050, true);
    if (result.ok) assert.equal((result.duplicates as unknown[]).length, 40);
  } finally { store.close(); }
});

test('dedupe no key returns safe failure', async () => {
  const store = openStore(':memory:');
  try {
    const jev = createJev({ settings: loadSettings('/definitely/missing-helm-home'), store, env: { HOME: '/definitely/missing' } });
    const result = await createJevCheck({ jev, store }).check({ preset: 'dedupe', input: { candidate: 'a', against: [{ number: 1, title: 'b', body: 'c' }] } });
    assert.deepEqual(result, { ok: false, reason: 'no key' });
  } finally { store.close(); }
});

test('A1 logs dedupe purpose, truncates raw questions, hides a sentinel key, and label fills the row', async () => {
  const store = openStore(':memory:'); const sentinel = 'jev-sentinel-never-output'; let requestBody = '';
  try {
    const jev = createJev({ settings: loadSettings('/definitely/missing-helm-home'), store, env: { TYPESAFE_API_KEY: sentinel }, fetch: async (_url, init) => {
      requestBody = String(init?.body); assert.ok(requestBody.length < 7000); return new Response(JSON.stringify({ answers: { relation: { score: 1, probabilities: { '0': 0, '1': 1, '2': 0 } } } }), { status: 200 });
    } });
    const service = createJevCheck({ jev, store });
    const result = await service.check({ preset: 'dedupe', input: { candidate: 'candidate', against: [{ number: 1, title: 'related', body: 'body' }] } });
    assert.equal(result.ok, true); assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
    const row = store.sql.prepare('SELECT id, purpose, questions FROM jev_calls').get() as { id: number; purpose: string; questions: string };
    assert.equal(row.purpose, 'check.dedupe'); assert.ok(JSON.stringify(row).length > 0); assert.ok(JSON.parse(requestBody).state.includes('Ticket A')); assert.doesNotMatch(JSON.stringify(row), new RegExp(sentinel));
    assert.equal((await service.label({ id: row.id, label: 'accepted' })).ok, true);
    assert.equal((store.sql.prepare('SELECT label FROM jev_calls WHERE id = ?').get(row.id) as { label: string }).label, 'accepted');
  } finally { store.close(); }
});

test('raw caps questions at six and related results produce links', async () => {
  const store = openStore(':memory:'); const calls: Array<{ purpose: string; input: unknown }> = [];
  try {
    const check = createJevCheck({ jev: fakeJev({ relation: { score: 1, probabilities: { '0': 0, '1': 0.8, '2': 0.2 } }, q: { noul: true } }, calls), store });
    const raw = await check.check({ preset: 'raw', input: { state: {}, questions: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `q${i}` }])) } });
    assert.equal(raw.ok, true); assert.equal(Object.keys((calls[0]?.input as { questions: object }).questions).length, 6);
    const related = await check.check({ preset: 'dedupe', input: { candidate: 'a', against: [{ number: 9, title: 'b', body: 'c' }] } });
    assert.equal(related.ok, true); if (related.ok) assert.deepEqual(related.related, [{ number: 9, link: '#9' }]);
  } finally { store.close(); }
});
