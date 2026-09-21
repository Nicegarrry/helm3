#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[2] === 'update') {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [join(here, 'update.mjs'), ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const child = spawn(process.execPath, ['--import', 'tsx', join(here, '..', 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit', cwd: join(here, '..') });
child.on('exit', (code) => process.exit(code ?? 1));
