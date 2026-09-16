import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const command = (args: readonly string[], timeout = 30_000) => spawnSync(process.execPath, ['--import', 'tsx', 'src/dogfood/observe.ts', ...args], { cwd: process.cwd(), encoding: 'utf8', timeout });
const argumentsFor = (state: string, orchestrator: 'fable' | 'astra', scenario?: 'default' | 'native-fork') => ['--orchestrator', orchestrator, '--state-directory', state, ...(scenario ? ['--scenario', scenario] : [])];
async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> { return new Promise((resolve) => { if (child.exitCode !== null) { resolve(child.exitCode); return; } const timer = setTimeout(() => resolve(null), timeoutMs); child.once('exit', (code) => { clearTimeout(timer); resolve(code); }); }); }
async function stopAndReap(child: ReturnType<typeof spawn>, signal: NodeJS.Signals, timeoutMs: number): Promise<number | null> { if (child.exitCode !== null) return child.exitCode; child.kill(signal); const first = await waitForExit(child, timeoutMs); if (first !== null) return first; child.kill('SIGKILL'); return waitForExit(child, 2_000); }

test('observation CLI keeps the default fixture and selects native-fork for both drivers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-observe-cli-'));
  try {
    const defaultRun = command(argumentsFor(join(root, 'default'), 'fable')); assert.equal(defaultRun.status, 0, defaultRun.stderr);
    const defaultResult = JSON.parse(defaultRun.stdout) as { fixture: boolean; scenario: string; usageActions: { modelRequests: number; workspaceWrites: number }; steerSessionId: string; workerSessionId: string };
    assert.equal(defaultResult.fixture, true); assert.equal(defaultResult.scenario, 'default'); assert.deepEqual(defaultResult.usageActions, { modelRequests: 4, workspaceWrites: 2 }); assert.equal(defaultResult.steerSessionId, defaultResult.workerSessionId);
    for (const orchestrator of ['fable', 'astra'] as const) {
      const observed = command(argumentsFor(join(root, `fork-${orchestrator}`), orchestrator, 'native-fork')); assert.equal(observed.status, 0, observed.stderr);
      const result = JSON.parse(observed.stdout) as { fixture: boolean; scenario: string; usageActions: { modelRequests: number; workspaceWrites: number }; workerSessionId: string; steerSessionId: string; gateCommandState: string; mapCloseState: string };
      assert.equal(result.fixture, true); assert.equal(result.scenario, 'native-fork'); assert.deepEqual(result.usageActions, { modelRequests: 4, workspaceWrites: 2 }); assert.notEqual(result.workerSessionId, result.steerSessionId); assert.equal(result.gateCommandState, 'succeeded'); assert.equal(result.mapCloseState, 'succeeded');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid observation CLI input fails before creating supplied state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-observe-cli-'));
  try {
    const state = join(root, 'must-not-exist');
    for (const [extra, expected] of [
      [['--scenario', 'unknown'], /scenario must be default or native-fork/],
      [['--scenario'], /missing value for --scenario/],
      [['--unexpected'], /unknown argument: --unexpected/],
      [['trailing'], /unknown argument: trailing/],
      [['--scenario', 'default', '--scenario', 'native-fork'], /duplicate --scenario/],
    ] as const) { const invalid = command([...argumentsFor(state, 'fable'), ...extra]); assert.equal(invalid.status, 2); assert.match(invalid.stderr, expected); await assert.rejects(access(state)); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('serve keeps the selected fixture scenario and exits on SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-observe-cli-')); let child: ReturnType<typeof spawn> | undefined;
  try {
    const started = spawn(process.execPath, ['--import', 'tsx', 'src/dogfood/observe.ts', ...argumentsFor(join(root, 'serve'), 'astra', 'native-fork'), '--serve'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }); child = started;
    const childStdout = started.stdout!; const childStderr = started.stderr!; let stdout = ''; let stderr = ''; childStdout.setEncoding('utf8'); childStderr.setEncoding('utf8'); childStdout.on('data', chunk => { stdout += chunk; }); childStderr.on('data', chunk => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('serve did not announce its operator')), 30_000); const data = () => { if (!stdout.includes('\n')) return; clearTimeout(timer); childStdout.off('data', data); resolve(); }; childStdout.on('data', data); started.once('error', (error) => { clearTimeout(timer); reject(error); }); });
    const result = JSON.parse(stdout.slice(0, stdout.indexOf('\n'))) as { fixture: boolean; scenario: string; operator: { url: string } }; assert.equal(result.fixture, true); assert.equal(result.scenario, 'native-fork'); assert.match(result.operator.url, /^http:\/\/127\.0\.0\.1:/);
    const exit = await stopAndReap(started, 'SIGTERM', 5_000); assert.equal(exit, 0, stderr);
  } finally { if (child) await stopAndReap(child, 'SIGKILL', 2_000); await rm(root, { recursive: true, force: true }); }
});
