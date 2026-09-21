import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

// Exercise the actual CLI parser and HTTP request, without starting any model workers.
test('CLI forwards optional models and task tiers for spawn and review', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helm-cli-routing-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url!, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(join(home, 'serve.json'), JSON.stringify({ port: address.port, pid: process.pid }));
  const cli = async (...args: string[]) => promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...args], { env: { ...process.env, HELM_HOME: home }, timeout: 15000 });
  await cli('spawn', '--repo', '/repo', '--objective', 'task');
  await cli('spawn', '--repo', '/repo', '--objective', 'task', '--difficulty', 'easy');
  await cli('spawn', '--repo', '/repo', '--objective', 'task', '--difficulty', 'super-easy', '--model', 'custom/model');
  await cli('review', 'w-1');
  assert.equal(calls.length, 4);
  assert.equal(calls[0]!.path, '/tools/worker.spawn');
  assert.equal(calls[0]!.body.model, undefined);
  assert.equal(calls[0]!.body.difficulty, undefined);
  assert.equal(calls[1]!.body.difficulty, 'easy');
  assert.equal(calls[2]!.body.difficulty, 'super-easy');
  assert.equal(calls[2]!.body.model, 'custom/model');
  assert.deepEqual(calls[3], { path: '/tools/review.request', body: { workerId: 'w-1' } });
});
