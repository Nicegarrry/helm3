import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadSettings } from '../src/settings.js';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'helm-settings-'));
}

test('loadSettings returns the v4 defaults when helm.json is missing', () => {
  const home = tempHome();
  try {
    assert.deepEqual(loadSettings(home), {
      jev: { shadow: true, model: 'jev-latest', triageHumanAt: 0.3, attentionAt: 0.4, timeoutMs: 5000 },
      wake: { minIntervalSec: 120, maxPerHour: 20 },
      watch: { tickSec: 60, silenceMin: 15, sameRefusal: 5, attentionEverySec: 180, cooldownMin: 15 },
      supervisor: {},
      discord: { projects: {}, digestSec: 60, maxPerHour: 20 },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadSettings logs one line and returns defaults for an invalid file', () => {
  const home = tempHome();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    writeFileSync(join(home, 'helm.json'), '{not json');
    assert.equal(loadSettings(home).jev.model, 'jev-latest');
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
    rmSync(home, { recursive: true, force: true });
  }
});
