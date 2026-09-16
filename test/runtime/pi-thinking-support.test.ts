import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPiThinkingSupported } from '../../src/access/thinking-support.js';

const GOOGLE_GEMINI_38_FLASH = { provider: 'google', id: 'gemini-3.8-flash' } as const;

// --- Permitted levels for google/gemini-3.8-flash ---

test('google/gemini-3.8-flash permits low', () => {
  assert.doesNotThrow(() =>
    assertPiThinkingSupported(GOOGLE_GEMINI_38_FLASH, 'low'),
  );
});

test('google/gemini-3.8-flash permits medium', () => {
  assert.doesNotThrow(() =>
    assertPiThinkingSupported(GOOGLE_GEMINI_38_FLASH, 'medium'),
  );
});

test('google/gemini-3.8-flash permits high', () => {
  assert.doesNotThrow(() =>
    assertPiThinkingSupported(GOOGLE_GEMINI_38_FLASH, 'high'),
  );
});

// --- Refused levels for google/gemini-3.8-flash ---

const refusedLevels = ['off', 'minimal', 'xhigh', 'max'] as const;

for (const level of refusedLevels) {
  test(`google/gemini-3.8-flash refuses ${level}`, () => {
    assert.throws(
      () => assertPiThinkingSupported(GOOGLE_GEMINI_38_FLASH, level),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // Error should mention the model identity, the unsupported level, and the supported set.
        assert.match(err.message, /gemini-3\.8-flash/);
        assert.match(err.message, new RegExp(level));
        assert.match(err.message, /low/);
        assert.match(err.message, /medium/);
        assert.match(err.message, /high/);
        return true;
      },
    );
  });
}

// --- Unaffected provider/model identities ---

test('google/gemini-3-flash-preview is unaffected (all levels pass)', () => {
  const model = { provider: 'google', id: 'gemini-3-flash-preview' };
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.doesNotThrow(
      () => assertPiThinkingSupported(model, level),
      `should not throw for google/gemini-3-flash-preview with ${level}`,
    );
  }
});

test('gemini-3.8-flash under another provider is unaffected', () => {
  const model = { provider: 'openai', id: 'gemini-3.8-flash' };
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.doesNotThrow(
      () => assertPiThinkingSupported(model, level),
      `should not throw for openai/gemini-3.8-flash with ${level}`,
    );
  }
});

test('unknown provider/unknown model is unaffected', () => {
  const model = { provider: 'acme', id: 'acme-reasoner-v9' };
  assert.doesNotThrow(() =>
    assertPiThinkingSupported(model, 'minimal'),
  );
});

// Coordinator integration regression: removing the runtime call must break this test.
test('native worker rejects incompatible thinking before SDK access or model authority', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PiNativeWorker } = await import('../../src/runtime/pi/index.js');
  const root = await mkdtemp(join(tmpdir(), 'helm3-thinking-preflight-'));
  let runtimeReads = 0;
  let effects = 0;
  try {
    for (const level of refusedLevels) {
      const input = {
        workspaceManager: { assertOwner() {} },
        workspace: { root: join(root, 'worktree') }, owner: {},
        stateRoot: join(root, level), model: GOOGLE_GEMINI_38_FLASH,
        thinking: { level },
        modelRuntime: new Proxy({}, { get() { runtimeReads += 1; throw new Error('SDK touched before compatibility validation'); } }),
        authority: { async perform() { effects += 1; throw new Error('unexpected model effect'); } },
      } as unknown as Parameters<typeof PiNativeWorker.start>[0];
      await assert.rejects(PiNativeWorker.start(input), /Supported levels: low, medium, high/);
    }
    assert.equal(runtimeReads, 0);
    assert.equal(effects, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
