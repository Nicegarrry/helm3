import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevCheck } from '../src/jevcheck.js';
import type { Jev } from '../src/jev.js';
import { createJev } from '../src/jev.js';
import { openStore } from '../src/store.js';
import { loadSettings } from '../src/settings.js';

function fakeJev(answers: Record<string, unknown>, purposes: string[] = []): Jev {
  return { shadow: true, async ask(purpose) { purposes.push(purpose); return { ok: true, answers: answers as never }; } };
}

test('issue flags use the exact 0.5 boundaries', async () => {
  const store = openStore(':memory:');
  try {
    const check = createJevCheck({ jev: fakeJev({ testable: { noul: 0.49 }, too_big: { noul: 0.5 }, complexity: { score: 'small' } }), store });
    const result = await check.check({ preset: 'issue', input: 'ticket' });
    assert.deepEqual(result.ok && result.flags, { testable: true, too_big: true });
    const boundary = createJevCheck({ jev: fakeJev({ testable: { noul: 0.5 }, too_big: { noul: 0.49 }, complexity: { score: 'small' } }), store });
    const second = await boundary.check({ preset: 'issue', input: 'ticket' });
    assert.deepEqual(second.ok && second.flags, { testable: false, too_big: false });
  } finally { store.close(); }
});

test('dedupe calls once per pair and flags same at 0.5', async () => {
  const store = openStore(':memory:'); const purposes: string[] = [];
  try {
    const check = createJevCheck({ jev: fakeJev({ relation: { probabilities: { same: 0.5 }, choice: 'same' } }, purposes), store });
    const result = await check.check({ preset: 'dedupe', input: { candidate: 'new', against: [{ number: 1, title: 'a', body: 'a' }, { number: 2, title: 'b', body: 'b' }] } });
    assert.equal(purposes.length, 2); assert.equal(result.ok, true);
    if (result.ok) assert.equal((result.duplicates as unknown[]).length, 2);
  } finally { store.close(); }
});

test('no key returns safe failure and never exposes the key', async () => {
  const store = openStore(':memory:');
  try {
    const jev = createJev({ settings: loadSettings('/definitely/missing-helm-home'), store, env: { HOME: '/definitely/missing' } });
    const result = await createJevCheck({ jev, store }).check({ preset: 'issue', input: 'ticket' });
    assert.deepEqual(result, { ok: false, reason: 'no key' });
    assert.doesNotMatch(JSON.stringify(result), /TYPESAFE_API_KEY|sentinel/);
  } finally { store.close(); }
});
