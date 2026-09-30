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
      budgets: { defaultCapUsd: 25, defaultCodexTokens: 20_000_000 },
      spend: {},
      factory: { claims: 'block', claimsAt: 0.7, verdictAt: 0.5, retryMax: 2, envelopeTapAt: 0.5, tapTtlMin: 60 },
      queue: { tickSec: 30, checksTimeoutMin: 30 },
      memory: {},
      select: { skillDirs: ['~/code/skills'], skillAllow: [], autoAt: 0.7, lessons: 'shadow' },
      routing: { tiers: { '1': ['openrouter/qwen/qwen3.8-flash', 'openrouter/deepseek/deepseek-v4.1-flash', 'codex/gpt-6-luna:medium', 'codex/gpt-5.6-luna:medium'], '2': ['google/gemini-3.8-flash', 'codex/gpt-6-luna:high', 'codex/gpt-5.6-luna:high'], '3': ['claude/sonnet:high', 'codex/gpt-5.6-terra:high'], '4': ['codex/gpt-6.1-sol:medium', 'codex/gpt-5.6-sol:medium', 'claude/opus:medium'], '5': ['codex/gpt-6-astra:high', 'claude/opus:high', 'claude/fable:high', 'codex/gpt-6.1-sol:high', 'codex/gpt-5.6-sol:high'] }, allowed: ['openrouter/qwen/qwen3.8-flash', 'openrouter/deepseek/deepseek-v4.1-flash', 'codex/gpt-6-luna:medium', 'codex/gpt-5.6-luna:medium', 'google/gemini-3.8-flash', 'codex/gpt-6-luna:high', 'codex/gpt-5.6-luna:high', 'claude/sonnet:high', 'codex/gpt-5.6-terra:high', 'codex/gpt-6.1-sol:medium', 'codex/gpt-5.6-sol:medium', 'claude/opus:medium', 'codex/gpt-6-astra:high', 'claude/opus:high', 'claude/fable:high', 'codex/gpt-6.1-sol:high', 'codex/gpt-5.6-sol:high'], minClean: 0.5, minN: 8, policy: { subscriptionOnly: false }, checkDays: 7 },
      discord: { projects: {}, digestSec: 60, maxPerHour: 20 },
      deploy: { smokeEnv: [] },
      hygiene: { keepNodeModules: false, gcSec: 600, worktreeTtlHours: 24, minFreeGb: 15 },
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
