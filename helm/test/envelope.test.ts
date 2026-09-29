import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEnvelopeTicker, defaultEnvelope, envelopeBudgetGuard, envelopePath, readEnvelope } from '../src/envelope.js';
import { openStore } from '../src/store.js';

function home(): string { return mkdtempSync(join(tmpdir(), 'helm-envelope-')); }
function put(root: string, project: string, value: unknown): void {
  const path = envelopePath(root, project);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
const valid = { rules: ['Use the project API.'], budget: { maxSprintUsd: 4, maxSprintCodexTokens: 100 }, deploy: { prod: 'tap' }, tapOnly: ['deploy.prod'] };

test('invalid envelope returns default rules and tap-only deploys with one log', () => {
  const root = home();
  try {
    put(root, 'acme/app', { rules: 'not an array' });
    const logs: string[] = [];
    const result = readEnvelope(root, 'acme/app', (line) => logs.push(line));
    assert.equal(result.rules.length, 1);
    assert.ok(result.rules[0]?.includes('Outside the autonomy envelope'));
    assert.ok(logs.length === 1);
    assert.ok(Object.values(defaultEnvelope().deploy).every((value) => value === 'tap'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('budget guard names each exceeded envelope limit and permits in-range budgets', () => {
  const root = home();
  try {
    put(root, 'acme/app', valid);
    assert.match(envelopeBudgetGuard(root, { project: 'acme/app', capUsd: 5 }) ?? '', /maxSprintUsd/);
    assert.match(envelopeBudgetGuard(root, { project: 'acme/app', capUsd: 1, codexTokens: 101 }) ?? '', /maxSprintCodexTokens/);
    assert.equal(envelopeBudgetGuard(root, { project: 'acme/app', capUsd: 4, codexTokens: 100 }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('envelope ticker emits once per hash change and stays quiet when unchanged', async () => {
  const root = home();
  const store = openStore(':memory:');
  try {
    put(root, 'acme/app', valid);
    const tick = createEnvelopeTicker({ home: root, store });
    await tick(); await tick();
    assert.equal(store.listAllEvents().length, 0);
    put(root, 'acme/app', { ...valid, rules: ['Changed'] });
    await tick(); await tick(); await tick();
    const changes = store.listAllEvents().filter((event) => event.kind === 'envelope.changed');
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.workerId, 'project:acme/app');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
