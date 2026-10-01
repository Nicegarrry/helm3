import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
// @ts-expect-error line-cap.mjs is tested directly and has no declaration file.
import { loadAgents, lineCapResult, parseCap } from '../scripts/line-cap-lib.mjs';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));

test('parseCap reads only the helm/src decimal k cap from AGENTS.md', () => {
  assert.equal(parseCap('Keep `helm/src` under 11.0k lines.'), 11_000);
  assert.equal(parseCap('Keep other code under 3.0k lines.\nKeep `helm/src` under 11.0k lines.'), 11_000);
  assert.throws(() => parseCap('Keep other code under 3.0k lines.'), /could not parse helm\/src cap from AGENTS\.md/);
  assert.throws(() => parseCap('Keep `helm/src` under 1..0k lines.'), /could not parse helm\/src cap from AGENTS\.md/);
});

test('loadAgents reads from git show origin/<base>:AGENTS.md when available', async () => {
  const calls: Array<{ file: string; args: string[]; options?: unknown }> = [];
  const fakeExec = async (file: string, args: string[], options: unknown) => {
    calls.push({ file, args, options });
    return { stdout: 'Keep `helm/src` under 15.0k lines.\n' };
  };

  const content = await loadAgents({ exec: fakeExec, cwd: '/repo' });
  assert.equal(content, 'Keep `helm/src` under 15.0k lines.\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, 'git');
  assert.deepEqual(calls[0]?.args, ['show', 'origin/main:AGENTS.md']);
});

test('loadAgents respects explicit base, GITHUB_BASE_REF, and BASE_REF', async () => {
  const calls: string[] = [];
  const fakeExec = async (_file: string, args: readonly string[]) => {
    calls.push(args[1] ?? '');
    return { stdout: 'Keep `helm/src` under 15.0k lines.\n' };
  };

  // Explicit base option
  await loadAgents({ exec: fakeExec, base: 'develop' });
  assert.equal(calls[calls.length - 1], 'origin/develop:AGENTS.md');

  // Explicit base starting with origin/
  await loadAgents({ exec: fakeExec, base: 'origin/release-2' });
  assert.equal(calls[calls.length - 1], 'origin/release-2:AGENTS.md');

  // GITHUB_BASE_REF environment variable
  const origGithubBase = process.env.GITHUB_BASE_REF;
  try {
    process.env.GITHUB_BASE_REF = 'pr-target';
    await loadAgents({ exec: fakeExec });
    assert.equal(calls[calls.length - 1], 'origin/pr-target:AGENTS.md');
  } finally {
    if (origGithubBase === undefined) delete process.env.GITHUB_BASE_REF;
    else process.env.GITHUB_BASE_REF = origGithubBase;
  }

  // BASE_REF environment variable
  const origBaseRef = process.env.BASE_REF;
  try {
    delete process.env.GITHUB_BASE_REF;
    process.env.BASE_REF = 'base-branch';
    await loadAgents({ exec: fakeExec });
    assert.equal(calls[calls.length - 1], 'origin/base-branch:AGENTS.md');
  } finally {
    if (origBaseRef === undefined) delete process.env.BASE_REF;
    else process.env.BASE_REF = origBaseRef;
  }
});

test('loadAgents retries git show after git fetch if show initially fails', async () => {
  const steps: string[] = [];
  const fakeExec = async (_file: string, args: readonly string[]) => {
    steps.push(args[0] ?? '');
    if (args[0] === 'show' && steps.length === 1) {
      throw new Error('fatal: invalid object name');
    }
    if (args[0] === 'fetch') {
      return { stdout: '' };
    }
    return { stdout: 'Keep `helm/src` under 15.0k lines.\n' };
  };

  const content = await loadAgents({ exec: fakeExec, base: 'main' });
  assert.equal(content, 'Keep `helm/src` under 15.0k lines.\n');
  assert.deepEqual(steps, ['show', 'fetch', 'show']);
});

test('loadAgents falls back to local file when git show and fetch fail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm load-agents-fallback-'));
  const localPath = join(root, 'AGENTS.md');
  try {
    writeFileSync(localPath, 'Keep `helm/src` under 11.0k lines.\n');
    const failingExec = async () => { throw new Error('git not found'); };
    const content = await loadAgents({ exec: failingExec, agentsPath: localPath, cwd: root });
    assert.equal(content, 'Keep `helm/src` under 11.0k lines.\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI enforces the cap through symlink and space-containing paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm line-cap-'));
  const helmDir = join(root, 'helm');
  const scriptDir = join(helmDir, 'scripts');
  try {
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(join(helmDir, 'src'), { recursive: true });
    copyFileSync(join(scripts, 'line-cap.mjs'), join(scriptDir, 'line-cap.mjs'));
    copyFileSync(join(scripts, 'line-cap-lib.mjs'), join(scriptDir, 'line-cap-lib.mjs'));
    writeFileSync(join(root, 'AGENTS.md'), 'Keep `helm/src` under 0.0001k lines.');
    writeFileSync(join(helmDir, 'src', 'over-cap.ts'), 'export const overCap = true;\n');
    const symlink = join(scriptDir, 'line-cap-link.mjs');
    symlinkSync('line-cap.mjs', symlink);

    for (const entry of [join(scriptDir, 'line-cap.mjs'), symlink]) {
      const result = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
      assert.equal(result.status, 1, `${entry}: ${result.stderr}`);
      assert.match(result.stdout, /1 lines in src \(cap 0\.1\)/);
    }

    writeFileSync(join(root, 'AGENTS.md'), 'Keep `helm/src` under 1..0k lines.');
    const malformed = spawnSync(process.execPath, [join(scriptDir, 'line-cap.mjs')], { encoding: 'utf8' });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /could not parse helm\/src cap from AGENTS\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('in a git repo, line-cap reads cap from origin/<base> and falls back to local file', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm line-cap-git-'));
  const helmDir = join(root, 'helm');
  const scriptDir = join(helmDir, 'scripts');
  const srcDir = join(helmDir, 'src');

  try {
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    copyFileSync(join(scripts, 'line-cap.mjs'), join(scriptDir, 'line-cap.mjs'));
    copyFileSync(join(scripts, 'line-cap-lib.mjs'), join(scriptDir, 'line-cap-lib.mjs'));

    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });

    // Initialize git repo
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@test.local']);

    // On base branch (main): cap is 0.015k (15 lines)
    writeFileSync(join(root, 'AGENTS.md'), 'Keep `helm/src` under 0.015k lines.\n');
    // Write 12 lines in src: over 11 lines, but under 15 lines
    writeFileSync(join(srcDir, 'code.ts'), Array.from({ length: 12 }, (_, i) => `export const x${i} = ${i};\n`).join(''));
    git(['add', '.']);
    git(['commit', '-m', 'Initial commit on main']);

    // Set origin/main remote ref to point to main commit
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    // Switch to a PR branch where AGENTS.md has the older 11-line cap (0.011k lines)
    git(['checkout', '-b', 'pr-branch']);
    writeFileSync(join(root, 'AGENTS.md'), 'Keep `helm/src` under 0.011k lines.\n');
    git(['add', 'AGENTS.md']);
    git(['commit', '-m', 'PR branch with 11-line cap']);

    // 1. By default in PR branch, line-cap reads origin/main (cap 15) and passes (12 lines <= 15 cap)
    const defaultRun = spawnSync(process.execPath, [join(scriptDir, 'line-cap.mjs')], { cwd: helmDir, encoding: 'utf8' });
    assert.equal(defaultRun.status, 0, `stderr: ${defaultRun.stderr}`);
    assert.match(defaultRun.stdout, /12 lines in src \(cap 15\)/);

    // 2. With GITHUB_BASE_REF=main, line-cap reads origin/main and passes
    const githubBaseRun = spawnSync(process.execPath, [join(scriptDir, 'line-cap.mjs')], {
      cwd: helmDir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: 'main' },
    });
    assert.equal(githubBaseRun.status, 0, `stderr: ${githubBaseRun.stderr}`);
    assert.match(githubBaseRun.stdout, /12 lines in src \(cap 15\)/);

    // 3. With explicit --base main, line-cap reads origin/main and passes
    const explicitBaseRun = spawnSync(process.execPath, [join(scriptDir, 'line-cap.mjs'), '--base', 'main'], { cwd: helmDir, encoding: 'utf8' });
    assert.equal(explicitBaseRun.status, 0, `stderr: ${explicitBaseRun.stderr}`);
    assert.match(explicitBaseRun.stdout, /12 lines in src \(cap 15\)/);

    // 4. When base is missing (e.g. --base nonexistent), falls back to local AGENTS.md (cap 11) and fails (12 > 11)
    const fallbackRun = spawnSync(process.execPath, [join(scriptDir, 'line-cap.mjs'), '--base', 'nonexistent'], { cwd: helmDir, encoding: 'utf8' });
    assert.equal(fallbackRun.status, 1);
    assert.match(fallbackRun.stdout, /12 lines in src \(cap 11\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
