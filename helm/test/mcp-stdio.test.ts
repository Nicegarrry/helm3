/** Drives `helm serve --stdio` as a child process through the real MCP client. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_NAMES } from '../src/types.ts';

test('mcp stdio: a real client lists all tools and calls them through helm serve --stdio', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/cli.ts', 'serve', '--stdio'],
    cwd: process.cwd(),
    env: { ...process.env, HELM_HOME: home } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'helm-test', version: '0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');
    const status = JSON.parse(text(await client.callTool({ name: 'run.status', arguments: {} }))) as { ok: boolean; maxWorkers: number };
    assert.equal(status.ok, true);
    assert.equal(status.maxWorkers, 3);
    const missing = JSON.parse(text(await client.callTool({ name: 'worker.inspect', arguments: { workerId: 'nope' } }))) as { ok: boolean; reason: string };
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'worker not found');
    // stdio mode also binds the read-only status page on loopback and records it in serve.json.
    const serveJson = JSON.parse(readFileSync(join(home, 'serve.json'), 'utf8')) as { port: number };
    const page = await fetch(`http://127.0.0.1:${serveJson.port}/`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Helm<\/title>/);
    const state = (await (await fetch(`http://127.0.0.1:${serveJson.port}/api/state`)).json()) as { ok: boolean; workers: unknown[] };
    assert.equal(state.ok, true);
    assert.deepEqual(state.workers, []);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
