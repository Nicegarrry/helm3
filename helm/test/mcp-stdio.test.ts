/** Drives `helm serve --stdio` as a child process through the real MCP client. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_NAMES } from '../src/types.ts';

function stdioFrontEnd(home: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/cli.ts', 'serve', '--stdio'],
    cwd: process.cwd(),
    env: { ...process.env, HELM_HOME: home } as Record<string, string>,
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

function daemonOf(home: string): { port: number; pid: number } {
  return JSON.parse(readFileSync(join(home, 'serve.json'), 'utf8')) as { port: number; pid: number };
}

async function stopDaemon(home: string): Promise<void> {
  if (!existsSync(join(home, 'serve.json'))) return;
  const { pid } = daemonOf(home);
  if (alive(pid)) process.kill(pid, 'SIGINT');
  await until(() => !alive(pid), 5000);
}

const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

test('mcp stdio: a real client lists all tools and calls them through helm serve --stdio', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-mcp-'));
  const { transport, client } = stdioFrontEnd(home);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    const status = JSON.parse(text(await client.callTool({ name: 'run.status', arguments: {} }))) as { ok: boolean; maxWorkers: number };
    assert.equal(status.ok, true);
    assert.equal(status.maxWorkers, 3);
    const missing = JSON.parse(text(await client.callTool({ name: 'worker.inspect', arguments: { workerId: 'nope' } }))) as { ok: boolean; reason: string };
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'worker not found');
    // The front-end started a daemon, which serves the status page and records itself in serve.json.
    const daemon = daemonOf(home);
    assert.notEqual(daemon.pid, transport.pid, 'the daemon is a separate process from the stdio front-end');
    const page = await fetch(`http://127.0.0.1:${daemon.port}/`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Helm<\/title>/);
    const state = (await (await fetch(`http://127.0.0.1:${daemon.port}/api/state`)).json()) as { ok: boolean; workers: unknown[] };
    assert.equal(state.ok, true);
    assert.deepEqual(state.workers, []);
  } finally {
    await client.close();
    await stopDaemon(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test('mcp stdio: the front-end exits with its client, the daemon outlives it, and a second client attaches to the same daemon', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-mcp-'));
  const a = stdioFrontEnd(home);
  const b = stdioFrontEnd(home);
  try {
    await a.client.connect(a.transport);
    const daemon = daemonOf(home);
    const aPid = a.transport.pid;
    assert.ok(aPid && alive(aPid));

    // A second orchestrator session in another project: no second daemon, same store.
    await b.client.connect(b.transport);
    assert.deepEqual(daemonOf(home), daemon, 'the second front-end attached instead of starting a daemon');
    assert.notEqual(b.transport.pid, aPid);
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
