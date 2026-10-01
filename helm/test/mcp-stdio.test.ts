/** Drives `helm serve --stdio` as a child process through the real MCP client. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serve } from '../src/server.ts';
import { CORE_TOOL_NAMES, META_TOOL_NAMES, SUPERVISOR_TOOL_NAMES } from '../src/tools.ts';

function stdioFrontEnd(home: string, tools = 'core', progressPollMs?: number) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/cli.ts', 'serve', '--stdio'],
    cwd: process.cwd(),
    env: { ...process.env, HELM_HOME: home, HELM_MAX_WORKERS: '3', HELM_TOOLS: tools, ...(progressPollMs ? { HELM_PROGRESS_POLL_MS: String(progressPollMs) } : {}) } as Record<string, string>,
    stderr: 'pipe',
  });
  return { transport, client: new Client({ name: 'helm-test', version: '0' }) };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return check();
}

const PROGRESS_TIMEOUT_MS = 10_000;

type ProgressUpdate = { progress?: number; _meta?: { helm?: { state?: string; position?: number | null; etaMs?: number; activity?: string } } };

async function waitForProgressState(updates: ProgressUpdate[], state: string) {
  assert.equal(await until(() => updates.some((update) => update._meta?.helm?.state === state), PROGRESS_TIMEOUT_MS), true, `did not receive ${state} progress`);
  return updates.find((update) => update._meta?.helm?.state === state)!;
}

function daemonOf(home: string): { port: number; pid: number; token: string } {
  return JSON.parse(readFileSync(join(home, 'serve.json'), 'utf8')) as { port: number; pid: number; token: string };
}

async function stopDaemon(home: string): Promise<void> {
  if (!existsSync(join(home, 'serve.json'))) return;
  const { pid } = daemonOf(home);
  if (alive(pid)) process.kill(pid, 'SIGINT');
  await until(() => !alive(pid), 5000);
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

function waitingDaemon(home: string) {
  let state = 'queued';
  let lastEvent: { kind: string; data: Record<string, string> } = { kind: 'capacity.queued', data: { reason: 'capacity' } };
  let progressCalls = 0;
  let waitStarted = false;
  let resolveWait!: () => void;
  const helm = {
    config: { home, spendCapUsd: 0, maxWorkers: 1, gateTimeoutMs: 1_000 },
    wait: async () => new Promise((resolve) => {
      waitStarted = true;
      resolveWait = () => resolve({ ok: true, settled: [{ workerId: 'w-progress', state, head: null, result: null }], pending: [], timedOut: false, waitedMs: 1 });
    }),
    progress: async (_ids: string[], timeoutMs: number, startedAt: number) => {
      progressCalls += 1;
      return {
        ok: true,
        workers: [{ workerId: 'w-progress', state, position: state === 'queued' ? 1 : null, etaMs: Math.max(0, startedAt + timeoutMs - Date.now()), lastEvent }],
      };
    },
  };
  return {
    helm,
    setState(next: string, kind = 'turn.start') { state = next; lastEvent = { kind, data: { summary: `${next} activity` } }; },
    finish() { state = 'succeeded'; lastEvent = { kind: 'result', data: { summary: 'done' } }; resolveWait(); },
    progressCalls: () => progressCalls,
    waitStarted: () => waitStarted,
  };
}

async function progressProxy(home: string) {
  const daemon = waitingDaemon(home);
  const daemonHandle = await serve({ helm: daemon.helm as never });
  const { transport, client } = stdioFrontEnd(home, 'all', 50);
  await client.connect(transport);
  return {
    daemon,
    client,
    transport,
    async close() {
      await client.close();
      if (transport.pid) await until(() => !alive(transport.pid!), 5_000);
      await daemonHandle.close();
    },
  };
}

test('mcp stdio: worker.wait forwards token-scoped queued, running, and done progress', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-progress-'));
  const harness = await progressProxy(home);
  try {
    const updates: ProgressUpdate[] = [];
    const waiting = harness.client.callTool(
      { name: 'worker.wait', arguments: { workerIds: ['w-progress'], timeoutMs: 10_000 } },
      undefined,
      { onprogress: (update) => updates.push(update as unknown as ProgressUpdate) },
    );
    const queued = await waitForProgressState(updates, 'queued');
    assert.ok(harness.transport.pid && alive(harness.transport.pid), 'the proxy remains alive after progress notification');
    assert.equal(harness.daemon.waitStarted(), true);
    assert.equal(queued._meta!.helm!.position, 1);
    assert.equal(typeof queued._meta!.helm!.etaMs, 'number');
    assert.match(queued._meta!.helm!.activity ?? '', /capacity\.queued/);

    harness.daemon.setState('running');
    await waitForProgressState(updates, 'running');

    harness.daemon.finish();
    await waiting;
    assert.ok(harness.transport.pid && alive(harness.transport.pid), 'the final progress publish keeps the proxy alive');
    await waitForProgressState(updates, 'succeeded');
    assert.ok(updates.every((update, index) => index === 0 || update.progress! > updates[index - 1]!.progress!));
  } finally {
    await harness.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('mcp stdio: worker.wait does not poll or emit progress without a progress token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-progress-'));
  const harness = await progressProxy(home);
  try {
    const waiting = harness.client.callTool({ name: 'worker.wait', arguments: { workerIds: ['w-progress'], timeoutMs: 10_000 } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(harness.daemon.progressCalls(), 0);
    harness.daemon.finish();
    await waiting;
    assert.equal(harness.daemon.progressCalls(), 0);
  } finally {
    await harness.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('mcp stdio: a real client lists core tools and calls them through helm serve --stdio', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-mcp-'));
  const { transport, client } = stdioFrontEnd(home);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...CORE_TOOL_NAMES, ...META_TOOL_NAMES].sort());
    const status = JSON.parse(text(await client.callTool({ name: 'run.status', arguments: {} }))) as { ok: boolean; maxWorkers: number };
    assert.equal(status.ok, true);
    assert.equal(status.maxWorkers, 3);
    const missing = JSON.parse(text(await client.callTool({ name: 'worker.inspect', arguments: { workerId: 'nope' } }))) as { ok: boolean; reason: string };
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'worker not found');
    // The front-end started a daemon, which records itself in serve.json.
    const daemon = daemonOf(home);
    assert.notEqual(daemon.pid, transport.pid, 'the daemon is a separate process from the stdio front-end');
    assert.match(daemon.token, /^[a-f0-9]{64}$/);
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'daemon', '--action', 'status', '--json'],
      { env: { ...process.env, HELM_HOME: home }, timeout: 15000 });
    assert.equal(JSON.parse(stdout).ok, true, 'CLI reaches the real authenticated daemon');
    assert.ok(!`${stdout}${stderr}`.includes(daemon.token));
    await stopDaemon(home);
    for (const file of ['daemon.log', 'helm.sqlite']) {
      assert.ok(!readFileSync(join(home, file)).includes(Buffer.from(daemon.token)), `${file} must not contain the token`);
    }
  } finally {
    await client.close();
    await stopDaemon(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test('mcp stdio: the front-end exits with its client, the daemon outlives it, and a second client attaches to the same daemon', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-mcp-'));
  const a = stdioFrontEnd(home);
  const b = stdioFrontEnd(home, 'supervisor');
  try {
    await a.client.connect(a.transport);
    const daemon = daemonOf(home);
    const aPid = a.transport.pid;
    assert.ok(aPid && alive(aPid));

    // A second orchestrator session in another project: no second daemon, same store.
    await b.client.connect(b.transport);
    assert.deepEqual(daemonOf(home), daemon, 'the second front-end attached instead of starting a daemon');
    assert.notEqual(b.transport.pid, aPid);
    const { tools } = await b.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...SUPERVISOR_TOOL_NAMES, ...META_TOOL_NAMES].sort());
    const fromB = JSON.parse(text(await b.client.callTool({ name: 'run.status', arguments: {} }))) as { ok: boolean };
    assert.equal(fromB.ok, true);

    // Closing A's stdin is what Claude Code does on exit. A must go; the daemon and B must not.
    await a.client.close();
    assert.equal(await until(() => !alive(aPid!), 5000), true, 'the stdio front-end exits when its client closes');
    assert.ok(alive(daemon.pid), 'the daemon outlives the front-end');
    const stillB = JSON.parse(text(await b.client.callTool({ name: 'run.status', arguments: {} }))) as { ok: boolean };
    assert.equal(stillB.ok, true, 'the other client is unaffected');
  } finally {
    await a.client.close().catch(() => undefined);
    await b.client.close().catch(() => undefined);
    await stopDaemon(home);
    rmSync(home, { recursive: true, force: true });
  }
});
