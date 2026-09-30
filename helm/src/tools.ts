/** The tool registry: maps tool names to their zod input schemas and dispatches validated calls to a Helm instance. */
import { z } from 'zod';
import {
  emptyInput,
  budgetCloseInput,
  budgetOpenInput,
  budgetStatusInput,
  envelopeGetInput,
  envelopeCheckInput,
  tapRequestInput,
  tapConfirmInput,
  daemonInput,
  gateInput,
  baselineInput,
  claimsCheckInput,
  inspectInput,
  inboxListInput,
  inboxReplyInput,
  listInput,
  prMergeInput,
  prOpenInput,
  prStatusInput,
  reviewInput,
  reviewRecordInput,
  spawnInput,
  steerInput,
  retryInput,
  stopInput,
  waitInput,
  supervisorRegisterInput,
  supervisorListInput,
  wakeListInput,
  supervisorRotateInput,
  notifyNickInput,
  jevCheckInput,
  jevLabelInput,
  memoryWriteInput,
  memoryLogInput,
  memoryListInput,
  mergeEnqueueInput,
  mergeQueueInput,
  mergeDequeueInput,
  deployRunInput,
  deployStatusInput,
  deployRollbackInput,
  routingCheckInput,
  spendSetInput,
  type ToolName,
  type ToolOutcome,
} from './types.js';
import { scorecardExportInput } from './scorecard.js';
import { READ_TOOLS } from './lifecycle.js';
import type { Helm } from './helm.js';

type ToolDef = Readonly<{
  name: ToolName;
  description: string;
  inputSchema: z.ZodObject;
  call: (helm: Helm, input: never) => Promise<ToolOutcome<unknown>>;
}>;

export const TOOL_PROFILES = ['core', 'supervisor', 'all'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

export const CORE_TOOL_NAMES = [
  'worker.spawn', 'worker.steer', 'worker.inspect', 'worker.list', 'worker.wait',
  'inbox.list', 'inbox.reply', 'wake.list', 'gate.run', 'pr.open', 'merge.enqueue',
  'run.status', 'tap.confirm',
] as const;
export const SUPERVISOR_TOOL_NAMES = [
  ...CORE_TOOL_NAMES, 'review.record', 'claims.check', 'gate.baseline', 'worker.retry',
  'pr.status', 'envelope.check', 'tap.request', 'deploy.run', 'deploy.status',
  'memory.write', 'memory.list', 'scorecard.export', 'budget.status', 'spend.set',
] as const;
export const META_TOOL_NAMES = ['helm.call', 'helm.help'] as const;

// Cast each schema/handler pair once here so the table below stays readable; `call`'s
// input is validated against `inputSchema` before it is ever invoked.
function def<S extends z.ZodObject>(name: ToolName, description: string, inputSchema: S, call: (helm: Helm, input: z.infer<S>) => Promise<ToolOutcome<unknown>>): ToolDef {
  return { name, description, inputSchema, call: call as ToolDef['call'] };
}
const TOOLS: readonly ToolDef[] = [
  def('daemon.control', 'Inspect lifecycle, drain work, resume admissions, stop an idle daemon, or apply a staged upgrade.', daemonInput, (h, i) => h.lifecycle.control(i)),
  def('budget.open', 'Open a project sprint budget and close its previous budget.', budgetOpenInput, (h, i) => h.budgetOpen(i)),
  def('budget.close', 'Close the open budget for a project.', budgetCloseInput, (h, i) => h.budgetClose(i)),
  def('budget.status', 'List project budgets with spend, capacity, and attributed workers.', budgetStatusInput, (h, i) => h.budgetStatus(i)),
  def('envelope.get', 'Read a project autonomy envelope, summary, rules, and content hash.', envelopeGetInput, (h, i) => h.envelopeGet(i)),
  def('envelope.check', 'Check proposed actions against hard rules, the envelope, and Jev.', envelopeCheckInput, (h, i) => h.envelopeCheck(i)),
  def('tap.request', 'Request a one-time human approval code; the code is never returned.', tapRequestInput, (h, i) => h.tapRequest(i)),
  def('tap.confirm', 'Confirm a one-time human approval code.', tapConfirmInput, (h, i) => h.tapConfirm(i)),
  def('worker.spawn', 'Start an isolated worker; omit model to let Jev select a policy-approved tier.', spawnInput, (h, i) => h.spawn(i)),
  def('worker.inspect', 'Get a worker state, spend, diff stat, result, and recent events.', inspectInput, (h, i) => h.inspect(i)),
  def('worker.list', 'List workers, optionally filtered by repository or state.', listInput, (h, i) => h.list(i)),
  def('worker.wait', 'Wait for workers to settle or time out; call again when timedOut instead of polling.', waitInput, (h, i) => h.wait(i)),
  def('worker.steer', 'Send a follow-up message to an idle, waiting, succeeded, failed or interrupted worker to start another turn.', steerInput, (h, i) => h.steer(i)),
  def('worker.retry', 'Retry a named worker failure with evidence and baseline test-file guardrails.', retryInput, (h, i) => h.retryWorker(i)),
  def('worker.stop', 'Stop a running worker at the next turn boundary and wait briefly for it to settle.', stopInput, (h, i) => h.stop(i)),
  def('gate.run', 'Run repository checks against a worker commit and record pass or fail.', gateInput, (h, i) => h.gate(i)),
  def('gate.baseline', 'Run a validator\'s acceptance test at its head and record a red baseline.', baselineInput, (h, i) => h.baseline(i)),
  def('claims.check', 'Check worker claims against its committed diff using Jev.', claimsCheckInput, (h, i) => h.claimsCheck(i)),
  def('pr.open', 'Push a worker branch and open a pull request after a passing exact-head gate.', prOpenInput, (h, i) => h.prOpen(i)),
  def('pr.status', 'Get a PR state, mergeability, checks, and reviews by number or worker.', prStatusInput, (h, i) => h.prStatus(i)),
  def('review.request', 'Review an open PR; omitted models use routing. Claude reviews use review.record.', reviewInput, (h, i) => h.reviewRequest(i)),
  def('review.record', 'Record an external review comment and verdict for the exact pull-request head.', reviewRecordInput, (h, i) => h.reviewRecord(i)),
  def('run.status', 'Get spend, caps, active workers, and available worker slots.', emptyInput, (h) => h.runStatus()),
  def('routing.check', 'Probe configured routing candidates and record the check time.', routingCheckInput, (h) => h.routingCheckNow()),
  def('spend.set', 'Update global spend caps and worker limits; raises require a spend.cap tap.', spendSetInput, (h, i) => h.spendSet(i)),
  def('pr.merge', 'Merge a PR only when open, mergeable, exact-head, and all checks passed.', prMergeInput, (h, i) => h.prMerge(i)),
  def('inbox.list', 'List open worker questions, optionally filtered by project or state.', inboxListInput, (h, i) => h.inboxList(i)),
  def('inbox.reply', 'Answer an open worker question and resume that worker on the same session.', inboxReplyInput, (h, i) => h.inboxReply(i)),
  def('notify.nick', 'Post an immediate project notification to Nick, rate-limited to once per minute.', notifyNickInput, (h, i) => h.notifyNick(i)),
  def('supervisor.register', 'Register or update the owner supervisor for a project.', supervisorRegisterInput, (h, i) => h.supervisorRegister(i)),
  def('supervisor.list', 'List registered project supervisors.', supervisorListInput, (h) => h.supervisorList()),
  def('wake.list', 'List unacknowledged supervisor wakes for a project, optionally acknowledging them.', wakeListInput, (h, i) => h.wakeList(i)),
  def('supervisor.rotate', 'Queue a compact command and the supervisor startup wake.', supervisorRotateInput, (h, i) => h.supervisorRotate(i)),
  def('jev.check', 'Run a bounded Jev judgement preset and record the call.', jevCheckInput, (h, i) => h.jevCheck(i)),
  def('jev.label', 'Label a recorded Jev call for calibration.', jevLabelInput, (h, i) => h.jevLabel(i)),
  def('memory.write', 'Write a local Common Ground memory page and queue its CG write.', memoryWriteInput, (h, i) => h.memoryWrite(i)),
  def('memory.log', 'Prepend a dated entry to a local memory page and queue its CG log.', memoryLogInput, (h, i) => h.memoryLog(i)),
  def('memory.list', 'List local memory pages, optionally filtered by project and type.', memoryListInput, (h, i) => h.memoryList(i)),
  def('scorecard.export', 'Export the project scorecard for a sprint or since timestamp.', scorecardExportInput, (h, i) => h.scorecardExport(i)),
  def('merge.enqueue', 'Add a pull request to its repository merge queue.', mergeEnqueueInput, (h, i) => h.mergeEnqueue(i)),
  def('merge.queue', 'List the pull requests queued for a project.', mergeQueueInput, (h, i) => h.mergeQueue(i)),
  def('merge.dequeue', 'Remove a queued pull request before processing starts.', mergeDequeueInput, (h, i) => h.mergeDequeue(i)),
  def('deploy.run', 'Deploy a SHA to a configured repository target, then run its smoke contract.', deployRunInput, (h, i) => h.deployRun(i)),
  def('deploy.status', 'List recorded deployments for a project or deployment id.', deployStatusInput, (h, i) => h.deployStatus(i)),
  def('deploy.rollback', 'Roll back a recorded production deployment to its previous provider deployment.', deployRollbackInput, (h, i) => h.deployRollback(i)),
];

const helmCallInput = z.object({ tool: z.string().min(1), input: z.unknown() }).strict();
const helmHelpInput = z.object({ tool: z.string().min(1).optional() }).strict();
const META_TOOLS: readonly ToolDef[] = [
  def('helm.call', 'Call any registered Helm tool by name with its normal validation and guards.', helmCallInput, async () => ({ ok: false, reason: 'helm.call is handled by the registry' })),
  def('helm.help', 'List tools or return one tool\'s full schema and description.', helmHelpInput, async () => ({ ok: false, reason: 'helm.help is handled by the registry' })),
];
const ALL_TOOLS: readonly ToolDef[] = [...TOOLS, ...META_TOOLS];
const BY_NAME = new Map<string, ToolDef>(ALL_TOOLS.map((t) => [t.name, t]));
export const ALL_TOOL_NAMES = ALL_TOOLS.map((tool) => tool.name);
const CORE_VISIBLE_NAMES = new Set<string>([...CORE_TOOL_NAMES, ...META_TOOL_NAMES]);
const SUPERVISOR_VISIBLE_NAMES = new Set<string>([...SUPERVISOR_TOOL_NAMES, ...META_TOOL_NAMES]);

export function resolveToolProfile(value: unknown, fallback: ToolProfile = 'core'): ToolProfile {
  return typeof value === 'string' && (TOOL_PROFILES as readonly string[]).includes(value) ? value as ToolProfile : fallback;
}

function compactPurpose(description: string): string {
  const oneLine = description.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77).trimEnd()}...`;
}

function toolJsonSchema(tool: ToolDef): Record<string, unknown> {
  return z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
}

export function createToolRegistry(helm: Helm, profile: ToolProfile = 'all'): {
  list(): Array<{ name: ToolName; description: string; inputSchema: z.ZodObject }>;
  call(name: string, input: unknown): Promise<ToolOutcome<Record<string, unknown>>>;
} {
  return {
    list() {
      const visible = profile === 'all' ? undefined : profile === 'core' ? CORE_VISIBLE_NAMES : SUPERVISOR_VISIBLE_NAMES;
      return ALL_TOOLS.filter((tool) => !visible || visible.has(tool.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },
    async call(name, input) {
      const tool = BY_NAME.get(name);
      if (!tool) return { ok: false, reason: `unknown tool: ${name}` };
      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) return { ok: false, reason: `invalid input: ${parsed.error.message}` };
      if (name === 'helm.call') return this.call((parsed.data as z.infer<typeof helmCallInput>).tool, (parsed.data as z.infer<typeof helmCallInput>).input);
      if (name === 'helm.help') {
        const requested = (parsed.data as z.infer<typeof helmHelpInput>).tool;
        if (!requested) return { ok: true, index: ALL_TOOLS.map((entry) => `${entry.name}: ${compactPurpose(entry.description)}`).join('\n') };
        const found = BY_NAME.get(requested);
        if (!found) return { ok: false, reason: `unknown tool: ${requested}` };
        return { ok: true, tool: found.name, description: found.description, inputSchema: toolJsonSchema(found) };
      }
      let release: (() => void) | undefined;
      try {
        if (!READ_TOOLS.has(name)) release = helm.lifecycle?.admit(name);
        return await tool.call(helm, parsed.data as never) as ToolOutcome<Record<string, unknown>>;
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally { release?.(); }
    },
  };
}
