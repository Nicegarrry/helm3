import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const helmDir = dirname(scriptDir);
const sourceDir = join(helmDir, 'src');
const agentsPath = join(helmDir, '..', 'AGENTS.md');
const repoRoot = dirname(agentsPath);

export function parseCap(agents) {
  const match = agents.match(/Keep\s+`helm\/src`\s+under\s+([\d.]+)k lines/i);
  const cap = match ? Number(match[1]) * 1000 : NaN;
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('could not parse helm/src cap from AGENTS.md');
  return cap;
}

function resolveRef(base) {
  if (base.startsWith('origin/') || base.startsWith('refs/')) {
    return `${base}:AGENTS.md`;
  }
  return `origin/${base}:AGENTS.md`;
}

function resolveBranch(base) {
  if (base.startsWith('refs/remotes/origin/')) return base.slice('refs/remotes/origin/'.length);
  if (base.startsWith('refs/heads/')) return base.slice('refs/heads/'.length);
  if (base.startsWith('origin/')) return base.slice('origin/'.length);
  return base;
}

export async function loadAgents(options = {}) {
  const base = options.base || process.env.GITHUB_BASE_REF || process.env.BASE_REF || 'main';
  const root = options.cwd ?? dirname(options.agentsPath ?? agentsPath);
  const ref = options.ref ?? resolveRef(base);
  const exec = options.exec ?? execFileAsync;
  const timeout = options.timeout ?? 5000;

  try {
    const { stdout } = await exec('git', ['show', ref], { cwd: root, timeout });
    if (stdout.trim().length > 0) return stdout;
  } catch {
    const branch = resolveBranch(base);
    try {
      await exec('git', ['fetch', 'origin', `+${branch}:refs/remotes/origin/${branch}`], { cwd: root, timeout });
      const { stdout } = await exec('git', ['show', ref], { cwd: root, timeout });
      if (stdout.trim().length > 0) return stdout;
    } catch {
      // remote base unavailable; fall back to local file
    }
  }

  return await readFile(options.agentsPath ?? agentsPath, 'utf8');
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

export async function countSourceLines(directory = sourceDir) {
  const files = await sourceFiles(directory);
  const counts = await Promise.all(files.map(async (path) => lineCount(await readFile(path, 'utf8'))));
  return counts.reduce((total, count) => total + count, 0);
}

export async function lineCapResult(options = {}) {
  const cap = parseCap(await loadAgents(options));
  const targetSourceDir = options.sourceDir ?? sourceDir;
  const targetHelmDir = options.helmDir ?? helmDir;
  const count = await countSourceLines(targetSourceDir);
  return { cap, count, location: relative(targetHelmDir, targetSourceDir) };
}
