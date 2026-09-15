import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactJournal } from '../../src/journal/index.js';
import { classifyCi, runGate, type GateCheck } from '../../src/verification/index.js';

async function fixture(run: (input: Parameters<typeof runGate>[0]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'helm3-gate-'));
  const workspace = join(root, 'repo');
  execFileSync('git', ['init', '-q', workspace]);
  const git = (args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base']);
  const journal = await ArtifactJournal.open({ root: join(root, 'journal'), hostPolicy: { allowSensitiveWrites: true } });
  try { await run({ gateId: 'local-gate', workspace, expectedHead: git(['rev-parse', 'HEAD']), journal, env: { PATH: process.env.PATH ?? '' }, assertAuthority: async () => {}, checks: [] }); }
  finally { journal.close(); await rm(root, { recursive: true, force: true }); }
}
const check = (name: string, code: string): GateCheck => ({ name, executable: process.execPath, args: ['-e', code], timeoutMs: 5000 });

test('ported CI classification rejects empty, neutral, skipped and failing checks', () => {
  assert.equal(classifyCi([]).state, 'none');
  for (const conclusion of ['neutral', 'skipped', null]) assert.equal(classifyCi([{ source: 'check_run', status: 'completed', conclusion }]).state, 'pending');
  assert.equal(classifyCi([{ source: 'check_run', status: 'completed', conclusion: 'success' }, { source: 'status', status: 'failure', conclusion: null }]).state, 'red');
  assert.equal(classifyCi([{ source: 'check_run', status: 'completed', conclusion: 'success' }, { source: 'status', status: 'success', conclusion: null }]).state, 'green');
});

test('gate records exact head, individual checks and protected command evidence', async () => fixture(async input => {
  const { result, evidence } = await runGate({ ...input, checks: [check('oracle', 'console.log("green")'), check('contract', 'process.exit(0)')] });
  assert.equal(result.state, 'passed'); assert.equal(result.observedHead, input.expectedHead); assert.equal(result.checks.length, 2);
  await assert.rejects(input.journal.read(evidence, `gate:${result.attemptId}:result`));
  const raw = await input.journal.read(evidence, `gate:${result.attemptId}:result`, { permitSensitive: true });
  assert.deepEqual(JSON.parse(raw.toString()), result);
}));

test('failed gate records checked commands and does not run later commands', async () => fixture(async input => {
  const { result } = await runGate({ ...input, checks: [check('red', 'process.exit(2)'), check('must-not-run', 'throw Error()')] });
  assert.equal(result.state, 'failed'); assert.equal(result.checks.length, 1); assert.equal(result.checks[0].exitCode, 2);
}));

test('dirty or moved heads refuse, and mutation during a gate is never a pass', async () => fixture(async input => {
  await assert.rejects(runGate({ ...input, expectedHead: 'f'.repeat(40), checks: [check('unused', '')] }), /expected head/);
  await writeFile(join(input.workspace, 'untracked'), 'dirty');
  await assert.rejects(runGate({ ...input, checks: [check('unused', '')] }), /clean/);
  await rm(join(input.workspace, 'untracked'));
  const { result } = await runGate({ ...input, checks: [check('mutation', 'require("node:fs").writeFileSync("unexpected", "x")')] });
  assert.equal(result.state, 'unknown'); assert.match(result.reason!, /changed/);
}));

test('authority is refreshed per check; bounded execution and output retain uncertainty', async () => fixture(async input => {
  let guards = 0;
  const denied = await runGate({ ...input, checks: [check('first', ''), check('second', '')], assertAuthority: async () => { if (++guards === 3) throw Error('expired'); } });
  assert.equal(denied.result.state, 'unknown'); assert.equal(denied.result.checks.length, 1);
  const timed = await runGate({ ...input, checks: [{ ...check('timeout', 'setInterval(()=>{},1000)'), timeoutMs: 30 }] });
  assert.equal(timed.result.state, 'unknown'); assert.equal(timed.result.checks[0].timedOut, true);
  const overflow = await runGate({ ...input, maxOutputBytes: 10, checks: [check('output', 'console.log("xxxxxxxxxxxxxxxxxxxxxxxx")')] });
  assert.equal(overflow.result.state, 'unknown'); assert.equal(overflow.result.checks[0].outputLimit, true);
}));
