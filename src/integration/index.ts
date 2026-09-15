import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import type { Command, Precondition } from '../contracts/index.js';
import type { Claim, CommandRecord, EffectObservation, KernelEffect, KernelHost, TrustedExecutor } from '../core/index.js';
import { classifyCi, type CiCheck } from '../verification/index.js';
import { ghCommandTransport, type TrackerCommandTransport } from '../tracker/index.js';

type ExactHead = string;
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const positive = z.number().int().positive();

export type IntegrationFacts = Readonly<{
  repository: string; pr: number; head: ExactHead; baseRef: string; baseHead: ExactHead; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  checks: readonly CiCheck[];
  acceptanceEvidence: readonly Readonly<{ ref: string; head: ExactHead }>[];
  mergeCommit: ExactHead | null; targetHead: ExactHead | null; targetContainsMerge: boolean | null;
  /** Receipts are written by trusted runtime/session registries, never by a review body or account string. */
  reviewReceipts: readonly Readonly<{ receiptId: string; pr: number; head: ExactHead; verdict: 'approved'; builder: Readonly<{ attemptId: string; sessionId: string; family: string }>; reviewer: Readonly<{ attemptId: string; sessionId: string; family: string }> }> [];
}>;
export type IntegrationPreparation = Readonly<{ repository: string; pr: number; expectedHead: ExactHead; expectedBaseRef: string; expectedBaseHead: ExactHead; acceptanceEvidence: readonly string[]; reviewReceiptIds: readonly string[]; preparedAt: string; facts: IntegrationFacts }>;

export type IntegrationGateway = Readonly<{
  read(pr: number): Promise<IntegrationFacts>;
  /** Must be a head-CAS. It may have taken effect when its transport result is ambiguous. */
  merge(pr: number, expectedHead: ExactHead): Promise<void>;
}>;

function exactCommandHash(command: Command): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(command)).digest('hex')}`;
}
function validFacts(facts: IntegrationFacts): string | null {
  if (!repository.safeParse(facts.repository).success || !positive.safeParse(facts.pr).success || !sha.safeParse(facts.head).success || !sha.safeParse(facts.baseHead).success || !facts.baseRef.trim()) return 'Invalid PR identity, base, or exact head';
  if (facts.state !== 'OPEN' || facts.mergeable !== 'MERGEABLE') return 'PR is not freshly open and mergeable';
  const ci = classifyCi(facts.checks);
  if (ci.state !== 'green') return `CI is not green on the exact head (${ci.state})`;
  const receipt = facts.reviewReceipts.find(receipt => receipt.pr === facts.pr && receipt.head === facts.head && receipt.verdict === 'approved'
    && receipt.builder.attemptId.length > 0 && receipt.builder.sessionId.length > 0 && receipt.reviewer.attemptId.length > 0 && receipt.reviewer.sessionId.length > 0
    && receipt.builder.attemptId !== receipt.reviewer.attemptId && receipt.builder.sessionId !== receipt.reviewer.sessionId && receipt.builder.family !== receipt.reviewer.family);
  if (!receipt) return 'No trusted independent review receipt is bound to the exact head';
  return facts.acceptanceEvidence.length > 0 && facts.acceptanceEvidence.every(item => item.ref.length > 0 && item.head === facts.head) ? null : 'No trusted acceptance evidence is bound to the exact head';
}

/** Pure preparation: no caller-supplied account/team strings count as approval. */
export async function prepareIntegration(gateway: IntegrationGateway, pr: number, now: () => string = () => new Date().toISOString()): Promise<IntegrationPreparation> {
  if (!positive.safeParse(pr).success) throw new Error('PR must be a positive integer');
  const facts = await gateway.read(pr); const refusal = validFacts(facts);
  if (refusal) throw new Error(`Integration preparation refused: ${refusal}`);
  return Object.freeze({ repository: facts.repository, pr, expectedHead: facts.head, expectedBaseRef: facts.baseRef, expectedBaseHead: facts.baseHead, acceptanceEvidence: Object.freeze(facts.acceptanceEvidence.map(item => item.ref)), reviewReceiptIds: Object.freeze(facts.reviewReceipts.map(item => item.receiptId)), preparedAt: now(), facts: Object.freeze(facts) });
}

export const integrationMergePayloadSchema = z.object({
  repository, pr: positive, expectedHead: sha, expectedBaseRef: z.string().min(1), expectedBaseHead: sha, acceptanceEvidence: z.array(z.string().min(1)).min(1), reviewReceiptIds: z.array(z.string().min(1)).min(1),
}).strict();
export type IntegrationMergePayload = z.infer<typeof integrationMergePayloadSchema>;

export type IntegrationKernel = Pick<KernelHost, 'claim' | 'perform'>;
export type MergeExecution = Readonly<{
  kernel: IntegrationKernel; command: CommandRecord; executor: TrustedExecutor; claimExpiresAt: string;
  gateway: IntegrationGateway;
  /** Trusted host callback. It receives the exact immutable JSON.stringify command hash at the effect boundary. */
  assertAuthority: (command: Command, immutableHash: string) => Promise<void>;
  assertIntegrationExecutor: (command: Command, executor: TrustedExecutor) => Promise<void>;
  effectId: string;
}>;

function payloadFor(command: Command): IntegrationMergePayload {
  if (command.kind !== 'integration.merge') throw new Error('Integration requires an integration.merge command');
  return integrationMergePayloadSchema.parse(command.payload);
}
function samePrepared(payload: IntegrationMergePayload, prepared: IntegrationPreparation): boolean {
  return payload.repository === prepared.repository && payload.pr === prepared.pr && payload.expectedHead === prepared.expectedHead && payload.expectedBaseRef === prepared.expectedBaseRef && payload.expectedBaseHead === prepared.expectedBaseHead && payload.acceptanceEvidence.length === prepared.acceptanceEvidence.length && payload.acceptanceEvidence.every(ref => prepared.acceptanceEvidence.includes(ref)) && payload.reviewReceiptIds.length === prepared.reviewReceiptIds.length && payload.reviewReceiptIds.every(id => prepared.reviewReceiptIds.includes(id));
}

/**
 * Executes only through an already-admitted Kernel command. The Kernel creates the
 * claim and rechecks its lease/epoch around the effect; this module never claims
 * success from a transport result and never retries an uncertain merge.
 */
export async function mergeIntegration(prepared: IntegrationPreparation, input: MergeExecution): Promise<EffectObservation> {
  if (input.command.status !== 'queued') throw new Error(`Integration command is not queued: ${input.command.status}`);
  const payload = payloadFor(input.command.command);
  if (!samePrepared(payload, prepared)) throw new Error('Immutable command does not match prepared exact-head identity');
  const commandHash = exactCommandHash(input.command.command);
  if (commandHash !== input.command.immutableHash) throw new Error('Kernel command immutable hash does not match JSON.stringify command bytes');
  const claim: Claim = input.kernel.claim(input.command.command.commandId, input.executor, input.claimExpiresAt);
  let effectAttempted = false;
  const fresh = async (): Promise<IntegrationFacts> => {
    const facts = await input.gateway.read(payload.pr);
    if (facts.repository !== payload.repository || facts.pr !== payload.pr || facts.head !== payload.expectedHead || facts.baseRef !== payload.expectedBaseRef || facts.baseHead !== payload.expectedBaseHead) throw new Error('Prepared exact head, base, or PR identity changed');
    const refusal = validFacts(facts); if (refusal) throw new Error(refusal); return facts;
  };
  const readFact = async (precondition: Precondition) => {
    try { await fresh(); return { value: true, state: 'known' as const, source: 'integration.fresh-github', observedAt: new Date().toISOString(), subjectVersion: precondition.version }; }
    catch (error) { return { value: null, state: 'unknown' as const, source: 'integration.fresh-github', observedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : 'fresh fact unavailable' }; }
  };
  const effect: KernelEffect = {
    effectId: input.effectId,
    execute: async command => {
      payloadFor(command); await fresh();
      await input.assertAuthority(command, commandHash);
      await input.assertIntegrationExecutor(command, input.executor);
      effectAttempted = true;
      await input.gateway.merge(payload.pr, payload.expectedHead);
    },
    observe: async command => {
      const current = await input.gateway.read(payload.pr);
      if (current.repository !== payload.repository || current.pr !== payload.pr) return { commandId: command.commandId, effectId: input.effectId, state: 'unknown', source: 'integration.github', observedAt: new Date().toISOString(), evidenceRefs: ['integration:identity-unreadable'], detail: 'merge readback identity changed' };
      if (current.state === 'MERGED' && current.head === payload.expectedHead && current.mergeCommit && current.targetHead && current.targetContainsMerge) return { commandId: command.commandId, effectId: input.effectId, state: 'succeeded', source: 'integration.github', observedAt: new Date().toISOString(), evidenceRefs: [`github:pr:${payload.pr}:merged:${current.mergeCommit}`, `github:ref:${current.baseRef}:${current.targetHead}`] };
      return { commandId: command.commandId, effectId: input.effectId, state: effectAttempted ? 'unknown' : 'failed', source: 'integration.github', observedAt: new Date().toISOString(), evidenceRefs: [`github:pr:${payload.pr}:readback`], detail: effectAttempted ? 'Merge effect has no conclusive matching readback; no replay is attempted' : 'Merge effect did not start' };
    },
  };
  return input.kernel.perform(input.command.command.commandId, claim, input.executor, readFact, effect);
}

type Api = Record<string, unknown>;
function object(value: unknown): Api { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub response is not an object'); return value as Api; }
function text(value: unknown, field: string): string { if (typeof value !== 'string' || !value) throw new Error(`GitHub response lacks ${field}`); return value; }
function pullState(value: unknown): IntegrationFacts['state'] { const state = text(value, 'state').toUpperCase(); if (state === 'OPEN' || state === 'MERGED' || state === 'CLOSED') return state; throw new Error('GitHub response has invalid pull state'); }
function checkRows(value: unknown, source: CiCheck['source']): CiCheck[] { const rows = Array.isArray(value) ? value : []; return rows.map(row => { const item = object(row); return { source, status: text(item.status ?? item.state, 'check status'), conclusion: typeof item.conclusion === 'string' ? item.conclusion : null }; }); }
function argv(method: string, path: string, fields: readonly string[] = []): string[] { return ['api', '--method', method, path, ...fields]; }
async function api(transport: TrackerCommandTransport, args: readonly string[]): Promise<Api> { const result = await transport(args, { timeoutMs: 10_000, outputByteLimit: 1024 * 1024 }); if (!result.ok || result.timedOut || result.outputTruncated) throw new Error('GitHub transport is unavailable or incomplete'); try { return object(JSON.parse(result.stdout)); } catch { throw new Error('GitHub response is invalid JSON'); } }

/** Concrete argv-only GitHub gateway. Approval receipts remain a host-owned registry. */
export function createGitHubIntegrationGateway(options: Readonly<{ repository: string; receipts: () => readonly IntegrationFacts['reviewReceipts'][number][]; acceptanceEvidence: (pr: number, head: ExactHead) => readonly { ref: string; head: ExactHead }[]; transport?: TrackerCommandTransport }>): IntegrationGateway {
  repository.parse(options.repository); const transport = options.transport ?? ghCommandTransport;
  return {
    read: async pr => {
      positive.parse(pr); const base = `repos/${options.repository}`;
      const pull = await api(transport, argv('GET', `${base}/pulls/${pr}`)); const head = sha.parse(text(object(pull.head).sha, 'head.sha')); const baseRef = text(object(pull.base).ref, 'base.ref'); const baseHead = sha.parse(text(object(pull.base).sha, 'base.sha')); const state = pullState(pull.state);
      const [runs, statuses, target] = await Promise.all([api(transport, argv('GET', `${base}/commits/${head}/check-runs`)), api(transport, argv('GET', `${base}/commits/${head}/status`)), api(transport, argv('GET', `${base}/git/ref/heads/${encodeURIComponent(baseRef)}`))]);
      const targetHead = sha.parse(text(object(target.object).sha, 'target.sha')); const mergeCommit = typeof pull.merge_commit_sha === 'string' && sha.safeParse(pull.merge_commit_sha).success ? pull.merge_commit_sha : null;
      const comparison = mergeCommit === null ? null : await api(transport, argv('GET', `${base}/compare/${mergeCommit}...${targetHead}`)); const targetContainsMerge = comparison === null ? null : ['ahead', 'identical'].includes(text(comparison.status, 'comparison.status'));
      return Object.freeze({ repository: options.repository, pr, head, baseRef, baseHead, state, mergeable: typeof pull.mergeable_state === 'string' && pull.mergeable_state === 'clean' ? 'MERGEABLE' : 'UNKNOWN', checks: Object.freeze([...checkRows(runs.check_runs, 'check_run'), ...checkRows(statuses.statuses, 'status')]), acceptanceEvidence: Object.freeze(options.acceptanceEvidence(pr, head)), mergeCommit, targetHead, targetContainsMerge, reviewReceipts: Object.freeze(options.receipts().filter(receipt => receipt.pr === pr && receipt.head === head)) });
    },
    merge: async (pr, expectedHead) => { positive.parse(pr); sha.parse(expectedHead); await api(transport, argv('PUT', `repos/${options.repository}/pulls/${pr}/merge`, ['-f', `sha=${expectedHead}`])); },
  };
}
