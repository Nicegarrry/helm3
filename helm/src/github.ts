/** `gh` CLI transport: pr create, status, comment, merge. See DESIGN.md. */
import { execFile } from 'node:child_process';
import type { GitHub, GitHubComment, GitHubIssue, PrStatus, WorkerPr } from './types.js';

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
  title?: string;
  baseRefName?: string;
  body?: string;
};

const PENDING_CONTEXT_STATES: ReadonlySet<string> = new Set(['PENDING', 'EXPECTED']);

/** `gh` reports a check run with upper-case `status`/`conclusion` (`COMPLETED`, `SUCCESS`) and a commit-status context (Vercel and friends) with only `state`. */
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
    ...(json.title ? { title: json.title } : {}),
    ...(json.baseRefName ? { base: json.baseRefName } : {}),
    ...(json.body !== undefined ? { body: json.body } : {}),
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

    async findPr(repoSlug: string, head: string): Promise<{ number: number; url: string } | undefined> {
      const stdout = await run(exec, ['pr', 'list', '--repo', repoSlug, '--head', head, '--state', 'open', '--json', 'number,url', '--limit', '1']);
      const parsed = JSON.parse(stdout) as Array<{ number: number; url: string }>;
      return parsed[0];
    },

    async listWorkerPrs(repoSlug: string, mergedSince: string): Promise<WorkerPr[]> {
      const fields = 'headRefName,number,state,mergedAt,body,headRefOid';
      const result: WorkerPr[] = [];
      for (const state of ['open', 'merged']) {
        const args = ['pr', 'list', '--repo', repoSlug, '--state', state, '--limit', '1000', '--json', fields];
        if (state === 'merged') args.push('--search', `merged:>=${mergedSince}`);
        const rows = JSON.parse(await run(exec, args)) as WorkerPr[];
        result.push(...rows.filter((pr) => /^helm\/w-[\w-]+$/.test(pr.headRefName) && (pr.state === 'OPEN' || pr.state === 'MERGED')));
      }
      return result;
    },

    async updatePr(repoSlug: string, number: number, input: { title?: string; body?: string }): Promise<void> {
      const args = ['pr', 'edit', String(number), '--repo', repoSlug];
      if (input.title !== undefined) args.push('--title', input.title);
      if (input.body !== undefined) args.push('--body', input.body);
      if (args.length > 4) await run(exec, args);
    },

    async issueTitle(repoSlug: string, number: number): Promise<string | undefined> {
      const stdout = await run(exec, ['issue', 'view', String(number), '--repo', repoSlug, '--json', 'title']);
      const parsed = JSON.parse(stdout) as { title?: unknown };
      return typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : undefined;
    },

    async issue(repoSlug: string, number: number): Promise<GitHubIssue | undefined> {
      const stdout = await run(exec, ['issue', 'view', String(number), '--repo', repoSlug, '--json', 'title,body,comments']);
      const parsed = JSON.parse(stdout) as { title?: unknown; body?: unknown; comments?: Array<{ author?: { login?: unknown }; body?: unknown }> };
      const comments = Array.isArray(parsed.comments) ? parsed.comments
        .filter((c) => typeof c?.body === 'string' && c.body.trim())
        .map((c) => ({ ...(typeof c.author?.login === 'string' && c.author.login ? { author: c.author.login } : {}), body: (c.body as string).trim() })) : [];
      return {
        title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : undefined,
        body: typeof parsed.body === 'string' && parsed.body.trim() ? parsed.body.trim() : undefined,
        comments,
      };
    },

    async prStatus(repoSlug: string, number: number): Promise<PrStatus> {
      const stdout = await run(exec, [
        'pr', 'view', String(number),
        '--repo', repoSlug,
        '--json', 'number,state,headRefOid,mergeable,isDraft,statusCheckRollup,reviews,url,mergedAt,title,baseRefName,body',
      ]);
      const parsed = JSON.parse(stdout) as PrViewJson;
      return mapPrStatus(parsed);
    },

    async comment(repoSlug: string, id: number): Promise<GitHubComment> {
      const stdout = await run(exec, ['api', `repos/${repoSlug}/issues/comments/${id}`]);
      const parsed = JSON.parse(stdout) as { body?: unknown; issue_url?: unknown; pull_request_url?: unknown };
      if (typeof parsed.body !== 'string') throw new Error('GitHub comment has no body');
      const issueUrl = typeof parsed.issue_url === 'string' ? parsed.issue_url : undefined;
      const pullRequestUrl = typeof parsed.pull_request_url === 'string' ? parsed.pull_request_url : undefined;
      const issueNumber = issueUrl ? Number(issueUrl.match(/\/issues\/(\d+)(?:$|\/)/)?.[1]) : NaN;
      return { body: parsed.body, issueUrl, pullRequestUrl, ...(Number.isInteger(issueNumber) ? { issueNumber } : {}) };
    },

    async postComment(repoSlug: string, number: number, body: string): Promise<string> {
      return (await run(exec, ['pr', 'comment', String(number), '--repo', repoSlug, '--body-file', '-'], { input: body })).trim();
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
