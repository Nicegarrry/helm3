import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { operatorCli } from '../../src/operator/cli.js';
import { createOperatorServer, listenOperatorServer } from '../../src/operator/server.js';
import { readSavedOperatorSnapshot, savedSnapshotByteLimit } from '../../src/operator/saved-snapshot.js';

const snapshot = Object.freeze({
  schemaVersion: 1 as const, observedAt: '2026-09-16T00:00:00.000Z',
  source: { kind: 'helm-log' as const, evidenceMode: 'unknown' as const, id: '<unsafe-source>', observedAt: '2026-09-15T23:00:00.000Z' },
  unknowns: ['<unknown>'], map: null,
  run: { runId: 'preserved-run', owner: { orchestrator: null, epoch: null }, leases: { orchestrator: { state: 'unknown' as const, id: null, expiresAt: null }, autonomy: { state: 'unknown' as const, id: null, expiresAt: null } } },
  attempts: [], pendingCommands: [], needsYou: null, resources: { units: [], context: [] }, quality: { gate: { passed: null, total: null }, integration: { passed: null, total: null } },
});

async function close(server: ReturnType<typeof createOperatorServer>): Promise<void> { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

test('saved snapshot is historical and untrusted while preserving its validated projection and file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-saved-snapshot-'));
  try {
    const path = join(root, 'snapshot.json'); const original = Buffer.from(JSON.stringify(snapshot));
    await writeFile(path, original, { mode: 0o600 }); const before = await stat(path, { bigint: true });
    const source = await readSavedOperatorSnapshot(path); assert.equal(source.presentation?.mode, 'historical-untrusted');
    const server = createOperatorServer(source); const { host, port } = await listenOperatorServer(server); const origin = `http://${host}:${port}`;
    try {
      const api = await fetch(`${origin}/api/operator/snapshot`); assert.equal(api.status, 200); assert.equal(api.headers.get('x-helm-projection'), 'historical-untrusted'); assert.deepEqual(await api.json(), snapshot);
      assert.match(await operatorCli(['--url', origin]), /Projection: historical-untrusted \(cannot authorize actions\)/); assert.deepEqual(JSON.parse(await operatorCli(['--url', origin, '--json'])), { snapshot, projection: { mode: 'historical-untrusted', actionAuthority: 'none' } });
      const html = await fetch(origin).then((response) => response.text()); assert.match(html, /Historical, untrusted projection/); assert.match(html, /cannot authorize actions/); assert.match(html, /&lt;unsafe-source&gt;/); assert.match(html, /&lt;unknown&gt;/);
      assert.equal((await fetch(origin, { method: 'POST' })).status, 405); assert.equal((await fetch(`${origin}/not-a-file`)).status, 404);
    } finally { await close(server); }
    const after = await stat(path, { bigint: true }); assert.deepEqual(await (await import('node:fs/promises')).readFile(path), original); assert.equal(after.mtimeNs, before.mtimeNs);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('saved snapshot rejects unsafe or invalid inputs without opening a host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-saved-snapshot-'));
  try {
    const valid = join(root, 'valid.json'); await writeFile(valid, JSON.stringify(snapshot));
    const link = join(root, 'link.json'); await symlink(valid, link);
    await assert.rejects(readSavedOperatorSnapshot(link));
    await assert.rejects(readSavedOperatorSnapshot(root), /regular file/);
    const malformed = join(root, 'malformed.json'); await writeFile(malformed, '{'); await assert.rejects(readSavedOperatorSnapshot(malformed), /invalid JSON/);
    const oversized = join(root, 'oversized.json'); await writeFile(oversized, 'x'.repeat(savedSnapshotByteLimit + 1)); await assert.rejects(readSavedOperatorSnapshot(oversized), /byte limit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('saved snapshot rejects a FIFO without blocking the process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-saved-snapshot-'));
  try {
    const fifo = join(root, 'snapshot.fifo');
    await new Promise<void>((resolve, reject) => { const child = spawn('mkfifo', [fifo]); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`mkfifo failed (${code})`))); });
    const script = `void import('./src/operator/saved-snapshot.ts').then((module) => { const reader = module.readSavedOperatorSnapshot ?? module.default?.readSavedOperatorSnapshot; if (typeof reader !== 'function') throw new Error('saved snapshot loader failed'); return reader(process.argv[1]); }).then(() => { process.exitCode = 1; }, (error) => { if (error instanceof Error && error.message === 'snapshot must be a regular file') process.exitCode = 0; else { process.stderr.write(String(error)); process.exitCode = 2; } });`;
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script, fifo], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('FIFO reader blocked')); }, 2_000); child.once('error', (error) => { clearTimeout(timer); reject(error); }); child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`FIFO reader unexpectedly accepted input (${code}): ${stderr}`)); }); });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('saved snapshot detects a source change between handle checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-saved-snapshot-'));
  try {
    const path = join(root, 'snapshot.json'); await writeFile(path, JSON.stringify(snapshot));
    const handle = await (await import('node:fs/promises')).open(path, 'r'); const prototype = Object.getPrototypeOf(handle); const originalRead = prototype.read; await handle.close();
    let changed = false;
    prototype.read = async function(this: typeof handle, ...args: Parameters<typeof originalRead>) { const result = await originalRead.apply(this, args); if (!changed) { changed = true; await appendFile(path, ' '); } return result; };
    try { await assert.rejects(readSavedOperatorSnapshot(path), /changed while reading/); } finally { prototype.read = originalRead; }
    assert.equal(changed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
