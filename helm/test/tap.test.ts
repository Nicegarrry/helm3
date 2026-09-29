import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BUDGET_TAP_ACTION, actionHash, budgetTapAction, confirmTap, consumeTap, requestTap } from '../src/envelope.js';
import { Helm } from '../src/helm.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import { createToolRegistry } from '../src/tools.js';
import { createDiscord } from '../src/discord.js';
import type { DiscordService } from '../src/discord.js';

const CODE = '123456';
const PEPPER = Buffer.from('tap-pepper-sentinel-32-bytes!!xx');
const OLD_PEPPER = Buffer.alloc(32, 0x11);
const NEW_PEPPER = Buffer.alloc(32, 0x22);
const project = 'acme/app';

function setup() {
  const store = openStore(':memory:');
  const clock = new Date('2026-09-30T00:00:00.000Z');
  const posted: string[] = [];
  const taps = new Map<string, import('../src/envelope.js').TapMemory>();
  return { store, clock, posted, taps, post: async (content: string) => { posted.push(content); return { ok: true as const }; } };
}

async function requested(d: ReturnType<typeof setup>, action = BUDGET_TAP_ACTION) {
  return requestTap(d.store, { project, kind: 'budget.open', action }, { taps: d.taps, ttlMin: 60, now: () => d.clock, post: d.post, pepper: PEPPER, randomInt: () => Number(CODE) });
}

test('tap code is only sent to the tap poster and never enters results, events, rows, or logs', async () => {
  const d = setup();
  const logs: string[] = [];
  const consoleOutput: string[] = [];
  const originalConsole = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args) => { consoleOutput.push(args.map(String).join(' ')); };
  console.error = (...args) => { consoleOutput.push(args.map(String).join(' ')); };
  console.warn = (...args) => { consoleOutput.push(args.map(String).join(' ')); };
  const home = mkdtempSync(join(tmpdir(), 'helm-tap-sentinel-'));
  const discord = createDiscord({ store: d.store, settings: { discord: { projects: {}, digestSec: 60, maxPerHour: 20, tapWebhookEnv: 'HELM_TAP_WEBHOOK' } }, env: { HELM_TAP_WEBHOOK: 'https://discord.test/taps' }, fetch: async (_url, init) => { d.posted.push(String(init?.body)); return new Response('{}', { status: 200 }); }, log: (line) => logs.push(line) });
  try {
    const helm = new Helm({ config: { home, spendCapUsd: 0, maxWorkers: 2, gateTimeoutMs: 1000 }, store: d.store, workspace: {} as never, gates: {} as never, github: {} as never, runner: {} as never, prompts: { builder: () => '', reviewer: () => '', validator: () => 'validate' }, settings: loadSettings('/missing-tap-settings'), discord, randomInt: () => Number(CODE), tapPepper: PEPPER });
    const tools = createToolRegistry(helm);
    const result = await tools.call('tap.request', { project, kind: 'budget.open', action: 'budget.open' });
    assert.equal(result.ok, true);
    assert.equal(d.posted.length, 1);
    assert.match(d.posted[0]!, new RegExp(CODE));
    const dump = JSON.stringify(d.store.sql.prepare('SELECT * FROM taps').all());
    const row = d.store.sql.prepare('SELECT id, codeHash FROM taps').get() as { id: string; codeHash: string };
    assert.notEqual(row.codeHash, createHash('sha256').update(`${row.id}:${CODE}`).digest('hex'));
    assert.equal(dump.includes(PEPPER.toString('hex')), false);
    assert.equal(JSON.stringify(result).includes(CODE), false);
    assert.equal(dump.includes(CODE), false);
    const eventsDump = JSON.stringify(d.store.listAllEvents());
    const logDump = logs.join('\n');
    assert.equal(eventsDump.includes(CODE), false);
    assert.equal(logDump.includes(CODE), false);
    assert.equal(dump.includes(PEPPER.toString()), false);
    assert.equal(eventsDump.includes(PEPPER.toString()), false);
    assert.equal(logDump.includes(PEPPER.toString()), false);
    assert.equal(dump.includes(PEPPER.toString('hex')), false);
    assert.equal(eventsDump.includes(PEPPER.toString('hex')), false);
    assert.equal(logDump.includes(PEPPER.toString('hex')), false);
    if (!result.ok) return;
    const tap = result as { ok: true; id: string };
    const confirmed = await tools.call('tap.confirm', { id: tap.id, code: CODE });
    assert.deepEqual(confirmed, { ok: true, granted: true });
    assert.equal(JSON.stringify(confirmed).includes(CODE), false);
    const second = await tools.call('tap.request', { project, kind: 'budget.open', action: 'second' });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const failed = await tools.call('tap.confirm', { id: (second as { ok: true; id: string }).id, code: '000000' });
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(failed).includes(CODE), false);
    const finalDump = JSON.stringify(d.store.sql.prepare('SELECT * FROM taps').all());
    const finalEventsDump = JSON.stringify(d.store.listAllEvents());
    const finalLogDump = logs.join('\n');
    const finalConsoleDump = consoleOutput.join('\n');
    for (const sentinel of [CODE, PEPPER.toString(), PEPPER.toString('hex')]) {
      assert.equal(finalDump.includes(sentinel), false);
      assert.equal(finalEventsDump.includes(sentinel), false);
      assert.equal(finalLogDump.includes(sentinel), false);
      assert.equal(finalConsoleDump.includes(sentinel), false);
    }
  } finally {
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    d.store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a granted tap is single-use and mismatches project, kind, or action hash', async () => {
  const d = setup();
  try {
    const result = await requested(d);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(confirmTap(d.store, d.taps, { id: result.id, code: CODE }, PEPPER, d.clock), { ok: true, granted: true });
    assert.match(consumeTap(d.store, d.taps, 'other/app', 'budget.open', actionHash(BUDGET_TAP_ACTION), result.id, d.clock) ?? '', /match/);
    assert.match(consumeTap(d.store, d.taps, project, 'deploy.prod', actionHash(BUDGET_TAP_ACTION), result.id, d.clock) ?? '', /match/);
    assert.match(consumeTap(d.store, d.taps, project, 'budget.open', actionHash('different'), result.id, d.clock) ?? '', /match/);
    assert.equal(consumeTap(d.store, d.taps, project, 'budget.open', actionHash(BUDGET_TAP_ACTION), result.id, d.clock), null);
    assert.match(consumeTap(d.store, d.taps, project, 'budget.open', actionHash(BUDGET_TAP_ACTION), result.id, d.clock) ?? '', /unknown or expired/);
    d.store.sql.prepare("UPDATE taps SET state = 'granted' WHERE id = ?").run(result.id);
    assert.match(consumeTap(d.store, d.taps, project, 'budget.open', actionHash(BUDGET_TAP_ACTION), result.id, d.clock) ?? '', /unknown or expired/);
  } finally { d.store.close(); }
});

test('expiry refuses confirmation and consumption, and three wrong codes deny a tap', async () => {
  const d = setup();
  try {
    const expired = await requested(d);
    assert.equal(expired.ok, true);
    if (!expired.ok) return;
    const afterExpiry = new Date(d.clock.getTime() + 60 * 60_000);
    assert.deepEqual(confirmTap(d.store, d.taps, { id: expired.id, code: CODE }, PEPPER, afterExpiry), { ok: false, reason: 'tap expired' });

    const grantedThenExpired = await requested(d, 'deploy.staging');
    assert.equal(grantedThenExpired.ok, true);
    if (!grantedThenExpired.ok) return;
    assert.deepEqual(confirmTap(d.store, d.taps, { id: grantedThenExpired.id, code: CODE }, PEPPER, d.clock), { ok: true, granted: true });
    assert.equal(consumeTap(d.store, d.taps, project, 'budget.open', actionHash('deploy.staging'), grantedThenExpired.id, afterExpiry), 'tap expired');

    const denied = await requested(d, 'deploy.prod');
    assert.equal(denied.ok, true);
    if (!denied.ok) return;
    assert.equal(confirmTap(d.store, d.taps, { id: denied.id, code: '000000' }, PEPPER, d.clock).ok, false);
    assert.equal(confirmTap(d.store, d.taps, { id: denied.id, code: '000000' }, PEPPER, d.clock).ok, false);
    assert.deepEqual(confirmTap(d.store, d.taps, { id: denied.id, code: '000000' }, PEPPER, d.clock), { ok: false, reason: 'tap denied' });
    assert.equal((d.store.sql.prepare('SELECT state, attempts FROM taps WHERE id = ?').get(denied.id) as { state: string; attempts: number }).state, 'denied');
  } finally { d.store.close(); }
});

test('database attempts and expiry cannot reset the in-memory tap', async () => {
  const d = setup();
  try {
    const result = await requested(d);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(confirmTap(d.store, d.taps, { id: result.id, code: '000000' }, PEPPER, d.clock).ok, false);
    assert.equal(confirmTap(d.store, d.taps, { id: result.id, code: '000000' }, PEPPER, d.clock).ok, false);
    assert.deepEqual(confirmTap(d.store, d.taps, { id: result.id, code: '000000' }, PEPPER, d.clock), { ok: false, reason: 'tap denied' });
    d.store.sql.prepare("UPDATE taps SET attempts = 0, expiresAt = ? WHERE id = ?").run(new Date(d.clock.getTime() + 24 * 60 * 60_000).toISOString(), result.id);
    assert.deepEqual(confirmTap(d.store, d.taps, { id: result.id, code: CODE }, PEPPER, d.clock), { ok: false, reason: 'unknown or expired tap (daemon restarted?)' });
  } finally { d.store.close(); }
});

test('tap.request refuses without a configured tap channel', async () => {
  const d = setup();
  const discord = createDiscord({ store: d.store, settings: { discord: { projects: {}, digestSec: 60, maxPerHour: 20, tapWebhookEnv: 'HELM_MISSING_TAP' } }, env: {}, fetch: async () => new Response('{}') });
  const result = await requestTap(d.store, { project, kind: 'budget.open', action: BUDGET_TAP_ACTION }, { taps: d.taps, ttlMin: 60, now: () => d.clock, post: discord.postTap, pepper: PEPPER });
  assert.deepEqual(result, { ok: false, reason: 'no tap channel configured' });
  assert.equal((d.store.sql.prepare('SELECT COUNT(*) AS count FROM taps').get() as { count: number }).count, 0);
  d.store.close();
});

test('tap.request refuses when the tap channel is a milestone channel', async () => {
  const d = setup();
  const discord = createDiscord({ store: d.store, settings: { discord: { projects: { [project]: { webhookEnv: 'HELM_MILESTONE' } }, digestSec: 60, maxPerHour: 20, tapWebhookEnv: 'HELM_TAP_WEBHOOK' } }, env: { HELM_TAP_WEBHOOK: 'https://discord.test/shared', HELM_MILESTONE: 'https://discord.test/shared' }, fetch: async () => new Response('{}') });
  const result = await requestTap(d.store, { project, kind: 'budget.open', action: BUDGET_TAP_ACTION }, { taps: d.taps, ttlMin: 60, now: () => d.clock, post: discord.postTap, pepper: PEPPER });
  assert.deepEqual(result, { ok: false, reason: 'tap channel must differ from the milestone channel' });
  assert.equal((d.store.sql.prepare('SELECT COUNT(*) AS count FROM taps').get() as { count: number }).count, 0);
  d.store.close();
});

test('an over-max budget.open consumes a matching tap exactly once', async () => {
  const d = setup();
  const home = mkdtempSync(join(tmpdir(), 'helm-tap-'));
  const discord: DiscordService = { consume: async () => {}, tick: async () => {}, notifyNick: async () => ({ ok: true, sent: true }), postTap: d.post };
  const helm = new Helm({ config: { home, spendCapUsd: 0, maxWorkers: 2, gateTimeoutMs: 1000 }, store: d.store, workspace: {} as never, gates: {} as never, github: {} as never, runner: {} as never, prompts: { builder: () => '', reviewer: () => '', validator: () => 'validate' }, settings: loadSettings('/missing-tap-settings'), discord, randomInt: () => Number(CODE), tapPepper: PEPPER });
  const tools = createToolRegistry(helm);
  try {
    const budget = { project, label: 'wide', capUsd: 30, codexTokens: 20_000_001 };
    const requestedResult = await tools.call('tap.request', { project, kind: 'budget.open', action: budgetTapAction(budget) });
    assert.equal(requestedResult.ok, true);
    if (!requestedResult.ok) return;
    const tap = requestedResult as { ok: true; id: string };
    assert.equal(JSON.stringify(requestedResult).includes(CODE), false);
    assert.deepEqual(await tools.call('tap.confirm', { id: tap.id, code: CODE }), { ok: true, granted: true });
    const input = { ...budget, tapId: tap.id };
    assert.equal((await tools.call('budget.open', input)).ok, true);
    assert.equal((await tools.call('budget.open', input)).ok, false);
  } finally { d.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('a tap from before daemon restart is expired with the restart refusal', async () => {
  const d = setup();
  const home = mkdtempSync(join(tmpdir(), 'helm-tap-restart-'));
  const discord: DiscordService = { consume: async () => {}, tick: async () => {}, notifyNick: async () => ({ ok: true, sent: true }), postTap: d.post };
  const config = { home, spendCapUsd: 0, maxWorkers: 2, gateTimeoutMs: 1000 };
  try {
    const first = new Helm({ config, store: d.store, workspace: {} as never, gates: {} as never, github: {} as never, runner: {} as never, prompts: { builder: () => '', reviewer: () => '', validator: () => 'validate' }, settings: loadSettings('/missing-tap-settings'), discord, randomInt: () => Number(CODE), tapPepper: OLD_PEPPER });
    const requestedResult = await createToolRegistry(first).call('tap.request', { project, kind: 'budget.open', action: BUDGET_TAP_ACTION });
    assert.equal(requestedResult.ok, true);
    if (!requestedResult.ok) return;
    const tap = requestedResult as { ok: true; id: string };
    const second = new Helm({ config, store: d.store, workspace: {} as never, gates: {} as never, github: {} as never, runner: {} as never, prompts: { builder: () => '', reviewer: () => '', validator: () => 'validate' }, settings: loadSettings('/missing-tap-settings'), discord, randomInt: () => Number(CODE), tapPepper: NEW_PEPPER });
    const confirmed = await createToolRegistry(second).call('tap.confirm', { id: tap.id, code: CODE });
    assert.deepEqual(confirmed, { ok: false, reason: 'unknown or expired tap (daemon restarted?)' });
    assert.equal((d.store.sql.prepare('SELECT state FROM taps WHERE id = ?').get(tap.id) as { state: string }).state, 'expired');
  } finally { d.store.close(); rmSync(home, { recursive: true, force: true }); }
});
