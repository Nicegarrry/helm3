import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHost } from '../../src/host/index.js';
import { planWorkerSpawn, workerSpawnKind, type SpawnPlanInput } from '../../src/host/worker-spawn-plan.js';

const now = '2026-09-16T01:00:00Z';
const end = '2026-09-16T02:00:00Z';
function input(root: string): SpawnPlanInput {
  return {
    input: { objectiveRef: 'objective', acceptanceRef: 'acceptance', contextRefs: [], modelId: 'fixture', role: 'builder' },
    workerId: 'worker', attemptId: 'attempt', commandId: 'spawn-worker', actorId: 'trusted-host',
    context: { runId: 'run', sessionId: 'session', mode: 'primary' },
    autonomyLease: { leaseId: 'auto', revision: 1, issuedBy: 'human', parentAuthorityId: 'human', scope: { repositoryId: 'repo', mapNodeIds: ['node'] }, allowedActions: ['worker.spawn'], issuedAt: now, expiresAt: end, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] },
    ownership: { runId: 'run', leaseId: 'owner', owner: 'astra', sessionId: 'session', epoch: 1, issuedAt: now, expiresAt: end },
    plannedAt: now, notAfter: end, repositoryId: 'repo', mapNodeId: 'node', mapNodeRevision: 'revision', objectiveVersion: 'v1', acceptanceVersion: 'v1',
    model: { fact: { modelId: 'fixture', provider: 'faux', poolId: 'none', enabled: true, capabilities: ['build'], capabilitiesByRole: { builder: ['build'] }, roles: ['builder'], dataPolicy: 'restricted-ok', availability: 'known_available', factVersion: 1, observedAt: now }, api: 'fixture', family: 'faux' },
    requiredCapabilities: ['build'], dataClassification: 'restricted',
    workspace: { repository: join(root, 'repo'), destination: join(root, 'worker'), branch: 'worker', baseSha: 'a'.repeat(40), owner: { attemptId: 'attempt', generation: 1, expiresAt: end }, policy: { writableRoots: ['src'] } },
  };
}

test('planned command is admitted by the real kernel; fresh model facts and ownership still fence it', async () => {
  for (const changed of ['none', 'model', 'ownership'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'helm-plan-admission-'));
    const host = await openHost({ stateDirectory: root, now: () => now, kinds: { 'worker.spawn': workerSpawnKind } });
    try {
      const args = input(root);
      host.recordHumanAuthority({ authorityId: 'human', repositoryId: 'repo', mapNodeIds: ['node'], allowedActions: ['worker.spawn'], expiresAt: end, maxConcurrency: 1, maxAttemptsPerNode: 1, poolLimits: [], protectedReserves: [] });
      host.recordAutonomyLease(args.autonomyLease);
      host.recordModelFact(args.model.fact);
      host.acquireOwnership(args.ownership, 0);
      const plan = planWorkerSpawn(args);
      if (changed === 'model') host.recordModelFact({ ...args.model.fact, enabled: false, factVersion: 2 });
      if (changed === 'ownership') host.acquireOwnership({ ...args.ownership, leaseId: 'owner-2', sessionId: 'replacement', epoch: 2 }, 1);
      const admit = () => host.admitOrchestrator(plan.command, args.context, 'trusted-host', args.attemptId);
      if (changed === 'none') assert.equal(admit().command.commandId, args.commandId);
      else assert.throws(admit);
    } finally { host.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test('capability floors test requirements against model abilities, including legacy facts', () => {
  const args = input('/tmp/planner');
  args.model.fact = { ...args.model.fact, capabilitiesByRole: { builder: ['build', 'extra'] } };
  assert.doesNotThrow(() => planWorkerSpawn(args));
  args.requiredCapabilities = ['unqualified'];
  assert.throws(() => planWorkerSpawn(args));
  args.model.fact = { ...args.model.fact, capabilitiesByRole: undefined };
  assert.throws(() => planWorkerSpawn(args));
  args.requiredCapabilities = ['build'];
  assert.doesNotThrow(() => planWorkerSpawn(args));
});

test('every supplied timestamp is UTC and ownership cannot be issued in the future', () => {
  const edits: ((args: SpawnPlanInput) => void)[] = [
    args => { args.notAfter = '2026-09-16T12:00:00+10:00'; },
    args => { args.workspace.owner.expiresAt = '2026-09-16'; },
    args => { args.model.fact = { ...args.model.fact, observedAt: '2026-09-16' }; },
    args => { args.ownership.issuedAt = '2026-09-16T01:30:00Z'; },
  ];
  for (const edit of edits) { const args = input('/tmp/planner'); edit(args); assert.throws(() => planWorkerSpawn(args)); }
});

test('review path normalization is lexical; runtime still verifies repository realpath', () => {
  const args = input('/tmp/planner');
  args.input = { ...args.input, reviewConstraint: { repository: '/tmp/planner/./repo', expectedHead: args.workspace.baseSha, mode: 'review-readonly' } };
  args.workspace.policy.writableRoots = [];
  assert.doesNotThrow(() => planWorkerSpawn(args));
  args.input = { ...args.input, reviewConstraint: { ...args.input.reviewConstraint!, mode: 'worker' as 'review-readonly' } };
  assert.throws(() => planWorkerSpawn(args));
});

test('planning binds immutable input references and caps the entire command lifetime', () => {
  const args = input('/tmp/planner');
  args.input = { ...args.input, contextRefs: ['context'], label: 'build' };
  args.workspace.owner.expiresAt = '2026-09-16T01:30:00Z';
  const original = structuredClone(args);
  const plan = planWorkerSpawn(args);
  assert.equal(plan.command.notAfter, args.workspace.owner.expiresAt);
  assert.equal(plan.attempt.contextManifestHash, (plan.command.payload as { inputDigest: string }).inputDigest);
  assert.deepEqual(args, original, 'planning does not mutate or freeze caller input');
  const bytes = JSON.stringify(plan);
  args.workspace.policy.writableRoots = ['.'];
  args.requiredCapabilities = ['different'];
  args.input = { ...args.input, contextRefs: ['different'] };
  assert.equal(JSON.stringify(plan), bytes);
  assert.ok(Object.isFrozen(plan.command.payload));
  assert.ok(Object.isFrozen(plan.workspace.policy.writableRoots));
  assert.equal(Reflect.set(plan.workspace.policy.writableRoots, '0', 'escape'), false);
  const payload = plan.command.payload as { requiredCapabilities: string[]; contextRefs: string[] };
  assert.throws(() => payload.requiredCapabilities.push('escape'));
  assert.throws(() => payload.contextRefs.push('escape'));
});

test('planning refuses inconsistent delegation, scope, model and review facts', () => {
  const changes: ((args: SpawnPlanInput) => void)[] = [
    args => { args.context = { ...args.context, sessionId: 'other' }; },
    args => { args.context = { ...args.context, runId: 'other' }; },
    args => { args.ownership.epoch = 0; },
    args => { args.autonomyLease.allowedActions = []; },
    args => { args.autonomyLease.scope.mapNodeIds = []; },
    args => { args.autonomyLease.scope.repositoryId = 'other'; },
    args => { args.plannedAt = end; },
    args => { args.notAfter = now; },
    args => { args.workspace.owner.attemptId = 'other'; },
    args => { args.workspace.baseSha = 'main'; },
    args => { args.model.fact = { ...args.model.fact, enabled: false }; },
    args => { args.model.fact = { ...args.model.fact, availability: 'unknown' }; },
    args => { args.model.fact = { ...args.model.fact, dataPolicy: 'public-only' }; },
    args => { args.model.fact = { ...args.model.fact, capabilitiesByRole: {} }; },
    args => { args.input = { ...args.input, reviewConstraint: { repository: '/other', expectedHead: args.workspace.baseSha, mode: 'review-readonly' } }; },
    args => { args.input = { ...args.input, reviewConstraint: { repository: args.workspace.repository, expectedHead: 'b'.repeat(40), mode: 'review-readonly' } }; },
    args => { args.input = { ...args.input, reviewConstraint: { repository: args.workspace.repository, expectedHead: args.workspace.baseSha, mode: 'review-readonly' } }; },
  ];
  for (const change of changes) { const args = input('/tmp/planner'); change(args); assert.throws(() => planWorkerSpawn(args)); }
});
