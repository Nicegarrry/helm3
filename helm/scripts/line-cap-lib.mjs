import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const helmDir = dirname(scriptDir);
const sourceDir = join(helmDir, 'src');
const agentsPath = join(helmDir, '..', 'AGENTS.md');

export function parseCap(agents) {
  const match = agents.match(/under\s+(\d+(?:\.\d+)?)k lines/i);
  if (!match) throw new Error('Could not find a line cap in AGENTS.md');
  return Number(match[1]) * 1000;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function lineCount(contents) {
  return contents === '' ? 0 : contents.split(/\r?\n/).length - (contents.endsWith('\n') ? 1 : 0);
}

export async function countSourceLines() {
  const files = await sourceFiles(sourceDir);
  const counts = await Promise.all(files.map(async (path) => lineCount(await readFile(path, 'utf8'))));
  return counts.reduce((total, count) => total + count, 0);
}

export async function lineCapResult() {
  const cap = parseCap(await readFile(agentsPath, 'utf8'));
  const count = await countSourceLines();
  return { cap, count, location: relative(helmDir, sourceDir) };
}
