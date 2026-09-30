import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveGatePolicy } from '../src/helm.js';
import { gateRunner } from '../src/gate.js';
import { gitWorkspace } from '../src/workspace.js';
import type { BaselineRow, WorkerMeta, WorkerRow } from '../src/types.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function fixture(): { repo: string; baseSha: string; currentSha: string } {
  const repo = mkdtempSync(join(tmpdir(), 'helm-gate-policy-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [{ name: 'current', command: 'echo current' }] }));
  git(repo, ['add', 'helm.json']);
  git(repo, ['commit', '-qm', 'base']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'README.md'), 'current base');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', 'current']);
  const currentSha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['remote', 'add', 'origin', repo]);
  git(repo, ['fetch', '-q', 'origin', 'main']);
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return { repo, baseSha, currentSha };
}

function worker(repo: string, baseRef: string, baseSha: string): WorkerRow {
  const now = new Date().toISOString();
  return { workerId: 'w-gate-policy', repo, repoSlug: 'owner/repo', role: 'builder', model: 'test/model', objective: 'gate', acceptance: null, contextPaths: [], allowWorkflows: false, baseRef, baseSha, branch: 'helm/w-gate-policy', worktree: repo, state: 'succeeded', head: baseSha, sessionFile: null, result: null, rawResultText: null, idempotencyKey: null, createdAt: now, updatedAt: now };
}

const meta = (prBase: string | null): WorkerMeta => ({ workerId: 'w-gate-policy', issue: null, prBase, baselineId: null, tier: null, score: null, chosenModel: null, policyApplied: null, skippedCandidates: [], skills: [] });
const baseline = (baseRef: string): BaselineRow => ({ id: 'b', repoSlug: 'owner/repo', issue: 1, validatorId: 'validator', baseRef, baseSha: 'baseline-sha', testCommit: 'test-commit', command: 'npm test', files: [], red: 1, outputPath: '/tmp/baseline.log', at: new Date().toISOString() });

test('gate policy resolves SHA, origin/main, and main base refs from a pinned real-git branch', async () => {
  const { repo, baseSha, currentSha } = fixture();
  const workspace = gitWorkspace();
  const runner = gateRunner({ allowUnsandboxed: true });
  try {
    const cases = [
      { row: worker(repo, baseSha, baseSha), meta: meta('main'), baseline: baseline('main') },
      { row: worker(repo, 'origin/main', baseSha), meta: meta('origin/main'), baseline: undefined },
      { row: worker(repo, 'main', baseSha), meta: undefined, baseline: undefined },
    ] as const;
    for (const testCase of cases) {
      const policy = await resolveGatePolicy({ workspace, row: testCase.row, meta: testCase.meta, baseline: testCase.baseline });
      assert.deepEqual(policy, { configRef: currentSha, baseSha: currentSha, source: 'current-base', branch: 'main', fallback: false });
      assert.deepEqual(await runner.defaultChecks(repo, policy.configRef), [{ name: 'current', command: 'echo current' }]);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gate policy uses a non-default spawn baseRef config when there is no prBase', async () => {
  const { repo, baseSha } = fixture();
  try {
    git(repo, ['checkout', '-q', '-b', 'release']);
    writeFileSync(join(repo, 'helm.json'), JSON.stringify({ gates: [{ name: 'release', command: 'echo release' }] }));
    git(repo, ['commit', '-qam', 'release config']);
    const releaseSha = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['fetch', '-q', 'origin', 'release']);
    const policy = await resolveGatePolicy({ workspace: gitWorkspace(), row: worker(repo, 'release', baseSha), meta: undefined, baseline: undefined });
    assert.deepEqual(policy, { configRef: releaseSha, baseSha: releaseSha, source: 'current-base', branch: 'release', fallback: false });
    assert.deepEqual(await gateRunner({ allowUnsandboxed: true }).defaultChecks(repo, policy.configRef), [{ name: 'release', command: 'echo release' }]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gate policy records the fallback branch when the preferred base fetch fails', async () => {
  const fetched: string[] = [];
  const workspace = {
    defaultBranch: async () => 'main',
    fetch: async (_repo: string, branch?: string) => { fetched.push(String(branch)); if (branch === 'release') throw new Error('fetch failed'); },
    resolveSha: async (_repo: string, ref: string) => `sha-of-${ref}`,
  };
  const policy = await resolveGatePolicy({ workspace, row: worker('/repo', 'release', 'spawn-sha'), meta: meta('release'), baseline: undefined });
  assert.deepEqual(fetched, ['release', 'release', 'main']);
  assert.deepEqual(policy, { configRef: 'sha-of-refs/helm/base/main', baseSha: 'sha-of-refs/helm/base/main', source: 'current-base', branch: 'main', fallback: true });
});
