import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ArtifactJournal } from '../journal/index.js';
import type { RawArtifactRef } from '../contracts/index.js';

/** Behaviour ported from helm-cli@ae5c3ff src/check/index.ts. A neutral/absent check is not green. */
export type CiCheck = { status: string; conclusion: string | null; source: 'check_run' | 'status' | 'rollup' };
export function classifyCi(checks: readonly CiCheck[]): { state: 'none' | 'red' | 'green' | 'pending'; passed: number; total: number } {
  if (!checks.length) return { state: 'none', passed: 0, total: 0 };
  const run = (c: CiCheck) => c.source === 'check_run' || (c.source === 'rollup' && c.conclusion !== null);
  const passed = checks.filter(c => run(c) ? c.status === 'completed' && c.conclusion === 'success' : c.status === 'success').length;
  const failed = checks.some(c => run(c) ? c.status === 'completed' && ['action_required', 'cancelled', 'failure', 'stale', 'timed_out'].includes(c.conclusion ?? '') : ['error', 'failure'].includes(c.status));
  return { state: failed ? 'red' : passed === checks.length ? 'green' : 'pending', passed, total: checks.length };
}

/** Configured by the trusted host, never accepted as arbitrary model tool input. */
export type GateCheck = Readonly<{ name: string; executable: string; args: readonly string[]; timeoutMs: number }>;
export type GateEvidence = Readonly<{
  gateId: string; attemptId: string; expectedHead: string; observedHead: string | null;
  state: 'passed' | 'failed' | 'unknown'; startedAt: string; completedAt: string;
  checks: readonly { name: string; executable: string; args: readonly string[]; exitCode: number | null; signal: string | null; timedOut: boolean; outputLimit: boolean; evidence: RawArtifactRef }[];
  reason: string | null;
}>;
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }).trim();
}
function world(root: string): { head: string; clean: boolean } {
  return { head: git(root, ['rev-parse', 'HEAD']), clean: git(root, ['status', '--porcelain', '--untracked-files=all']) === '' };
}
async function execute(check: GateCheck, root: string, env: Record<string, string>, maxBytes: number) {
  return new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; outputLimit: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(check.executable, [...check.args], { cwd: root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = []; let bytes = 0, timedOut = false, outputLimit = false, settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve({ exitCode, signal, timedOut, outputLimit, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    const stopUncertain = () => { child.kill('SIGKILL'); finish(null, 'SIGKILL'); };
    const collect = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, maxBytes - bytes); if (remaining) target.push(chunk.subarray(0, remaining)); bytes += chunk.length;
      if (bytes > maxBytes) { outputLimit = true; stopUncertain(); }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(out, chunk)); child.stderr.on('data', (chunk: Buffer) => collect(err, chunk));
    timer = setTimeout(() => { timedOut = true; stopUncertain(); }, check.timeoutMs);
    child.once('error', () => { err.push(Buffer.from('Gate process could not start')); finish(null, null); });
    child.once('close', finish);
  });
}

/** Local mechanics only. The embedding host owns command admission and authority; this checks it before each effect. */
export async function runGate(input: {
  gateId: string; workspace: string; expectedHead: string; checks: readonly GateCheck[];
  journal: ArtifactJournal; env: Record<string, string>; assertAuthority: () => Promise<void>;
  maxOutputBytes?: number;
}): Promise<{ result: GateEvidence; evidence: RawArtifactRef }> {
  if (!/^[0-9a-f]{40}$/.test(input.expectedHead) || !input.gateId.trim() || !input.checks.length) throw new Error('Gate requires an exact head, identity and checks');
  const maxBytes = input.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid output bound');
  const checks = input.checks.map(check => {
    if (!check.name.trim() || !check.executable.trim() || !Number.isSafeInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 300000) throw new Error('Invalid gate check');
    return Object.freeze({ ...check, args: Object.freeze([...check.args]) });
  });
  const before = world(input.workspace);
  if (before.head !== input.expectedHead || !before.clean) throw new Error('Gate workspace must be clean at the expected head');
  await input.assertAuthority();
  const attemptId = randomUUID(), startedAt = new Date().toISOString();
  await input.journal.append({ classification: 'sensitive', source: 'helm.gate.started', sourceIdentity: `gate:${attemptId}:start`, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ gateId: input.gateId, attemptId, expectedHead: input.expectedHead, checks, startedAt })) }, { permitSensitive: true });
  const observed: GateEvidence['checks'][number][] = [];
  let reason: string | null = null;
  for (const check of checks) {
    try {
      await input.assertAuthority();
      const fresh = world(input.workspace);
      if (fresh.head !== input.expectedHead || !fresh.clean) { reason = 'Workspace changed before a gate effect'; break; }
    } catch { reason = 'Gate authority or workspace observation unavailable'; break; }
    const execution = await execute(check, input.workspace, { ...input.env }, maxBytes);
    // Raw command output can be sensitive; the host must explicitly enable protected persistence.
    const evidence = await input.journal.append({ source: 'helm.gate.check', sourceIdentity: `gate:${attemptId}:check:${observed.length}`, mediaType: 'application/json', classification: 'sensitive', bytes: Buffer.from(JSON.stringify({ check, ...execution })) }, { permitSensitive: true });
    const { stdout: _stdout, stderr: _stderr, ...status } = execution;
    observed.push({ ...check, ...status, evidence });
    if (execution.exitCode === null || execution.signal || execution.timedOut || execution.outputLimit) { reason = 'Execution termination or evidence is uncertain'; break; }
    if (execution.exitCode !== 0) break;
  }
  let observedHead: string | null = null;
  try { const after = world(input.workspace); observedHead = after.head; if (after.head !== input.expectedHead || !after.clean) reason = 'Workspace changed during gate execution'; }
  catch { reason = 'Final workspace observation unavailable'; }
  const state = reason ? 'unknown' : observed.some(c => c.exitCode !== 0) ? 'failed' : observed.length === checks.length ? 'passed' : 'unknown';
  const result: GateEvidence = { gateId: input.gateId, attemptId, expectedHead: input.expectedHead, observedHead, state, startedAt, completedAt: new Date().toISOString(), checks: observed, reason };
  const evidence = await input.journal.append({ classification: 'sensitive', source: 'helm.gate.completed', sourceIdentity: `gate:${attemptId}:result`, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(result)) }, { permitSensitive: true });
  return { result, evidence };
}
