/** Versioned repository configuration used by gates and later delivery waves. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);

export const repoConfigSchema = z.object({
  gates: z.array(z.object({ name: z.string().min(1), command: z.string().min(1) })).default([]),
  acceptance: z.object({ testGlobs: z.array(z.string().min(1)), command: z.string().min(1).optional() }).optional(),
  deploy: z.object({ targets: z.array(z.string().min(1)) }).optional(),
}).strict();

export type RepoConfig = z.infer<typeof repoConfigSchema>;

export async function loadRepoConfig(repo: string, sha?: string): Promise<RepoConfig> {
  let raw: string;
  if (sha) {
    try {
      ({ stdout: raw } = await exec('git', ['show', `${sha}:helm.json`], { cwd: repo }));
    } catch {
      raw = await readFile(join(repo, 'helm.json'), 'utf8');
    }
  } else {
    raw = await readFile(join(repo, 'helm.json'), 'utf8');
  }
  return repoConfigSchema.parse(JSON.parse(raw));
}
