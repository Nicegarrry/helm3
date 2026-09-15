import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ArtifactJournal, type ArtifactMetadata } from '../../src/journal/index.js';
import { PiNativeWorker, type PiAuthority } from '../../src/runtime/pi/index.js';
import { WorkspaceManager } from '../../src/workspace/index.js';
const exec = promisify(execFile);
const envelope = (files: string[]) => JSON.stringify({ status: 'succeeded', summary: 'done', changed_files: files, commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'helm3-pi-boundary-'));
  const repo = join(root, 'repo'); await mkdir(repo);
  await exec('git', ['init', repo]); await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']); await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await mkdir(join(repo, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(repo, '.pi', 'extensions', 'untrusted.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, 'extension-ran'))},'unsafe'); export default function() {}`);
  await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-m', 'base']);
  const base = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const manager = new WorkspaceManager({ stateRoot: join(root, 'ownership') });
  const owner = { attemptId: 'attempt', generation: 1, expiresAt: '2099-01-01T00:00:00Z' };
  const workspace = await manager.create(repo, join(root, 'worker'), 'worker', base, owner);
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  const runtime = await ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = ai.fauxProvider({ provider: 'helm-boundary', models: [{ id: 'offline' }] });
  runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey('helm-boundary', 'local-fake');
  const journal = await ArtifactJournal.open({ root: join(root, 'journal') });
  let revoked = false; let expireAfterWrite = false; let active = 0;
  const stops: string[] = []; const effects: string[] = [];
  const authority: PiAuthority = {
    async perform(effect, action) {
      if (revoked) throw new Error('lease expired');
      effects.push(effect.kind); active++;
      try { await action(); } finally { active--; }
      if (expireAfterWrite && effect.kind === 'workspace.write') revoked = true;
    },
    async performCompact(effect, action) { if (revoked) throw new Error('lease expired'); effects.push(`pi.compact:${effect.commandId}`); await action(); },
    async requestCancellation() { revoked = true; },
    async reportWorkerStop(_id, result) { stops.push(result); },
  };
  const worker = await PiNativeWorker.start({ commandId: 'parent-command', attemptId: 'attempt', workspace, owner, workspaceManager: manager, authority, journal, stateRoot: join(root, 'pi-state'), modelRuntime: runtime, model: faux.getModel() });
  async function artifacts() {
    const entries = await readdir(join(root, 'journal', 'metadata'));
    return Promise.all(entries.map(async (file) => {
      const metadata = JSON.parse(await readFile(join(root, 'journal', 'metadata', file), 'utf8')) as ArtifactMetadata;
      return { metadata, text: (await journal.read(metadata.raw, metadata.sourceIdentity)).toString() };
    }));
  }
  return { root, worker, manager, workspace, owner, faux, ai, journal, effects, stops, active: () => active,
    expireAfterWrite: () => { expireAfterWrite = true; }, artifacts,
    async cleanup() { worker.dispose(); manager.close(); await journal.close(); await rm(root, { recursive: true, force: true }); } };
}

test('reopen continues edits and semantic evidence; malformed and exact terminal bytes survive', async () => {
  const f = await setup();
  try {
    const terminal = ` \n${envelope(['README.md'])}\n `;
    f.faux.setResponses([f.ai.fauxAssistantMessage(f.ai.fauxToolCall('helm_write', { path: 'README.md', contents: 'first edit\n' })), f.ai.fauxAssistantMessage('bad envelope'), f.ai.fauxAssistantMessage(terminal)]);
    const first = await f.worker.run('edit', 'repair envelope');
    assert.equal(first.repaired, true);
    const before = await f.artifacts();
    const configuration = before.find((entry) => entry.metadata.source === 'pi.configuration');
    assert.deepEqual(JSON.parse(configuration!.text), { requested: 'medium', nativeSelected: 'off', providerEffective: 'unknown' }, 'the durable receipt distinguishes the host request from Pi selection and never claims provider-effective reasoning');
    assert.ok(before.some((entry) => entry.metadata.source === 'pi.envelope' && entry.text === 'bad envelope'));
    assert.ok(before.some((entry) => entry.metadata.source === 'pi.envelope' && entry.text === terminal));
    assert.equal(await readFile(join(f.workspace.root, 'README.md'), 'utf8'), 'first edit\n');
    const id = f.worker.sessionId; await f.worker.reopen(); assert.equal(f.worker.sessionId, id);
    f.faux.setResponses([f.ai.fauxAssistantMessage(f.ai.fauxToolCall('helm_write', { path: 'README.md', contents: 'second edit\n' })), f.ai.fauxAssistantMessage(envelope(['README.md']))]);
    const second = await f.worker.run('continue', 'repair');
    assert.equal(second.repaired, false);
    assert.equal(await readFile(join(f.workspace.root, 'README.md'), 'utf8'), 'second edit\n');
    const after = await f.artifacts();
    assert.ok(after.filter((entry) => entry.metadata.source === 'pi.event').length > before.filter((entry) => entry.metadata.source === 'pi.event').length);
    await assert.rejects(readFile(join(f.root, 'extension-ran')), /ENOENT/);
    assert.equal(f.faux.state.callCount, 5);
    assert.equal(f.effects.filter((kind) => kind === 'model.request').length, 5);
  } finally { await f.cleanup(); }
});

test('expiry after a tool prevents the automatic next model request and preserves missing-envelope evidence', async () => {
  const f = await setup();
  try {
    f.expireAfterWrite();
    f.faux.setResponses([f.ai.fauxAssistantMessage(f.ai.fauxToolCall('helm_write', { path: 'result.txt', contents: 'before expiry' })), f.ai.fauxAssistantMessage(envelope(['result.txt']))]);
    await assert.rejects(f.worker.run('write', 'repair'));
    assert.equal(f.faux.state.callCount, 1, 'no second provider call after expiry');
    assert.equal(await readFile(join(f.workspace.root, 'result.txt'), 'utf8'), 'before expiry');
    assert.ok((await f.artifacts()).some((entry) => entry.metadata.source === 'pi.envelope_disposition' && entry.text.includes('envelope_missing')));
  } finally { await f.cleanup(); }
});

test('model authority remains in flight until provider completion; ignored abort never reports stopped early', async () => {
  const f = await setup();
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    f.faux.setResponses([async () => { started(); await gate; return f.ai.fauxAssistantMessage(envelope([])); }]);
    const run = f.worker.run('wait', 'repair').then(() => undefined, () => undefined);
    await entered; assert.equal(f.active(), 1, 'stream construction alone cannot settle authority');
    assert.equal(await f.worker.cancel(20), 'unknown');
    assert.deepEqual(f.stops, ['unknown']);
    assert.equal(f.active(), 1, 'pending provider remains in flight after local cancellation deadline');
    release(); await run;
    assert.equal(f.active(), 0);
    assert.equal(await f.worker.cancel(100), 'stopped');
    assert.deepEqual(f.stops, ['unknown', 'stopped']);
  } finally { release?.(); await f.cleanup(); }
});

test('provider error text is not forwarded into Pi output or journal artifacts', async () => {
  const f = await setup();
  try {
    f.faux.setResponses([async () => { throw new Error('provider-body-must-not-be-journalled'); }]);
    await assert.rejects(f.worker.run('fail', 'repair'));
    const artifacts = await f.artifacts();
    assert.ok(artifacts.length > 0);
    assert.ok(artifacts.every((entry) => !entry.text.includes('provider-body-must-not-be-journalled')));
  } finally { await f.cleanup(); }
});

test('manual compaction checkpoints immutable handoff facts, runs as a distinct control effect, and leaves post-compaction occupancy unknown', async () => {
  const f = await setup();
  try {
    f.faux.setResponses([f.ai.fauxAssistantMessage(envelope([])), f.ai.fauxAssistantMessage('summary')]);
    await f.worker.run('context '.repeat(8_000), 'repair');
    const make = async (name: string) => ({ sourceIdentity: name, raw: await f.journal.append({ source: 'fixture', sourceIdentity: name, mediaType: 'application/json', bytes: Buffer.from('{}') }) });
    const checkpoint = { objective: await make('objective'), acceptance: await make('acceptance'), brief: await make('brief'), map: await make('map'), decisions: [], handoffs: [await make('handoff')] };
    const refs = await f.worker.manualCompact({ commandId: 'compact-command', effectId: 'compact-effect', checkpoint });
    assert.equal(refs.length, 2); assert.ok(f.effects.includes('pi.compact:compact-command')); assert.equal(f.faux.state.callCount, 2);
    const checkpointArtifact = (await f.artifacts()).find((entry) => entry.metadata.source === 'pi.checkpoint')!;
    const persisted = JSON.parse(checkpointArtifact.text); assert.equal(persisted.provenance.compactCommandId, 'compact-command'); assert.equal(persisted.checkpoint.length, 5);
    assert.equal(f.worker.contextOccupancy.state, 'unknown');
  } finally { await f.cleanup(); }
});
