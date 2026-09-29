import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadRepoConfig } from './repoconfig.js';
import type { BaselineRow, GateRunner, HelmConfig, Store, WorkerRow } from './types.js';
const exec = promisify(execFile);
export function ensureBaselineTable(store: Store): void {
  store.sql.exec('CREATE TABLE IF NOT EXISTS baselines (id TEXT PRIMARY KEY, repoSlug TEXT NOT NULL, issue INTEGER NOT NULL, validatorId TEXT NOT NULL, baseRef TEXT NOT NULL, baseSha TEXT NOT NULL, testCommit TEXT NOT NULL, command TEXT NOT NULL, files TEXT NOT NULL, red INTEGER NOT NULL, outputPath TEXT NOT NULL, at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS baselines_validator ON baselines(validatorId);');
}
export function listBaselines(store: Store, validatorId?: string): BaselineRow[] {
  ensureBaselineTable(store);
  const rows = (validatorId ? store.sql.prepare('SELECT * FROM baselines WHERE validatorId = ? ORDER BY at ASC').all(validatorId) : store.sql.prepare('SELECT * FROM baselines ORDER BY at ASC').all()) as Record<string, unknown>[];
  return rows.map((row) => ({ id: row.id as string, repoSlug: row.repoSlug as string, issue: Number(row.issue), validatorId: row.validatorId as string, baseRef: row.baseRef as string, baseSha: row.baseSha as string, testCommit: row.testCommit as string, command: row.command as string, files: JSON.parse(row.files as string), red: Number(row.red), outputPath: row.outputPath as string, at: row.at as string }));
}
function glob(globPattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < globPattern.length; i += 1) {
    const char = globPattern[i]!;
    if (char === '*' && globPattern[i + 1] === '*') {
      i += 1;
      source += globPattern[i + 1] === '/' ? '(?:.*/)?' : '.*';
      if (globPattern[i + 1] === '/') i += 1;
    } else if (char === '*') source += '[^/]*'; else if (char === '?') source += '[^/]'; else source += char.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}
function matches(file: string, patterns: readonly string[]): boolean {
  const normalized = file.replace(/^\.\//, ''); return patterns.some((pattern) => glob(pattern.replace(/^\.\//, '')).test(normalized));
}
async function changedFiles(worker: WorkerRow): Promise<string[]> {
  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: worker.worktree }); if (head.trim() !== worker.head) throw new Error(`validator head changed: expected ${worker.head}, got ${head.trim()}`);
  const { stdout: status } = await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: worker.worktree }); if (status.trim()) throw new Error('worktree is not clean');
  const { stdout } = await exec('git', ['diff', '--no-renames', '--name-only', `${worker.baseSha}..${worker.head}`], { cwd: worker.worktree });
  return stdout.split('\n').map((file) => file.trim()).filter(Boolean);
}
export async function createBaseline(input: { store: Store; gates: GateRunner; config: HelmConfig; worker: WorkerRow; now: string }): Promise<{ ok: true } & BaselineRow | { ok: false; reason: string }> {
  const { store, gates, config, worker, now } = input;
  if (worker.role !== 'validator' || worker.state !== 'succeeded' || worker.result?.status !== 'succeeded') return { ok: false, reason: 'worker is not a succeeded validator' };
  const acceptance = worker.result.acceptance;
  if (!acceptance) return { ok: false, reason: 'validator result has no acceptance' };
  const issue = store.getMeta(worker.workerId)?.issue;
  if (issue === null || issue === undefined) return { ok: false, reason: 'validator has no issue' };
  const testCommit = worker.head;
  if (!testCommit) return { ok: false, reason: 'validator has no head' };
  const patterns = (await loadRepoConfig(worker.repo, worker.baseSha)).acceptance?.testGlobs ?? [];
  const files = await changedFiles(worker);
  if (files.length === 0) return { ok: false, reason: 'validator changed no files' };
  const missing = acceptance.files.filter((file) => !files.includes(file));
  if (missing.length > 0) return { ok: false, reason: `validator acceptance files not changed: ${missing.join(', ')}` };
  const offending = files.filter((file) => !matches(file, patterns));
  if (offending.length > 0) return { ok: false, reason: `validator changed non-test files: ${offending.join(', ')}` };
  const id = `b-${randomBytes(4).toString('hex')}`; const logDir = join(config.home, 'logs', worker.workerId, `baseline-${id}`);
  await mkdir(logDir, { recursive: true });
  const outcome = await gates.run(worker.worktree, [{ name: 'acceptance', command: acceptance.command }], logDir, { timeoutMs: config.gateTimeoutMs });
  const check = outcome.checks[0];
  if (outcome.passed || check?.exitCode === 0) return { ok: false, reason: 'test already passes' };
  if (check?.exitCode === null || check?.exitCode === undefined) return { ok: false, reason: 'test did not exit non-zero' };
  const baseline: BaselineRow = { id, repoSlug: worker.repoSlug, issue, validatorId: worker.workerId, baseRef: worker.baseRef, baseSha: worker.baseSha, testCommit, command: acceptance.command, files: acceptance.files, red: 1, outputPath: check?.outputPath ?? join(logDir, 'acceptance.log'), at: now };
  ensureBaselineTable(store);
  store.sql.prepare('INSERT INTO baselines (id, repoSlug, issue, validatorId, baseRef, baseSha, testCommit, command, files, red, outputPath, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(baseline.id, baseline.repoSlug, baseline.issue, baseline.validatorId, baseline.baseRef, baseline.baseSha, baseline.testCommit, baseline.command, JSON.stringify(baseline.files), baseline.red, baseline.outputPath, baseline.at);
  return { ok: true, ...baseline };
}
