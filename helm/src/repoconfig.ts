/** Versioned repository configuration used by gates and later delivery waves. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { hardenedGitArgs } from './git.js';

const exec = promisify(execFile);
type ConfigExec = (file: string, args: readonly string[], options: { cwd?: string; timeout?: number }) => Promise<{ stdout: string }>;

export const repoConfigSchema = z.object({
  gates: z.array(z.object({ name: z.string().min(1), command: z.string().min(1) })).default([]),
  gate: z.object({ sandbox: z.boolean().default(true) }).optional(),
  workerInstall: z.boolean().optional(),
  acceptance: z.object({ testGlobs: z.array(z.string().min(1)), command: z.string().min(1).optional() }).optional(),
  deploy: z.object({ targets: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(['vercel', 'convex', 'testflight']),
    env: z.union([z.string().min(1), z.record(z.string(), z.string().min(1))]),
    mode: z.enum(['cli', 'git']).optional(),
    platform: z.string().min(1).optional(),
    lane: z.string().min(1).optional(),
    external: z.boolean().optional(),
    timeoutMin: z.number().positive().optional(),
    smoke: z.object({
      commands: z.array(z.object({ name: z.string().min(1), command: z.string().min(1) })).optional(),
      http: z.array(z.object({
        path: z.string().min(1).refine((path) => path.startsWith('/') && !path.includes('//') && !path.includes('..') && !path.includes('\\') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path), { message: 'HTTP smoke path must be a relative path starting with /' }),
        status: z.number().int(), contains: z.string().optional(),
      })).optional(),
    }),
    migrationGlobs: z.array(z.string().min(1)).optional(),
    rollback: z.enum(['auto', 'manual', 'none']),
  }).strict()) }).optional(),
}).strict();

export type RepoConfig = z.infer<typeof repoConfigSchema>;

export async function loadRepoConfig(repo: string, sha?: string, fallbackToWorktree = true, options: { timeout?: number; exec?: ConfigExec } = {}): Promise<RepoConfig> {
  let raw: string;
  if (sha) {
    try {
      ({ stdout: raw } = await (options.exec ?? exec)('git', hardenedGitArgs(['show', `${sha}:helm.json`]), { cwd: repo, timeout: options.timeout }));
    } catch {
      if (!fallbackToWorktree) throw new Error(`helm.json not found at ${sha}`);
      raw = await readFile(join(repo, 'helm.json'), 'utf8');
    }
  } else {
    raw = await readFile(join(repo, 'helm.json'), 'utf8');
  }
  return repoConfigSchema.parse(JSON.parse(raw));
}
