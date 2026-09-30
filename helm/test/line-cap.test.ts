import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
// @ts-expect-error line-cap.mjs is tested directly and has no declaration file.
import { parseCap } from '../scripts/line-cap-lib.mjs';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));

test('parseCap reads the decimal k cap from AGENTS.md', () => {
  assert.equal(parseCap('Keep `helm/src` under 11.0k lines.'), 11_000);
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
    writeFileSync(join(root, 'AGENTS.md'), 'Keep `helm/src` under 0.0k lines.');
    writeFileSync(join(helmDir, 'src', 'over-cap.ts'), 'export const overCap = true;\n');
    const symlink = join(scriptDir, 'line-cap-link.mjs');
    symlinkSync('line-cap.mjs', symlink);

    for (const entry of [join(scriptDir, 'line-cap.mjs'), symlink]) {
      const result = spawnSync(process.execPath, [entry], { encoding: 'utf8' });
      assert.equal(result.status, 1, `${entry}: ${result.stderr}`);
      assert.match(result.stdout, /1 lines in src \(cap 0\)/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
