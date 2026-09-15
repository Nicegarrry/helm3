import { spawn } from 'node:child_process';

export type TrackerCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
}>;

export type TrackerCommandTransport = (
  argv: readonly string[],
  limits: Readonly<{ timeoutMs: number; outputByteLimit: number }>,
) => Promise<TrackerCommandResult>;

export type MapIssueState = 'OPEN' | 'CLOSED';
export type MapBlocker = Readonly<{ repository: string; number: number; state: MapIssueState; title: string; url: string }>;
export type GitHubMapNode = Readonly<{
  number: number;
  title: string;
  state: MapIssueState;
  url: string;
  updatedAt: string;
  parentIssue: number | null;
  subIssues: readonly number[];
  blockedBy: readonly MapBlocker[];
}>;
export type MapFrontierNode = Readonly<{ number: number; title: string; url: string; blockers: readonly Readonly<{ repository: string; number: number }>[] }>;
export type MapIncompleteReason = Readonly<{ code: 'transport_failed' | 'output_bound' | 'page_limit' | 'node_limit' | 'request_limit' | 'invalid_response' | 'cycle'; subject: string }>;
export type GitHubMapSnapshot = Readonly<{
  source: Readonly<{ repository: string; parentIssue: number }>;
  observedAt: string;
  completeness: 'complete' | 'incomplete';
  nodes: readonly GitHubMapNode[];
  frontier: readonly MapFrontierNode[];
  incomplete: readonly MapIncompleteReason[];
}>;

export type GitHubMapTrackerOptions = Readonly<{
  repo: string;
  parentIssue: number;
  transport?: TrackerCommandTransport;
  now?: () => string;
  pageLimit?: number;
  nodeLimit?: number;
  requestLimit?: number;
  timeoutMs?: number;
  outputByteLimit?: number;
}>;

type RemoteIssue = Readonly<{ repository: string; number: number; title: string; state: MapIssueState; url: string; updatedAt: string }>;
type MutableNode = { issue: RemoteIssue; parentIssue: number | null; subIssues: number[]; blockedBy: MapBlocker[] };

const apiHeaders = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'] as const;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  const parsed = positiveInteger(value, name);
  if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return parsed;
}
function string(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function issueState(value: unknown): MapIssueState | null {
  if (typeof value !== 'string') return null;
  if (value.toUpperCase() === 'OPEN') return 'OPEN';
  if (value.toUpperCase() === 'CLOSED') return 'CLOSED';
  return null;
}
function repositoryFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com') return null;
    const match = url.pathname.match(/^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch { return null; }
}
function issueFrom(value: unknown): RemoteIssue | null {
  const row = record(value);
  if (!row || !Number.isSafeInteger(row.number) || (row.number as number) < 1) return null;
  const repository = repositoryFrom(row.repository_url), title = string(row.title), state = issueState(row.state), url = string(row.html_url), updatedAt = string(row.updated_at) ?? string(row.updatedAt);
  if (repository === null || title === null || state === null || url === null || updatedAt === null || Number.isNaN(Date.parse(updatedAt))) return null;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com' || parsedUrl.pathname !== `/${repository}/issues/${row.number}` || parsedUrl.search || parsedUrl.hash) return null;
  } catch { return null; }
  return { repository, number: row.number as number, title, state, url, updatedAt };
}
function blockerFrom(value: unknown): MapBlocker | null {
  const issue = issueFrom(value);
  return issue === null ? null : { repository: issue.repository, number: issue.number, state: issue.state, title: issue.title, url: issue.url };
}

/** Bounded argv-only subprocess transport. It never invokes a shell or provider executable. */
export const ghCommandTransport: TrackerCommandTransport = (argv, limits) => new Promise((resolve) => {
  let settled = false;
  let stdout = '', stderr = '';
  let outputTruncated = false;
  let timedOut = false;
  let terminating = false;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  const child = spawn('gh', [...argv], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const finish = (result: TrackerCommandResult) => {
    if (settled) return;
    settled = true; clearTimeout(timer); if (terminationTimer) clearTimeout(terminationTimer);
    child.stdout.destroy(); child.stderr.destroy(); child.unref(); resolve(result);
  };
  const terminate = (wasTimedOut: boolean) => {
    if (settled || terminating) return;
    terminating = true;
    if (wasTimedOut) timedOut = true;
    child.kill('SIGTERM');
    terminationTimer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      finish({ ok: false, stdout, stderr, timedOut: timedOut || undefined, outputTruncated: outputTruncated || undefined });
    }, 100);
  };
  const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (settled || terminating) return;
    const current = stream === 'stdout' ? stdout : stderr;
    const remaining = limits.outputByteLimit - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
    if (remaining <= 0) { outputTruncated = true; terminate(false); return; }
    const clipped = chunk.subarray(0, remaining).toString('utf8');
    if (stream === 'stdout') stdout = current + clipped; else stderr = current + clipped;
    if (chunk.byteLength > remaining) { outputTruncated = true; terminate(false); }
  };
  const timer = setTimeout(() => terminate(true), limits.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
  child.on('error', () => finish({ ok: false, stdout, stderr }));
  child.on('close', (code) => finish({ ok: code === 0 && !outputTruncated && !timedOut, stdout, stderr, timedOut: timedOut || undefined, outputTruncated: outputTruncated || undefined }));
});

/** Read-only native GitHub issue hierarchy observer. Membership comes from sub_issues, never labels. */
export class GitHubMapTracker {
  readonly #repo: string;
  readonly #parentIssue: number;
  readonly #transport: TrackerCommandTransport;
  readonly #now: () => string;
  readonly #pageLimit: number;
  readonly #nodeLimit: number;
  readonly #requestLimit: number;
  readonly #limits: Readonly<{ timeoutMs: number; outputByteLimit: number }>;

  constructor(options: GitHubMapTrackerOptions) {
    if (!repoPattern.test(options.repo)) throw new Error('repo must be an OWNER/REPO identifier');
    this.#repo = options.repo;
    this.#parentIssue = positiveInteger(options.parentIssue, 'parentIssue');
    this.#transport = options.transport ?? ghCommandTransport;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#pageLimit = boundedPositiveInteger(options.pageLimit ?? 20, 'pageLimit', 50);
    this.#nodeLimit = boundedPositiveInteger(options.nodeLimit ?? 500, 'nodeLimit', 1_000);
    this.#requestLimit = boundedPositiveInteger(options.requestLimit ?? 2_500, 'requestLimit', 10_000);
    this.#limits = Object.freeze({ timeoutMs: boundedPositiveInteger(options.timeoutMs ?? 10_000, 'timeoutMs', 60_000), outputByteLimit: boundedPositiveInteger(options.outputByteLimit ?? 1_000_000, 'outputByteLimit', 4_000_000) });
  }

  async snapshot(): Promise<GitHubMapSnapshot> {
    const reasons: MapIncompleteReason[] = [];
    const nodes = new Map<number, MutableNode>();
    const collecting = new Set<number>();
    let requests = 0;
    const incomplete = (code: MapIncompleteReason['code'], subject: string): void => {
      if (!reasons.some((reason) => reason.code === code && reason.subject === subject)) reasons.push({ code, subject });
    };
    const read = async (path: string): Promise<unknown | null> => {
      if (requests >= this.#requestLimit) { incomplete('request_limit', this.#repo); return null; }
      requests += 1;
      const result = await this.#transport(['api', '-X', 'GET', path, ...apiHeaders], this.#limits);
      if (!result.ok) { incomplete(result.outputTruncated ? 'output_bound' : 'transport_failed', path); return null; }
      try { return JSON.parse(result.stdout); } catch { incomplete('invalid_response', path); return null; }
    };
    const readIssue = async (repository: string, number: number): Promise<RemoteIssue | null> => {
      const body = await read(`repos/${repository}/issues/${number}`);
      const parsed = body === null ? null : issueFrom(body);
      if (parsed === null || parsed.repository !== repository || parsed.number !== number) {
        if (body !== null) incomplete('invalid_response', `issue:${repository}#${number}`);
        return null;
      }
      return parsed;
    };
    const readPages = async <T>(path: string, parse: (value: unknown) => T | null): Promise<T[] | null> => {
      const values: T[] = [];
      for (let page = 1; page <= this.#pageLimit; page += 1) {
        const separator = path.includes('?') ? '&' : '?';
        const body = await read(`${path}${separator}per_page=100&page=${page}`);
        if (body === null) return null;
        if (!Array.isArray(body)) { incomplete('invalid_response', `${path}:page:${page}`); return null; }
        for (const entry of body) {
          const parsed = parse(entry);
          if (parsed === null) { incomplete('invalid_response', `${path}:page:${page}`); return null; }
          values.push(parsed);
        }
        if (body.length < 100) return values;
      }
      incomplete('page_limit', path);
      return null;
    };
    const collect = async (number: number, parentIssue: number | null): Promise<void> => {
      if (collecting.has(number)) { incomplete('cycle', `issue:${number}`); return; }
      const existing = nodes.get(number);
      if (existing) {
        if (existing.parentIssue !== parentIssue) incomplete('cycle', `issue:${number}`);
        return;
      }
      if (nodes.size >= this.#nodeLimit) { incomplete('node_limit', this.#repo); return; }
      collecting.add(number);
      const issue = await readIssue(this.#repo, number);
      if (issue !== null) {
        const node: MutableNode = { issue, parentIssue, subIssues: [], blockedBy: [] };
        nodes.set(number, node);
        const blockers = await readPages(`repos/${this.#repo}/issues/${number}/dependencies/blocked_by`, blockerFrom);
        if (blockers !== null) {
          for (const listed of blockers) {
            const blocker = await readIssue(listed.repository, listed.number);
            if (blocker !== null) node.blockedBy.push({ repository: blocker.repository, number: blocker.number, state: blocker.state, title: blocker.title, url: blocker.url });
          }
        }
        const children = await readPages(`repos/${this.#repo}/issues/${number}/sub_issues`, (entry) => {
          const child = issueFrom(entry);
          return child?.repository === this.#repo ? child.number : null;
        });
        if (children !== null) {
          node.subIssues.push(...children);
          for (const child of children) await collect(child, number);
        }
      }
      collecting.delete(number);
    };
    await collect(this.#parentIssue, null);
    const complete = reasons.length === 0 && nodes.has(this.#parentIssue);
    const frozenNodes = [...nodes.values()].map((node): GitHubMapNode => Object.freeze({
      number: node.issue.number, title: node.issue.title, state: node.issue.state, url: node.issue.url, updatedAt: node.issue.updatedAt,
      parentIssue: node.parentIssue, subIssues: Object.freeze([...new Set(node.subIssues)].sort((a, b) => a - b)),
      blockedBy: Object.freeze([...node.blockedBy].sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number)),
    })).sort((a, b) => a.number - b.number);
    const frontier = !complete ? [] : frozenNodes.filter((node) => node.number !== this.#parentIssue && node.state === 'OPEN' && node.blockedBy.every((blocker) => blocker.state === 'CLOSED')).map((node): MapFrontierNode => Object.freeze({ number: node.number, title: node.title, url: node.url, blockers: Object.freeze(node.blockedBy.map((blocker) => Object.freeze({ repository: blocker.repository, number: blocker.number }))) }));
    return Object.freeze({
      source: Object.freeze({ repository: this.#repo, parentIssue: this.#parentIssue }), observedAt: this.#now(), completeness: complete ? 'complete' : 'incomplete',
      nodes: Object.freeze(frozenNodes), frontier: Object.freeze(frontier), incomplete: Object.freeze(reasons),
    });
  }
}
