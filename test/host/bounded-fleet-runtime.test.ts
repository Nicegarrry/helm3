import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBoundedFleetRuntime,
  type BoundedFleetRuntimeInput,
} from '../../src/host/bounded-fleet-runtime.js';
import { BoundedPiAccess, type BoundedPiAccessPolicy } from '../../src/access/index.js';
import type { Command } from '../../src/contracts/index.js';
import type { PiAuthority, PiWorkerInput } from '../../src/runtime/pi/index.js';
import type { ArtifactJournal } from '../../src/journal/index.js';
import type { WorktreeReservation } from '../../src/workspace/index.js';

type WorkerSeed = Omit<
  PiWorkerInput,
  'commandId' | 'workspace' | 'authority' | 'journal' | 'access'
>;

const MODEL = {
  id: 'model',
  provider: 'provider',
  api: 'openai-completions',
  baseUrl: 'https://example.invalid',
  contextWindow: 100,
  maxTokens: 20,
} as const;

function makePolicy(overrides: Partial<BoundedPiAccessPolicy> = {}): BoundedPiAccessPolicy {
  return {
    poolId: 'pool',
    provider: 'provider',
    model: 'model',
    api: 'openai-completions',
    baseUrl: 'https://example.invalid',
    authEnvironment: 'TEST_KEY',
    contextWindow: 100,
    maxOutputTokens: 10,
    maxBilledOutputTokens: 20,
    maxPacketBytes: 1000,
    maxRequests: 2,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    cacheReadUsdPerMillion: 0,
    cacheWriteUsdPerMillion: 0,
    maxToolCalls: 1,
    timeoutMs: 1000,
    ...overrides,
  };
}

/** Minimal preflight seed. The assertOwner stub throws a sentinel so no valid
 * native session is ever claimed; we only exercise pre-SDK refusal paths. */
function makeWorkerSeed(overrides: Record<string, unknown> = {}): WorkerSeed {
  const seed = {
    attemptId: 'attempt-1',
    owner: { attemptId: 'attempt-1', generation: 1, expiresAt: '2099-01-01T00:00:00Z' },
    workspaceManager: {
      assertOwner: () => {
        throw new Error('native sentinel');
      },
    },
    stateRoot: '/unused',
    modelRuntime: {},
    model: MODEL as unknown as PiWorkerInput['model'],
  };
  return { ...seed, ...overrides } as unknown as WorkerSeed;
}

/** Minimal preflight input; no kernel-admitted command is being claimed. */
const command = { commandId: 'cmd' } as unknown as Command;
/** assertOwner throws inside the seed, so this is never dereferenced. */
const workspace = {} as unknown as WorktreeReservation;

type Harness = {
  factory: ReturnType<typeof createBoundedFleetRuntime>;
  authorityCommands: string[];
  journalCommands: string[];
  accesses: BoundedPiAccess[];
  callCounts: () => { worker: number; policy: number };
};

function makeHarness(
  opts: {
    policyOverrides?: Partial<BoundedPiAccessPolicy>;
    workerOverrides?: Record<string, unknown>;
  } = {},
): Harness {
  const authorityCommands: string[] = [];
  const journalCommands: string[] = [];
  const accesses: BoundedPiAccess[] = [];
  let workerCalls = 0;
  let policyCalls = 0;
  const input: BoundedFleetRuntimeInput = {
    workerFor: () => {
      workerCalls += 1;
      return makeWorkerSeed(opts.workerOverrides);
    },
    policyFor: () => {
      policyCalls += 1;
      return makePolicy(opts.policyOverrides);
    },
    authorityFor: (cmd, access) => {
      authorityCommands.push(cmd.commandId);
      accesses.push(access);
      // Inert value; the assertOwner sentinel prevents its use.
      return {} as unknown as PiAuthority;
    },
    journalFor: (cmd) => {
      journalCommands.push(cmd.commandId);
      // Inert value; the assertOwner sentinel prevents its use.
      return {} as unknown as ArtifactJournal;
    },
  };
  return {
    factory: createBoundedFleetRuntime(input),
    authorityCommands,
    journalCommands,
    accesses,
    callCounts: () => ({ worker: workerCalls, policy: policyCalls }),
  };
}

async function refuseAtPreflight(
  opts: Parameters<typeof makeHarness>[0],
  pattern?: RegExp,
): Promise<Harness> {
  const h = makeHarness(opts);
  await assert.rejects(async () => h.factory.start(command, workspace), pattern ?? /./);
  assert.deepEqual(h.authorityCommands, [], 'authorityFor must not run before refusal');
  assert.deepEqual(h.journalCommands, [], 'journalFor must not run before refusal');
  return h;
}

test('refuses at creation when any factory is missing', () => {
  for (const key of ['workerFor', 'policyFor', 'authorityFor', 'journalFor'] as const) {
    const input: Partial<BoundedFleetRuntimeInput> = {
      workerFor: () => makeWorkerSeed(),
      policyFor: () => makePolicy(),
      authorityFor: () => ({}) as unknown as PiAuthority,
      journalFor: () => ({}) as unknown as ArtifactJournal,
    };
    delete input[key];
    assert.throws(
      () => createBoundedFleetRuntime(input as BoundedFleetRuntimeInput),
      /requires workerFor, policyFor, authorityFor and journalFor factories/,
      `missing ${key} must be refused`,
    );
  }
});

test('invalid finite bounds refuse before authority and journal', async () => {
  await refuseAtPreflight({ policyOverrides: { maxRequests: 0 } });
  await refuseAtPreflight({ policyOverrides: { inputUsdPerMillion: Number.NaN } });
});

test('policy/model identity mismatches refuse before authority and journal', async () => {
  const mismatch = /bounded policy does not match the chosen model identity/;
  await refuseAtPreflight({ policyOverrides: { provider: 'other' } }, mismatch);
  await refuseAtPreflight({ policyOverrides: { model: 'other' } }, mismatch);
  await refuseAtPreflight({ policyOverrides: { api: 'other' as unknown as BoundedPiAccessPolicy['api'] } }, mismatch);
  await refuseAtPreflight({ policyOverrides: { baseUrl: 'https://other.invalid' } }, mismatch);
  await refuseAtPreflight({ policyOverrides: { contextWindow: 200 } }, mismatch);
  await refuseAtPreflight({ policyOverrides: { maxBilledOutputTokens: 25 } }, mismatch);
});

test('attempt/owner mismatch refuses before authority and journal', async () => {
  await refuseAtPreflight(
    {
      workerOverrides: {
        owner: { attemptId: 'other-attempt', generation: 1, expiresAt: '2099-01-01T00:00:00Z' },
      },
    },
    /attemptId must match owner.attemptId/,
  );
});

test('duplicate command id is refused after a failed native startup', async () => {
  const h = makeHarness();
  await assert.rejects(async () => h.factory.start(command, workspace), /native sentinel/);
  assert.deepEqual(h.authorityCommands, ['cmd']);
  assert.deepEqual(h.journalCommands, ['cmd']);
  await assert.rejects(
    async () => h.factory.start(command, workspace),
    /already has a bounded guard/,
  );
  assert.deepEqual(h.authorityCommands, ['cmd'], 'authorityFor must not run again');
  assert.deepEqual(h.journalCommands, ['cmd'], 'journalFor must not run again');
  assert.deepEqual(h.callCounts(), { worker: 1, policy: 1 }, 'workerFor/policyFor must not run again');
});

test('a failed preflight also consumes the command id', async () => {
  const h = await refuseAtPreflight(
    { policyOverrides: { model: 'other' } },
    /bounded policy does not match/,
  );
  await assert.rejects(
    async () => h.factory.start(command, workspace),
    /already has a bounded guard/,
  );
  assert.deepEqual(h.authorityCommands, []);
  assert.deepEqual(h.journalCommands, []);
});

test('distinct command ids get distinct access objects and correct ids in callbacks', async () => {
  const h = makeHarness();
  const cmdA = { commandId: 'cmd-a' } as unknown as Command;
  const cmdB = { commandId: 'cmd-b' } as unknown as Command;
  await assert.rejects(async () => h.factory.start(cmdA, workspace), /native sentinel/);
  await assert.rejects(async () => h.factory.start(cmdB, workspace), /native sentinel/);
  assert.deepEqual(h.authorityCommands, ['cmd-a', 'cmd-b']);
  assert.deepEqual(h.journalCommands, ['cmd-a', 'cmd-b']);
  assert.equal(h.accesses.length, 2);
  assert.ok(h.accesses[0] instanceof BoundedPiAccess);
  assert.ok(h.accesses[1] instanceof BoundedPiAccess);
  assert.notEqual(h.accesses[0], h.accesses[1], 'each command needs its own guard');
});

test('per-guard tool-call counters are isolated between commands', async () => {
  const h = makeHarness();
  const cmdA = { commandId: 'guard-1' } as unknown as Command;
  const cmdB = { commandId: 'guard-2' } as unknown as Command;
  await assert.rejects(async () => h.factory.start(cmdA, workspace), /native sentinel/);
  await assert.rejects(async () => h.factory.start(cmdB, workspace), /native sentinel/);
  const [guard1, guard2] = h.accesses;
  guard1.noteToolCall();
  assert.throws(() => guard1.noteToolCall(), /tool-call cap/);
  assert.doesNotThrow(() => guard2.noteToolCall(), 'second guard retains its own unused allowance');
});
