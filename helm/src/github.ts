/** `gh` CLI transport: pr create, status, comment, merge. See DESIGN.md. */
import { execFile } from 'node:child_process';
import type { GitHub, PrStatus } from './types.js';

export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd?: string; input?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultExecFn: ExecFn = (file, args, opts) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error === null) { resolve({ stdout, stderr, code: 0 }); return; }
    const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
    // A spawn failure (e.g. `gh` not found) carries a string code; a process exit carries a number.
    if (typeof code !== 'number') { reject(error); return; }
    resolve({ stdout, stderr, code });
  });
  child.stdin?.end(opts.input ?? '');
});

async function run(exec: ExecFn, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<string> {
  const result = await exec('gh', args, opts);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `gh ${args[0] ?? ''} failed with exit code ${result.code}`);
  return result.stdout;
}

type PrViewJson = {
  number: number;
  url: string;
  state: string;
  headRefOid: string;
  mergeable: string | null;
  isDraft?: boolean;
  mergedAt?: string | null;
  statusCheckRollup?: { name?: string; status?: string; conclusion?: string | null; state?: string; context?: string }[] | null;
  reviews?: { author?: { login?: string }; state?: string }[] | null;
};

const PENDING_CONTEXT_STATES: ReadonlySet<string> = new Set(['PENDING', 'EXPECTED']);

/**
 * `gh` reports a check run with upper-case `status`/`conclusion` (`COMPLETED`, `SUCCESS`) and a
 * commit-status context (Vercel and friends) with only `state`. Both come out lower-case, with
 * `status: 'completed'` only once the check has actually finished and `conclusion` null until
 * then, so the merge guard can tell "still running" from "failed" and never compares cases.
 */
function mapCheck(check: NonNullable<PrViewJson['statusCheckRollup']>[number]): PrStatus['checks'][number] {
  const name = check.name ?? check.context ?? 'unknown';
  if (check.status) {
    const status = check.status.toLowerCase();
    const conclusion = status === 'completed' && check.conclusion ? check.conclusion.toLowerCase() : null;
    return { name, status, conclusion };
  }
  if (!check.state) return { name, status: 'unknown', conclusion: null };
  const contextState = check.state.toUpperCase();
  if (PENDING_CONTEXT_STATES.has(contextState)) return { name, status: 'pending', conclusion: null };
  return { name, status: 'completed', conclusion: contextState === 'SUCCESS' ? 'success' : 'failure' };
}

function mapPrStatus(json: PrViewJson): PrStatus {
  const state: PrStatus['state'] = json.mergedAt ? 'merged' : json.state.toLowerCase() === 'closed' ? 'closed' : 'open';
  const checks = (json.statusCheckRollup ?? []).map(mapCheck);
  const reviews = (json.reviews ?? []).map((review) => ({
    author: review.author?.login ?? 'unknown',
    state: review.state ?? 'unknown',
  }));
  return {
    number: json.number,
    state,
    head: json.headRefOid,
    mergeable: json.mergeable === 'MERGEABLE' ? true : json.mergeable === 'CONFLICTING' ? false : null,
    draft: json.isDraft === true,
    checks,
    reviews,
    url: json.url,
  };
}

export function ghGitHub(exec: ExecFn = defaultExecFn): GitHub {
  return {
    async openPr(input): Promise<{ number: number; url: string }> {
      const args = ['pr', 'create', '--base', input.base, '--head', input.head, '--title', input.title, '--body', input.body];
      if (input.draft) args.push('--draft');
      const stdout = await run(exec, args, { cwd: input.cwd });
      const url = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
      const viewOut = await run(exec, ['pr', 'view', url, '--json', 'number,url'], { cwd: input.cwd });
      const parsed = JSON.parse(viewOut) as { number: number; url: string };
      return { number: parsed.number, url: parsed.url };
    },

    async prStatus(repoSlug: string, number: number): Promise<PrStatus> {
      const stdout = await run(exec, [
        'pr', 'view', String(number),
        '--repo', repoSlug,
        '--json', 'number,state,headRefOid,mergeable,isDraft,statusCheckRollup,reviews,url,mergedAt',
      ]);
      const parsed = JSON.parse(stdout) as PrViewJson;
      return mapPrStatus(parsed);
    },

    async comment(repoSlug: string, number: number, body: string): Promise<void> {
      await run(exec, ['pr', 'comment', String(number), '--repo', repoSlug, '--body-file', '-'], { input: body });
    },

    async merge(repoSlug: string, number: number, expectedHead: string): Promise<void> {
      await run(exec, [
        'api', '-X', 'PUT', `repos/${repoSlug}/pulls/${number}/merge`,
        '-f', `sha=${expectedHead}`,
        '-f', 'merge_method=squash',
      ]);
    },
  };
}
