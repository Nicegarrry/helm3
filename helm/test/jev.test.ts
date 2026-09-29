import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createJev, type JevResult } from '../src/jev.js';
import { openStore } from '../src/store.js';
import { loadSettings } from '../src/settings.js';

function settings() {
  return loadSettings('/definitely/missing/helm-home');
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'helm-jev-'));
}

test('Jev sends questions, returns answers, and records one call', async () => {
  const store = openStore(':memory:');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  try {
    const jev = createJev({
      settings: settings(),
      store,
      env: { TYPESAFE_API_KEY: 'test-key' },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({
          answers: { route: { choice: 'needs_supervisor', confidence: 0.8, probabilities: { needs_supervisor: 0.8 } } },
          usage: { input_tokens: 12 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const result = await jev.ask('triage', {
      workerId: 'w-1',
      project: 'owner/repo',
      state: 'question state',
      questions: { route: { type: 'choice', instructions: 'route it', criteria: { needs_supervisor: 'needs review' } } },
    });
    assert.deepEqual(result, {
      ok: true,
      answers: { route: { choice: 'needs_supervisor', confidence: 0.8, probabilities: { needs_supervisor: 0.8 } } },
    });
    assert.equal(jev.shadow, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, 'Bearer test-key');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      model: 'jev-latest',
      state: 'question state',
      questions: { route: { type: 'choice', instructions: 'route it', criteria: { needs_supervisor: 'needs review' } } },
    });

    const row = store.sql.prepare('SELECT * FROM jev_calls').get() as Record<string, unknown>;
    assert.equal(row.purpose, 'triage');
    assert.equal(row.workerId, 'w-1');
    assert.equal(row.project, 'owner/repo');
    assert.equal(row.model, 'jev-latest');
    assert.equal(row.confidence, 0.8);
    assert.equal(row.inputTokens, 12);
    assert.equal(row.shadow, 1);
    assert.equal(row.error, null);
    const countRow = store.sql.prepare('SELECT COUNT(*) AS count FROM jev_calls').get() as { count: number };
    assert.equal(countRow.count, 1);
  } finally {
    store.close();
  }
});

test('Jev does not fetch without a key and records a safe failure', async () => {
  const store = openStore(':memory:');
  let fetches = 0;
  try {
    const jev = createJev({
      settings: settings(),
      store,
      env: { HOME: '/definitely/missing' },
      fetch: async () => { fetches += 1; return new Response('{}'); },
    });
    const result = await jev.ask('attention', { state: {}, questions: { stuck: { type: 'noul', instructions: 'stuck?' } } });
    assert.deepEqual(result, { ok: false, reason: 'no key' });
    assert.equal(fetches, 0);
    const row = store.sql.prepare('SELECT error FROM jev_calls').get() as { error: string };
    assert.equal(row.error, 'no key');
  } finally {
    store.close();
  }
});

test('Jev retries a server error twice and never stores the API key', async () => {
  const store = openStore(':memory:');
  const sentinel = 'sentinel-api-key-never-store';
  let attempts = 0;
  try {
    const jev = createJev({
      settings: settings(),
      store,
      env: { TYPESAFE_API_KEY: sentinel },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) return new Response('temporary failure', { status: 500 });
        return new Response(JSON.stringify({ answers: { ok: { noul: true } } }), { status: 200 });
      },
    });
    const result = await jev.ask('check', { state: {}, questions: { ok: { type: 'noul', instructions: 'okay?' } } });
    assert.deepEqual(result, { ok: true, answers: { ok: { noul: true } } });
    assert.equal(attempts, 2);
    const row = store.sql.prepare('SELECT * FROM jev_calls').get() as Record<string, unknown>;
    assert.equal(row.error, null);
    assert.ok(!JSON.stringify(row).includes(sentinel));
  } finally {
    store.close();
  }
});

test('Jev redacts the API key from thrown fetch errors and does not throw', async () => {
  const store = openStore(':memory:');
  const sentinel = 'sentinel-api-key-in-fetch-error';
  try {
    const jev = createJev({
      settings: settings(),
      store,
      env: { TYPESAFE_API_KEY: sentinel },
      fetch: async () => {
        throw new Error(`upstream failure: ${sentinel}`);
      },
    });

    let result: JevResult | undefined;
    await assert.doesNotReject(async () => {
      result = await jev.ask('error', { state: {}, questions: { ok: { type: 'noul', instructions: 'okay?' } } });
    });
    assert.ok(result);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(!result.reason.includes(sentinel));

    const row = store.sql.prepare('SELECT * FROM jev_calls').get() as Record<string, unknown>;
    assert.equal(row.error, 'upstream failure: [redacted]');
    assert.ok(!JSON.stringify(row).includes(sentinel));
  } finally {
    store.close();
  }
});

test('Jev reads the API key from the typesafe env file and times out response parsing', async () => {
  const home = tempHome();
  const store = openStore(':memory:');
  try {
    mkdirSync(join(home, '.config', 'typesafe'), { recursive: true });
    writeFileSync(join(home, '.config', 'typesafe', 'env'), 'TYPESAFE_API_KEY=file-key\n');
    const jev = createJev({
      settings: { ...settings(), jev: { ...settings().jev, timeoutMs: 5 } },
      store,
      env: { HOME: home },
      fetch: async (_url, init) => {
        assert.equal(((init ?? {}).headers as Record<string, string>).Authorization, 'Bearer file-key');
        return { ok: true, status: 200, json: async () => new Promise(() => {}) } as Response;
      },
    });
    const result = await jev.ask('timeout', { state: {}, questions: { ok: { type: 'noul', instructions: 'okay?' } } });
    assert.deepEqual(result, { ok: false, reason: 'request timeout' });
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
