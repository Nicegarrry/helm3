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
export type MapBlocker = Readonly<{ number: number; state: MapIssueState; title: string; url: string }>;
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
export type MapFrontierNode = Readonly<{ number: number; title: string; url: string; blockers: readonly number[] }>;
export type MapIncompleteReason = Readonly<{ code: 'transport_failed' | 'output_bound' | 'page_limit' | 'invalid_response' | 'cycle'; subject: string }>;
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
  timeoutMs?: number;
  outputByteLimit?: number;
}>;

type RemoteIssue = Readonly<{ number: number; title: string; state: MapIssueState; url: string; updatedAt: string }>;
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
  if (value === 'OPEN' || value === 'CLOSED') return value;
  return null;
}
function issueFrom(value: unknown): RemoteIssue | null {
  const row = record(value);
  if (!row || !Number.isSafeInteger(row.number) || (row.number as number) < 1) return null;
  const title = string(row.title), state = issueState(row.state), url = string(row.html_url) ?? string(row.url), updatedAt = string(row.updated_at) ?? string(row.updatedAt);
  if (title === null || state === null || url === null || updatedAt === null || Number.isNaN(Date.parse(updatedAt))) return null;
  return { number: row.number as number, title, state, url, updatedAt };
}
function blockerFrom(value: unknown): MapBlocker | null {
  const issue = issueFrom(value);
  return issue === null ? null : { number: issue.number, state: issue.state, title: issue.title, url: issue.url };
}

/** Bounded argv-only subprocess transport. It never invokes a shell or provider executable. */
export const ghCommandTransport: TrackerCommandTransport = (argv, limits) => new Promise((resolve) => {
  let settled = false;
  let stdout = '', stderr = '';
  let outputTruncated = false;
  const child = spawn('gh', [...argv], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const finish = (result: TrackerCommandResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
  const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    const current = stream === 'stdout' ? stdout : stderr;
    const remaining = limits.outputByteLimit - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
    if (remaining <= 0) { outputTruncated = true; child.kill(); return; }
    const clipped = chunk.subarray(0, remaining).toString('utf8');
    if (stream === 'stdout') stdout = current + clipped; else stderr = current + clipped;
    if (chunk.byteLength > remaining) { outputTruncated = true; child.kill(); }
  };
  const timer = setTimeout(() => { child.kill(); finish({ ok: false, stdout, stderr, timedOut: true }); }, limits.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
  child.on('error', () => finish({ ok: false, stdout, stderr }));
  child.on('close', (code) => finish({ ok: code === 0 && !outputTruncated, stdout, stderr, outputTruncated }));
});

/** Read-only native GitHub issue hierarchy observer. Membership comes from sub_issues, never labels. */
export class GitHubMapTracker {
  readonly #repo: string;
  readonly #parentIssue: number;
  readonly #transport: TrackerCommandTransport;
  readonly #now: () => string;
  readonly #pageLimit: number;
  readonly #limits: Readonly<{ timeoutMs: number; outputByteLimit: number }>;

  constructor(options: GitHubMapTrackerOptions) {
    if (!repoPattern.test(options.repo)) throw new Error('repo must be an OWNER/REPO identifier');
    this.#repo = options.repo;
    this.#parentIssue = positiveInteger(options.parentIssue, 'parentIssue');
    this.#transport = options.transport ?? ghCommandTransport;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#pageLimit = boundedPositiveInteger(options.pageLimit ?? 20, 'pageLimit', 50);
    this.#limits = Object.freeze({ timeoutMs: boundedPositiveInteger(options.timeoutMs ?? 10_000, 'timeoutMs', 60_000), outputByteLimit: boundedPositiveInteger(options.outputByteLimit ?? 1_000_000, 'outputByteLimit', 4_000_000) });
  }

  async snapshot(): Promise<GitHubMapSnapshot> {
    const reasons: MapIncompleteReason[] = [];
    const nodes = new Map<number, MutableNode>();
    const collecting = new Set<number>();
    const incomplete = (code: MapIncompleteReason['code'], subject: string): void => { reasons.push({ code, subject }); };
    const read = async (path: string): Promise<unknown | null> => {
      const result = await this.#transport(['api', '-X', 'GET', path, ...apiHeaders], this.#limits);
      if (!result.ok) { incomplete(result.outputTruncated ? 'output_bound' : 'transport_failed', path); return null; }
      try { return JSON.parse(result.stdout); } catch { incomplete('invalid_response', path); return null; }
    };
    const readIssue = async (number: number): Promise<RemoteIssue | null> => {
      const body = await read(`repos/${this.#repo}/issues/${number}`);
      const parsed = body === null ? null : issueFrom(body);
      if (parsed === null && body !== null) incomplete('invalid_response', `issue:${number}`);
      return parsed;
    };
    const readPages = async (path: string, parse: (value: unknown) => number | null): Promise<number[] | null> => {
      const values: number[] = [];
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
      collecting.add(number);
      const issue = await readIssue(number);
      if (issue !== null) {
        const node: MutableNode = { issue, parentIssue, subIssues: [], blockedBy: [] };
        nodes.set(number, node);
        const blockers = await readPages(`repos/${this.#repo}/issues/${number}/dependencies/blocked_by`, (entry) => blockerFrom(entry)?.number ?? null);
        if (blockers !== null) {
          for (const blockerNumber of blockers) {
            const blocker = await readIssue(blockerNumber);
            if (blocker !== null) node.blockedBy.push({ number: blocker.number, state: blocker.state, title: blocker.title, url: blocker.url });
          }
        }
        const children = await readPages(`repos/${this.#repo}/issues/${number}/sub_issues`, (entry) => issueFrom(entry)?.number ?? null);
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
      blockedBy: Object.freeze([...node.blockedBy].sort((a, b) => a.number - b.number)),
    })).sort((a, b) => a.number - b.number);
    const frontier = !complete ? [] : frozenNodes.filter((node) => node.number !== this.#parentIssue && node.state === 'OPEN' && node.blockedBy.every((blocker) => blocker.state === 'CLOSED')).map((node): MapFrontierNode => Object.freeze({ number: node.number, title: node.title, url: node.url, blockers: Object.freeze(node.blockedBy.map((blocker) => blocker.number)) }));
    return Object.freeze({
      source: Object.freeze({ repository: this.#repo, parentIssue: this.#parentIssue }), observedAt: this.#now(), completeness: complete ? 'complete' : 'incomplete',
      nodes: Object.freeze(frozenNodes), frontier: Object.freeze(frontier), incomplete: Object.freeze(reasons),
    });
  }
}
