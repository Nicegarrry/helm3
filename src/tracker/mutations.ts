import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import { commandSchema, type Command } from '../contracts/index.js';
import { GitHubMapTracker, type MapIssueState, type TrackerCommandResult, type TrackerCommandTransport, ghCommandTransport } from './index.js';

const apiHeaders = ['-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'] as const;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const positiveInteger = z.number().int().safe().positive();
const revision = z.string().datetime({ offset: false });
const reference = z.string().min(1).refine((value) => value.trim() === value, 'must not have surrounding whitespace');
const updatePayloadSchema = z.object({ issueNumber: positiveInteger, expectedRevision: revision, title: reference.optional(), body: reference.optional() }).strict().superRefine((value, context) => {
  if (value.title === undefined && value.body === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'update needs title or body' });
});
const closePayloadSchema = z.object({ issueNumber: positiveInteger, expectedRevision: revision, evidenceRefs: z.array(reference).min(1), resolvedDependencies: z.array(reference), rationale: reference }).strict();
type UpdatePayload = z.infer<typeof updatePayloadSchema>;
type ClosePayload = z.infer<typeof closePayloadSchema>;
type ParsedMutation = Readonly<{ command: Command; action: 'update'; payload: UpdatePayload }> | Readonly<{ command: Command; action: 'close'; payload: ClosePayload }>;
type RemoteIssue = Readonly<{ repository: string; number: number; title: string; body: string | null; state: MapIssueState; url: string; revision: string }>;

export type MapMutationTarget = Readonly<{ repository: string; number: number; revision: string; state: MapIssueState; url: string }>;
/**
 * This permit is issued by the kernel only after it has durably claimed the
 * immutable command/idempotency key. The tracker intentionally has no
 * process-local replay guard: a returned receipt alone does not persist or
 * reconcile an unknown effect.
 */
export type MapMutationEffectPermit = Readonly<{ commandId: string; idempotencyKey: string; commandHash: string; verifiedEvidenceRefs?: readonly string[] }>;
export type MapMutationAuthority = (input: Readonly<{ command: Command; commandHash: string; action: 'update' | 'close'; target: MapMutationTarget; closureEvidenceRefs?: readonly string[] }>) => Promise<MapMutationEffectPermit> | MapMutationEffectPermit;
export type MapMutationReceipt = Readonly<{
  commandId: string;
  commandHash: string;
  action: 'update' | 'close';
  state: 'succeeded' | 'refused' | 'unknown';
  target?: MapMutationTarget;
  observedAt: string;
  reason?: string;
  concurrency: 'read_before_write_not_atomic';
}>;
export type GitHubMapMutatorOptions = Readonly<{ repo: string; parentIssue: number; transport?: TrackerCommandTransport; now?: () => string; pageLimit?: number; timeoutMs?: number; outputByteLimit?: number }>;

/** Matches Kernel admission: hashes the exact JSON bytes produced by JSON.stringify. */
function hash(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function freeze<T>(value: T): T { return Object.freeze(value); }
function target(issue: RemoteIssue): MapMutationTarget { return freeze({ repository: issue.repository, number: issue.number, revision: issue.revision, state: issue.state, url: issue.url }); }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function string(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function state(value: unknown): MapIssueState | null { return typeof value === 'string' && value.toUpperCase() === 'OPEN' ? 'OPEN' : typeof value === 'string' && value.toUpperCase() === 'CLOSED' ? 'CLOSED' : null; }
function repository(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); const match = url.protocol === 'https:' && url.hostname === 'api.github.com' ? url.pathname.match(/^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/) : null; return match ? `${match[1]}/${match[2]}` : null; } catch { return null; }
}
function parseIssue(value: unknown): RemoteIssue | null {
  const row = record(value); if (!row || !Number.isSafeInteger(row.number) || (row.number as number) < 1) return null;
  const repo = repository(row.repository_url), title = string(row.title), body = row.body === null ? null : string(row.body), issueState = state(row.state), url = string(row.html_url), updatedAt = string(row.updated_at);
  if (!repo || title === null || body === null && row.body !== null && row.body !== undefined || !issueState || !url || !updatedAt || Number.isNaN(Date.parse(updatedAt))) return null;
  try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.pathname !== `/${repo}/issues/${row.number}` || parsed.search || parsed.hash) return null; } catch { return null; }
  return { repository: repo, number: row.number as number, title, body, state: issueState, url, revision: updatedAt };
}
function parseMutation(input: unknown): ParsedMutation {
  const command = deepFreeze(commandSchema.parse(input));
  if (command.kind === 'map.update') return freeze({ command, action: 'update', payload: deepFreeze(updatePayloadSchema.parse(command.payload)) });
  if (command.kind === 'map.close') return freeze({ command, action: 'close', payload: deepFreeze(closePayloadSchema.parse(command.payload)) });
  throw new Error('unsupported Map mutation kind');
}

/**
 * Bounded GitHub Map mutation adapter. It performs a membership snapshot and a
 * final target read before authority and PATCH. GitHub's issue REST PATCH has
 * no revision-CAS used here, so the sequence is deliberately not called atomic.
 */
export class GitHubMapMutator {
  readonly #repo: string;
  readonly #parentIssue: number;
  readonly #transport: TrackerCommandTransport;
  readonly #now: () => string;
  readonly #pageLimit: number;
  readonly #limits: Readonly<{ timeoutMs: number; outputByteLimit: number }>;

  constructor(options: GitHubMapMutatorOptions) {
    if (!repoPattern.test(options.repo)) throw new Error('repo must be an OWNER/REPO identifier');
    if (!Number.isSafeInteger(options.parentIssue) || options.parentIssue < 1) throw new Error('parentIssue must be a positive safe integer');
    this.#repo = options.repo; this.#parentIssue = options.parentIssue; this.#transport = options.transport ?? ghCommandTransport; this.#now = options.now ?? (() => new Date().toISOString());
    this.#pageLimit = boundedPositiveInteger(options.pageLimit ?? 20, 'pageLimit', 50);
    this.#limits = freeze({ timeoutMs: boundedPositiveInteger(options.timeoutMs ?? 10_000, 'timeoutMs', 60_000), outputByteLimit: boundedPositiveInteger(options.outputByteLimit ?? 1_000_000, 'outputByteLimit', 4_000_000) });
  }

  async mutate(input: unknown, authority: MapMutationAuthority): Promise<MapMutationReceipt> {
    let parsed: ParsedMutation;
    try { parsed = parseMutation(input); } catch (error) { return this.receipt('refused', 'update', input, undefined, `invalid command: ${message(error)}`); }
    const issueNumber = parsed.payload.issueNumber;
    if (parsed.command.scope.repositoryId !== this.#repo || parsed.command.scope.mapNodeId !== String(issueNumber)) return this.receipt('refused', parsed.action, parsed.command, undefined, 'command scope does not name this Map target');
    const immutableCommandHash = hash(parsed.command);
    if (parsed.command.payloadHash !== hash(parsed.command.payload)) return this.receipt('refused', parsed.action, parsed.command, undefined, 'command payload hash does not bind its exact JSON payload');
    if (!hasExpectedRevision(parsed.command, this.#repo, issueNumber, parsed.payload.expectedRevision)) return this.receipt('refused', parsed.action, parsed.command, undefined, 'command lacks the exact GitHub issue revision precondition');
    if (parsed.action === 'close' && !parsed.payload.evidenceRefs.every((ref) => parsed.command.requiredEvidence.includes(ref))) return this.receipt('refused', parsed.action, parsed.command, undefined, 'closure evidence is not bound to the command');
    let map;
    try { map = await new GitHubMapTracker({ repo: this.#repo, parentIssue: this.#parentIssue, transport: this.#transport, now: this.#now }).snapshot(); } catch { return this.receipt('refused', parsed.action, parsed.command, undefined, 'fresh Map membership read is unavailable'); }
    if (map.completeness !== 'complete' || !map.nodes.some((node) => node.number === issueNumber)) return this.receipt('refused', parsed.action, parsed.command, undefined, 'fresh Map membership is unavailable or target is foreign');
    const current = await this.readIssue(this.#repo, issueNumber);
    if (!current.ok) return this.receipt('refused', parsed.action, parsed.command, undefined, current.reason);
    if (current.value.revision !== parsed.payload.expectedRevision) return this.receipt('refused', parsed.action, parsed.command, target(current.value), 'GitHub issue revision is stale');
    let effectTarget = current.value;
    if (parsed.action === 'close') {
      const dependencies = await this.readBlockers(issueNumber);
      if (!dependencies.ok) return this.receipt('refused', parsed.action, parsed.command, target(current.value), dependencies.reason);
      const actual = dependencies.value.map((item) => `${item.repository}#${item.number}`).sort(); const declared = [...parsed.payload.resolvedDependencies].sort();
      if (actual.join('\n') !== declared.join('\n')) return this.receipt('refused', parsed.action, parsed.command, target(current.value), 'closure dependencies do not match fresh GitHub facts');
      if (dependencies.value.some((item) => item.state !== 'CLOSED')) return this.receipt('refused', parsed.action, parsed.command, target(current.value), 'closure has an unresolved dependency');
      const finalTarget = await this.readIssue(this.#repo, issueNumber);
      if (!finalTarget.ok) return this.receipt('refused', parsed.action, parsed.command, target(current.value), finalTarget.reason);
      if (finalTarget.value.revision !== parsed.payload.expectedRevision) return this.receipt('refused', parsed.action, parsed.command, target(finalTarget.value), 'GitHub issue revision changed during dependency verification');
      effectTarget = finalTarget.value;
    }
    try {
      const permit = await authority(freeze({ command: parsed.command, commandHash: immutableCommandHash, action: parsed.action, target: target(effectTarget), ...(parsed.action === 'close' ? { closureEvidenceRefs: parsed.payload.evidenceRefs } : {}) }));
      if (permit.commandId !== parsed.command.commandId || permit.idempotencyKey !== parsed.command.idempotencyKey || permit.commandHash !== immutableCommandHash) return this.receipt('refused', parsed.action, parsed.command, target(effectTarget), 'kernel authority permit does not bind this immutable command');
      if (parsed.action === 'close' && !sameReferences(permit.verifiedEvidenceRefs, parsed.payload.evidenceRefs)) return this.receipt('refused', parsed.action, parsed.command, target(effectTarget), 'closure evidence was not verified by authority');
    } catch (error) { return this.receipt('refused', parsed.action, parsed.command, target(effectTarget), `authority refused: ${message(error)}`); }
    const fields = parsed.action === 'update'
      ? [parsed.payload.title === undefined ? [] : ['-f', `title=${parsed.payload.title}`], parsed.payload.body === undefined ? [] : ['-f', `body=${parsed.payload.body}`]].flat()
      : ['-f', 'state=closed'];
    let write: TrackerCommandResult;
    try { write = await this.#transport(['api', '-X', 'PATCH', `repos/${this.#repo}/issues/${issueNumber}`, ...fields, ...apiHeaders], this.#limits); } catch { return this.receipt('unknown', parsed.action, parsed.command, target(effectTarget), 'write transport threw; reconcile GitHub before replay'); }
    if (!write.ok) return this.receipt('unknown', parsed.action, parsed.command, target(effectTarget), 'write transport failed; reconcile GitHub before replay');
    const observed = await this.readIssue(this.#repo, issueNumber);
    if (!observed.ok) return this.receipt('unknown', parsed.action, parsed.command, target(effectTarget), 'write response was received but readback is unavailable; reconcile GitHub before replay');
    if (parsed.action === 'close' && observed.value.state !== 'CLOSED') return this.receipt('unknown', parsed.action, parsed.command, target(observed.value), 'write readback does not show closed state; reconcile GitHub before replay');
    if (parsed.action === 'update' && (parsed.payload.title !== undefined && observed.value.title !== parsed.payload.title || parsed.payload.body !== undefined && observed.value.body !== parsed.payload.body)) return this.receipt('unknown', parsed.action, parsed.command, target(observed.value), 'write readback does not match requested fields; reconcile GitHub before replay');
    return this.receipt('succeeded', parsed.action, parsed.command, target(observed.value));
  }

  private async readIssue(repository: string, number: number): Promise<{ ok: true; value: RemoteIssue } | { ok: false; reason: string }> {
    try {
      const result = await this.#transport(['api', '-X', 'GET', `repos/${repository}/issues/${number}`, ...apiHeaders], this.#limits);
      if (!result.ok) return { ok: false, reason: 'GitHub target read failed' };
      const value = parseIssue(JSON.parse(result.stdout)); return value && value.repository === repository && value.number === number ? { ok: true, value } : { ok: false, reason: 'GitHub target identity is invalid or foreign' };
    } catch { return { ok: false, reason: 'GitHub target read is unavailable' }; }
  }
  private async readBlockers(number: number): Promise<{ ok: true; value: RemoteIssue[] } | { ok: false; reason: string }> {
    const values: RemoteIssue[] = [];
    for (let page = 1; page <= this.#pageLimit; page += 1) {
      try {
        const result = await this.#transport(['api', '-X', 'GET', `repos/${this.#repo}/issues/${number}/dependencies/blocked_by?per_page=100&page=${page}`, ...apiHeaders], this.#limits);
        if (!result.ok) return { ok: false, reason: 'GitHub dependency read failed' };
        const body: unknown = JSON.parse(result.stdout); if (!Array.isArray(body)) return { ok: false, reason: 'GitHub dependency response is invalid' };
        const parsed = body.map(parseIssue); if (!parsed.every((value): value is RemoteIssue => value !== null)) return { ok: false, reason: 'GitHub dependency identity is invalid' };
        for (const dependency of parsed) {
          const fresh = await this.readIssue(dependency.repository, dependency.number);
          if (!fresh.ok) return { ok: false, reason: `GitHub dependency read is unavailable: ${dependency.repository}#${dependency.number}` };
          values.push(fresh.value);
        }
        if (body.length < 100) return { ok: true, value: values };
      } catch { return { ok: false, reason: 'GitHub dependency response is invalid' }; }
    }
    return { ok: false, reason: 'GitHub dependency page limit reached' };
  }
  private receipt(state: MapMutationReceipt['state'], action: MapMutationReceipt['action'], command: unknown, targetValue?: MapMutationTarget, reason?: string): MapMutationReceipt {
    const commandId = typeof command === 'object' && command !== null && typeof (command as { commandId?: unknown }).commandId === 'string' ? (command as { commandId: string }).commandId : 'invalid-command';
    const commandHash = typeof command === 'object' && command !== null ? hash(command) : 'sha256:invalid-command';
    return freeze({ commandId, commandHash, action, state, ...(targetValue ? { target: targetValue } : {}), observedAt: this.#now(), ...(reason ? { reason } : {}), concurrency: 'read_before_write_not_atomic' });
  }
}

function hasExpectedRevision(command: Command, repo: string, number: number, expectedRevision: string): boolean {
  return command.expected.some((item) => item.authority === 'github' && item.subject === `repos/${repo}/issues/${number}` && item.version === expectedRevision && item.predicate === 'issue revision matches');
}
function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  if (value > maximum) throw new Error(`${name} must not exceed ${maximum}`);
  return value;
}
function sameReferences(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return actual !== undefined && actual.length === expected.length && [...actual].sort().every((ref, index) => ref === [...expected].sort()[index]);
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'unknown error'; }
