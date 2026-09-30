#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[2] === 'update') {
  const result = spawnSync(process.execPath, [join(here, 'update.mjs'), ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (process.argv[2] === 'fleet') {
  const result = spawnSync(process.execPath, [join(here, 'fleet.mjs'), ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const args = process.argv.slice(2);
if (['init', 'doctor'].includes(args[0])) {
  let hasRepo = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--repo') {
      hasRepo = true;
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
        i += 1;
        args[i] = resolve(process.cwd(), args[i]);
      }
    } else if (args[i].startsWith('--repo=')) {
      hasRepo = true;
      args[i] = `--repo=${resolve(process.cwd(), args[i].slice('--repo='.length))}`;
    }
  }
  if (!hasRepo) args.splice(1, 0, '--repo', process.cwd());
}
const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(here, '..', 'src', 'cli.ts'), ...args], {
  stdio: 'inherit', cwd: join(here, '..'), env: { ...process.env, TSX_TSCONFIG_PATH: join(here, '..', 'tsconfig.json') },
});
child.on('exit', (code) => process.exit(code ?? 1));
