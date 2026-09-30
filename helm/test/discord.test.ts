import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscord as createDiscordImpl } from '../src/discord.js';
import { openStore } from '../src/store.js';

const TEST_ENV_FILE = '/definitely-missing/helm-discord-test-env';
const createDiscord = (options: Parameters<typeof createDiscordImpl>[0]) => createDiscordImpl({ ...options, envFile: TEST_ENV_FILE });

function settings(maxPerHour = 20) {
  return { discord: { projects: { 'o/r': { webhookEnv: 'HELM_TEST_WEBHOOK' } }, digestSec: 60, maxPerHour } };
}

test('tap posts use the dedicated tap webhook, separate from milestone webhooks', async () => {
  const store = openStore(':memory:');
  const calls: string[] = [];
  try {
    const discord = createDiscord({ store, settings: { discord: { projects: { 'o/r': { webhookEnv: 'HELM_TEST_WEBHOOK' } }, digestSec: 60, maxPerHour: 20, tapWebhookEnv: 'HELM_TAP_WEBHOOK' } }, env: {
      HELM_TEST_WEBHOOK: 'https://discord.test/milestones', HELM_TAP_WEBHOOK: 'https://discord.test/taps',
    }, fetch: async (url) => { calls.push(String(url)); return new Response('{}', { status: 200 }); } });
    assert.deepEqual(await discord.notifyNick('o/r', 'milestone'), { ok: true, sent: true });
    assert.deepEqual(await discord.postTap('tap message'), { ok: true });
    assert.deepEqual(calls, ['https://discord.test/milestones', 'https://discord.test/taps']);
  } finally { store.close(); }
});

test('tap webhook comparison normalizes host, trailing slash, query, and fragment', async () => {
  const store = openStore(':memory:');
  try {
    const discord = createDiscord({ store, settings: { discord: { projects: { 'o/r': { webhookEnv: 'HELM_TEST_WEBHOOK' } }, digestSec: 60, maxPerHour: 20, tapWebhookEnv: 'HELM_TAP_WEBHOOK' } }, env: {
      HELM_TEST_WEBHOOK: 'HTTPS://DISCORD.TEST/taps/?ignored=1#fragment', HELM_TAP_WEBHOOK: 'https://discord.test/taps',
    }, fetch: async () => new Response('{}', { status: 200 }) });
    assert.deepEqual(await discord.postTap('tap message'), { ok: false, reason: 'tap channel must differ from the milestone channel' });
  } finally { store.close(); }
});

test('tap webhook comparison canonicalizes Discord webhook host and API version forms', async () => {
  const store = openStore(':memory:');
  try {
    const discord = createDiscord({ store, settings: { discord: { projects: { 'o/r': { webhookEnv: 'HELM_TEST_WEBHOOK' } }, digestSec: 60, maxPerHour: 20, tapWebhookEnv: 'HELM_TAP_WEBHOOK' } }, env: {
      HELM_TEST_WEBHOOK: 'https://discordapp.com/api/v10/webhooks/123/token', HELM_TAP_WEBHOOK: 'https://discord.com/api/webhooks/123/token',
    }, fetch: async () => new Response('{}', { status: 200 }) });
    assert.deepEqual(await discord.postTap('tap message'), { ok: false, reason: 'tap channel must differ from the milestone channel' });
  } finally { store.close(); }
});

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
      ['spend.warning', { spendUsd: 8 }], ['spend.invalid', { reason: 'helm.json invalid; keeping last good limits' }], ['spend.changed', { source: 'file' }], ['spend.changed', { source: 'startup', values: { capUsd: 10, warnUsd: 8, maxWorkers: 3 } }], ['inbox.triage', { inboxId: 'q-1', route: 'needs_human', shadow: true, question: 'approve it' }], ['state', { to: 'failed' }],
    ] as const;
    for (const [kind, data] of events) store.appendEvent('w-1', kind, { ...data, project: 'o/r' }, clock.toISOString());
    await discord.tick();
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, sentinel);
    const payload = JSON.parse(calls[0]!.body) as { content: string; username: string; allowed_mentions: { parse: string[] } };
    assert.match(payload.content, /#7/);
    assert.match(payload.content, /Needs Nick/);
    assert.match(payload.content, /helm\.json invalid; keeping last good limits/);
    assert.match(payload.content, /Spend changed: file/);
    assert.match(payload.content, /Helm started: spend cap \$10, warn \$8, max workers 3/);
    assert.equal(payload.username, 'Helm');
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.equal(logs.some((line) => line.includes(sentinel)), false);
    assert.equal(JSON.stringify(store.listAllEvents()).includes(sentinel), false);
  } finally { store.close(); }
});

test('global milestones fan out to deduplicated project webhooks and state uncapped startup limits', async () => {
  const store = openStore(':memory:');
  const calls: Array<{ url: string; body: string }> = [];
  let clock = new Date('2026-01-01T00:00:00.000Z');
  try {
    const discord = createDiscord({ store, settings: { discord: { projects: {
      'o/one': { webhookEnv: 'HELM_ONE' }, 'o/two': { webhookEnv: 'HELM_TWO' }, 'o/duplicate': { webhookEnv: 'HELM_DUPLICATE' },
    }, digestSec: 60, maxPerHour: 20, tapWebhookEnv: 'HELM_TAP_WEBHOOK' } }, env: {
      HELM_ONE: 'https://discord.com/api/v10/webhooks/1/token', HELM_TWO: 'https://discord.test/two',
      HELM_DUPLICATE: 'https://discordapp.com/api/webhooks/1/token', HELM_TAP_WEBHOOK: 'https://discord.test/taps',
    }, now: () => clock, fetch: async (url, init) => { calls.push({ url: String(url), body: String(init?.body) }); return new Response('{}', { status: 200 }); } });
    store.appendEvent('project:global', 'spend.changed', { project: 'global', source: 'startup', values: { capUsd: 0, warnUsd: 80, maxWorkers: 5 } }, clock.toISOString());
    await discord.tick();
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.deepEqual(calls.map((call) => call.url), ['https://discord.com/api/v10/webhooks/1/token', 'https://discord.test/two']);
    assert.ok(calls.every((call) => call.body.includes('Helm started: NO spend cap, warn $80, max workers 5')));
  } finally { store.close(); }
});

test('globalWebhookEnv receives global milestones instead of project webhooks', async () => {
  const store = openStore(':memory:');
  const calls: string[] = [];
  let clock = new Date('2026-01-01T00:00:00.000Z');
  try {
    const discord = createDiscord({ store, settings: { discord: { projects: {
      'o/one': { webhookEnv: 'HELM_ONE' }, 'o/two': { webhookEnv: 'HELM_TWO' },
    }, digestSec: 60, maxPerHour: 20, globalWebhookEnv: 'HELM_GLOBAL' } }, env: {
      HELM_ONE: 'https://discord.test/one', HELM_TWO: 'https://discord.test/two', HELM_GLOBAL: 'https://discord.test/global',
    }, now: () => clock, fetch: async (url) => { calls.push(String(url)); return new Response('{}', { status: 200 }); } });
    store.appendEvent('project:global', 'spend.changed', { project: 'global', source: 'startup', values: { capUsd: 100, warnUsd: 80, maxWorkers: 5 } }, clock.toISOString());
    await discord.tick();
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.deepEqual(calls, ['https://discord.test/global']);
  } finally { store.close(); }
});

test('formats dispatch, PR, merge, and deployment milestone lines', async () => {
  const store = openStore(':memory:');
  const bodies: string[] = [];
  let clock = new Date('2026-01-01T00:00:00.000Z');
  try {
    const discord = createDiscord({ store, settings: { discord: { projects: { 'o/r': { webhookEnv: 'HELM_TEST_WEBHOOK' }, 'o/other': { webhookEnv: 'HELM_TEST_WEBHOOK_2' } }, digestSec: 60, maxPerHour: 20 } }, env: { HELM_TEST_WEBHOOK: 'https://discord.test/one', HELM_TEST_WEBHOOK_2: 'https://discord.test/two' }, now: () => clock,
      fetch: async (_url, init) => { bodies.push(String(init?.body)); return new Response('{}', { status: 200 }); } });
    store.appendEvent('w-1', 'dispatched', { project: 'o/r', issue: 260, title: 'Discord milestones', model: 'codex/model', tier: 3 });
    store.appendEvent('w-1', 'pr', { project: 'o/r', number: 12, title: 'PR title', url: 'https://github.test/12', updated: true });
    store.appendEvent('w-1', 'pr.merged', { project: 'o/r', number: 12, title: 'PR title', base: 'main', url: 'https://github.test/12' });
    store.appendEvent('project:o/r', 'deploy', { project: 'o/r', target: 'prod', env: 'production', sha: 'abcdef1', url: 'https://app.test', pr: 12, issue: 260 });
    await discord.tick(); clock = new Date(clock.getTime() + 60_000); await discord.tick();
    const content = bodies.map((body) => JSON.parse(body) as { content: string }).map((body) => body.content).join('\n');
    assert.match(content, /Dispatched w-1 on #260 Discord milestones \(codex\/model, tier 3\)/);
    assert.match(content, /PR updated: o\/r #12 PR title https:\/\/github\.test\/12/);
    assert.match(content, /o\/r #12 PR title merged into main https:\/\/github\.test\/12/);
    assert.match(content, /Deployed: prod production abcdef1 https:\/\/app\.test PR #12 issue #260/);
  } finally { store.close(); }
});

test('formats a gate sandbox opt-out as a milestone', async () => {
  const store = openStore(':memory:');
  const bodies: string[] = [];
  let clock = new Date('2026-01-01T00:00:00.000Z');
  try {
    const discord = createDiscord({ store, settings: settings(), env: { HELM_TEST_WEBHOOK: 'https://discord.test/one' }, now: () => clock,
      fetch: async (_url, init) => { bodies.push(String(init?.body)); return new Response('{}', { status: 200 }); } });
    store.appendEvent('w-1', 'gate.sandbox.opt_out', { project: 'o/r', reason: 'base helm.json sets gate.sandbox=false' });
    await discord.tick();
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.match(JSON.parse(bodies[0]!).content, /Gate sandbox disabled: o\/r \(base helm\.json sets gate\.sandbox=false\)/);
  } finally { store.close(); }
});

test('formats an unsandboxed gate fallback as a milestone', async () => {
  const store = openStore(':memory:');
  const bodies: string[] = [];
  let clock = new Date('2026-01-01T00:00:00.000Z');
  try {
    const discord = createDiscord({ store, settings: settings(), env: { HELM_TEST_WEBHOOK: 'https://discord.test/one' }, now: () => clock,
      fetch: async (_url, init) => { bodies.push(String(init?.body)); return new Response('{}', { status: 200 }); } });
    store.appendEvent('w-1', 'gate.unsandboxed', { project: 'o/r', reason: 'sandbox-exec failed to apply profile' });
    await discord.tick();
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.match(JSON.parse(bodies[0]!).content, /Gate ran unsandboxed: o\/r \(sandbox-exec failed to apply profile\)/);
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

test('truncates digests, retries rate/server failures on the next digest, and drops 4xx batches', async () => {
  const store = openStore(':memory:');
  const sentinel = 'https://discord.test/webhook/failure-sentinel';
  const logs: string[] = [];
  const bodies: string[] = [];
  let responses: Array<Response | Error> = [new Response('{}', { status: 500 }), new Response('{}', { status: 200 })];
  let clock = new Date('2026-01-01T00:00:00.000Z');
  try {
    const discord = createDiscord({ store, settings: settings(), env: { HELM_TEST_WEBHOOK: sentinel }, home: '/tmp', now: () => clock,
      fetch: async (_url, init) => { bodies.push(String(init?.body)); const response = responses.shift()!; if (response instanceof Error) throw response; return response; }, log: (line) => logs.push(line) });
    for (let i = 0; i < 300; i += 1) store.appendEvent('w-1', 'watch.alert', { project: 'o/r', detail: 'x'.repeat(10) }, clock.toISOString());
    await discord.tick();
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.equal(bodies.length, 1);
    await discord.tick();
    assert.equal(bodies.length, 1);
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.equal(bodies.length, 2);
    assert.ok(JSON.parse(bodies[1]!).content.length <= 2000);
    assert.equal(logs.some((line) => line.includes(sentinel)), false);

    responses = [new Response('{}', { status: 400 })];
    store.appendEvent('w-1', 'pr', { project: 'o/r', number: 8 }, clock.toISOString());
    await discord.tick();
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.equal(bodies.length, 3);
    clock = new Date(clock.getTime() + 60_000);
    await discord.tick();
    assert.equal(bodies.length, 3);
  } finally { store.close(); }
});

test('fetch failures and 500 responses do not leak the webhook URL', async () => {
  const store = openStore(':memory:');
  const sentinel = 'https://discord.test/webhook/error-sentinel';
  const logs: string[] = [];
  try {
    for (const response of [new Error(sentinel), new Response('{}', { status: 500 })]) {
      const discord = createDiscord({ store, settings: settings(), env: { HELM_TEST_WEBHOOK: sentinel }, home: '/tmp',
        fetch: async () => { if (response instanceof Error) throw response; return response; }, log: (line) => logs.push(line) });
      const result = await discord.notifyNick('o/r', sentinel);
      assert.equal(result.ok, false);
      assert.equal(JSON.stringify(result).includes(sentinel), false);
    }
    assert.equal(logs.some((line) => line.includes(sentinel)), false);
    assert.equal(JSON.stringify(store.listAllEvents()).includes(sentinel), false);
  } finally { store.close(); }
});
