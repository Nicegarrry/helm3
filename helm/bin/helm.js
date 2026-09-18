#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ['--import', 'tsx', join(here, '..', 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit', cwd: join(here, '..') });
child.on('exit', (code) => process.exit(code ?? 1));
