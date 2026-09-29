import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscord } from '../src/discord.js';
import { openStore } from '../src/store.js';

function settings(maxPerHour = 20) {
  return { discord: { projects: { 'o/r': { webhookEnv: 'HELM_TEST_WEBHOOK' } }, digestSec: 60, maxPerHour } };
}

test('maps milestone events, batches them, and never leaks the webhook URL', async () => {
  const store = openStore(':memory:');
  const sentinel = 'https://discord.test/webhook/sentinel-never-log';
  const calls: Array<{ url: string; body: string }> = [];
  const logs: string[] = [];
  let clock = new Date('2026-01-01T00:00:00.000Z');
  try {
    const discord = createDiscord({ store, settings: settings(), env: { HELM_TEST_WEBHOOK: sentinel }, home: '/tmp', now: () => clock,
      fetch: async (url, init) => { calls.push({ url: String(url), body: String(init?.body) }); return new Response('{}', { status: 200 }); }, log: (line) => logs.push(line) });
    const events = [
      ['pr', { number: 7 }], ['pr.merged', { number: 7 }], ['watch.alert', { rule: 'silence' }],
      ['spend.warning', { spendUsd: 8 }], ['inbox.triage', { route: 'needs_human' }], ['state', { to: 'failed' }],
    ] as const;
    for (const [kind, data] of events) store.appendEvent('w-1', kind, { ...data, project: 'o/r' }, clock.toISOString());
    await discord.tick();
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, sentinel);
    const payload = JSON.parse(calls[0]!.body) as { content: string; username: string; allowed_mentions: { parse: string[] } };
    assert.match(payload.content, /PR opened: #7/);
    assert.match(payload.content, /Merged: #7/);
    assert.match(payload.content, /Needs Nick/);
    assert.equal(payload.username, 'Helm');
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(logs.some((line) => line.includes(sentinel)), false);
    assert.equal(JSON.stringify(store.listAllEvents()).includes(sentinel), false);
  } finally { store.close(); }
});

test('caps digest posts with one muted line and rate-limits notify.nick', async () => {
  const store = openStore(':memory:');
  const bodies: string[] = [];
  let clock = new Date('2026-01-01T00:00:00.000Z');
  try {
    const discord = createDiscord({ store, settings: settings(1), env: { HELM_TEST_WEBHOOK: 'https://discord.test/x' }, home: '/tmp', now: () => clock,
      fetch: async (_url, init) => { bodies.push(String(init?.body)); return new Response('{}', { status: 200 }); } });
    assert.deepEqual(await discord.notifyNick('o/r', 'urgent'), { ok: true, sent: true });
    assert.equal((await discord.notifyNick('o/r', 'again')).ok, false);
    store.appendEvent('w-1', 'pr', { number: 1, project: 'o/r' }, clock.toISOString());
    await discord.tick();
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.equal(bodies.length, 2);
    assert.match(bodies[1]!, /muted for/);
  } finally { store.close(); }
});

test('missing webhook configuration is a no-op', async () => {
  const store = openStore(':memory:');
  let fetches = 0;
  try {
    const discord = createDiscord({ store, settings: settings(), env: {}, home: '/tmp', fetch: async () => { fetches += 1; return new Response('{}'); } });
    store.appendEvent('w-1', 'pr', { number: 1, project: 'o/r' });
    await discord.tick();
    assert.equal(fetches, 0);
  } finally { store.close(); }
});
