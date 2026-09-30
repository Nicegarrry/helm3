import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { effectiveSpend, loadConfig } from '../src/config.js';
import { SPEND_CAP_TAP_KIND, SPEND_CAP_TAP_PROJECT, spendCapAction } from '../src/envelope.js';
import { Helm } from '../src/helm.js';
import { loadSettings, updateSpendSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import { createToolRegistry } from '../src/tools.js';

const CODE = '123456';
const PEPPER = Buffer.from('spend-test-tap-pepper-32-bytes!!');

function home(): string { return mkdtempSync(join(tmpdir(), 'helm-spend-')); }

function makeHelm(root: string): { helm: Helm; store: ReturnType<typeof openStore> } {
  const store = openStore(':memory:');
  const config = loadConfig({ HELM_HOME: root, HELM_SPEND_CAP_USD: '5', HELM_SPEND_WARN_USD: '4', HELM_MAX_WORKERS: '2' });
  const helm = new Helm({
    config, store, workspace: {} as never, gates: {} as never, github: {} as never, runner: {} as never,
    prompts: { builder: () => '', reviewer: () => '', validator: () => '' }, settings: loadSettings(root),
    discord: { consume: async () => {}, tick: async () => {}, notifyNick: async () => ({ ok: true, sent: true }), postTap: async () => ({ ok: true }) },
    randomInt: () => Number(CODE), tapPepper: PEPPER,
  });
  return { helm, store };
}

test('settings override env values and run status reports sources plus mismatch warning', async () => {
  const root = home();
  try {
    writeFileSync(join(root, 'helm.json'), JSON.stringify({ other: { keep: true }, spend: { capUsd: 9, warnUsd: 7, maxWorkers: 4 } }));
    const { helm, store } = makeHelm(root);
    try {
      const result = await helm.runStatus();
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual({ cap: result.spendCapUsd, warn: result.spendWarnUsd, workers: result.maxWorkers }, { cap: 9, warn: 7, workers: 4 });
      assert.deepEqual(result.spendSources, { capUsd: 'settings', warnUsd: 'settings', maxWorkers: 'settings' });
      assert.match(result.warning ?? '', /HELM_SPEND_CAP_USD=5/);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spend settings hot reload after helm.json edit without restarting Helm', async () => {
  const root = home();
  const { helm, store } = makeHelm(root);
  try {
    const before = await helm.runStatus();
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.equal(before.spendCapUsd, 5);
    writeFileSync(join(root, 'helm.json'), JSON.stringify({ spend: { capUsd: 2 } }));
    const result = await helm.runStatus();
    assert.equal(result.ok && result.spendCapUsd, 2);
    assert.equal(result.ok && result.spendSources.capUsd, 'settings');
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'spend.changed' && !event.data.ignored).length, 1);
    writeFileSync(join(root, 'helm.json'), JSON.stringify({ spend: { capUsd: 9 } }));
    const ignored = await helm.runStatus();
    assert.equal(ignored.ok && ignored.spendCapUsd, 2);
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'spend.changed' && event.data.ignored).length, 1);
    writeFileSync(join(root, 'helm.json'), '{ invalid');
    const invalid = await helm.runStatus();
    assert.equal(invalid.ok && invalid.spendCapUsd, 2);
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'spend.warning').length, 1);
    await helm.runStatus();
    assert.equal(store.listAllEvents().filter((event) => event.kind === 'spend.warning').length, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('lowering does not need a tap and atomic spend update preserves other settings', async () => {
  const root = home();
  writeFileSync(join(root, 'helm.json'), JSON.stringify({ supervisor: { command: 'keep-me' }, spend: { capUsd: 5 } }));
  const { helm, store } = makeHelm(root);
  try {
    const result = await createToolRegistry(helm).call('spend.set', { capUsd: 2 });
    assert.deepEqual(result, { ok: true, spend: { capUsd: 2 } });
    const saved = JSON.parse(readFileSync(join(root, 'helm.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(saved.supervisor, { command: 'keep-me' });
    assert.deepEqual(saved.spend, { capUsd: 2 });
    assert.deepEqual(updateSpendSettings(root, { warnUsd: 1 }).spend, { capUsd: 2, warnUsd: 1 });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('raising cap without a spend.cap tap is refused; a granted tap is consumed once', async () => {
  const root = home();
  const { helm, store } = makeHelm(root);
  try {
    const tools = createToolRegistry(helm);
    const action = spendCapAction({ capUsd: 8 });
    const refused = await tools.call('spend.set', { capUsd: 8 });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, new RegExp(`${SPEND_CAP_TAP_KIND}.*${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const requested = await tools.call('tap.request', { project: SPEND_CAP_TAP_PROJECT, kind: SPEND_CAP_TAP_KIND, action });
    assert.equal(requested.ok, true);
    if (!requested.ok) return;
    const tap = requested as { ok: true; id: string };
    assert.deepEqual(await tools.call('tap.confirm', { id: tap.id, code: CODE }), { ok: true, granted: true });
    assert.deepEqual(await tools.call('spend.set', { capUsd: 8, tapId: tap.id }), { ok: true, spend: { capUsd: 8 } });
    const reused = await tools.call('spend.set', { capUsd: 9, tapId: tap.id });
    assert.equal(reused.ok, false);
    assert.equal((store.sql.prepare('SELECT state FROM taps WHERE id = ?').get(tap.id) as { state: string }).state, 'used');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('raising cap to no cap requires and consumes a spend.cap tap', async () => {
  const root = home();
  const { helm, store } = makeHelm(root);
  try {
    const tools = createToolRegistry(helm);
    const refused = await tools.call('spend.set', { capUsd: 0 });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.reason, /spend\.cap/);
    const action = spendCapAction({ capUsd: 0 });
    const requested = await tools.call('tap.request', { project: SPEND_CAP_TAP_PROJECT, kind: SPEND_CAP_TAP_KIND, action });
    assert.equal(requested.ok, true);
    if (!requested.ok) return;
    const tap = requested as { ok: true; id: string };
    assert.deepEqual(await tools.call('tap.confirm', { id: tap.id, code: CODE }), { ok: true, granted: true });
    assert.deepEqual(await tools.call('spend.set', { capUsd: 0, tapId: tap.id }), { ok: true, spend: { capUsd: 0 } });
    assert.equal((store.sql.prepare('SELECT state FROM taps WHERE id = ?').get(tap.id) as { state: string }).state, 'used');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('effective spend uses defaults when no settings or env value is present', () => {
  const result = effectiveSpend({ home: '/tmp', spendCapUsd: 0, spendWarnUsd: 0, maxWorkers: 3, gateTimeoutMs: 1 }, { spend: {} });
  assert.deepEqual(result, { capUsd: 0, warnUsd: 0, maxWorkers: 3, sources: { capUsd: 'default', warnUsd: 'default', maxWorkers: 'default' } });
});
