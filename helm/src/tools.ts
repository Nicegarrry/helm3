/** The tool registry: maps tool names to their zod input schemas and dispatches validated calls to a Helm instance. */
import { z } from 'zod';
import {
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
  runStatusInput,
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
  notifyOwnerInput,
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
  'worker.spawn', 'worker.steer', 'worker.inspect', 'inbox.reply', 'wake.list',
  'gate.run', 'pr.open', 'run.status',
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

type JsonObject = Record<string, unknown>;

function truncate(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function compactList(outcome: ToolOutcome<unknown>, verbose: boolean): ToolOutcome<unknown> {
  if (verbose || !outcome.ok) return outcome;
  const source = outcome as unknown as JsonObject;
  if (!Array.isArray(source.workers)) return outcome;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const visible = source.workers.filter((worker) => {
    if (!worker || typeof worker !== 'object') return false;
    const row = worker as JsonObject;
    if (row.state === 'queued' || row.state === 'running' || row.state === 'waiting') return true;
    const updatedAt = Date.parse(String(row.updatedAt ?? row.createdAt ?? ''));
    return Number.isFinite(updatedAt) && updatedAt >= cutoff;
  });
  const lines = visible.slice(0, 30).map((worker) => {
    const row = worker as JsonObject;
    return `${String(row.workerId ?? '?')} ${String(row.state ?? '?')} ${String(row.model ?? '?')} ${String(row.head ?? '-').slice(0, 7)}`;
  });
  if (visible.length > 30) lines.push(`+${visible.length - 30} more`);
  return { ok: true, workers: lines } as ToolOutcome<Record<string, unknown>>;
}

function compactInspect(outcome: ToolOutcome<unknown>, verbose: boolean): ToolOutcome<unknown> {
  if (verbose || !outcome.ok) return outcome;
  const source = outcome as JsonObject;
  const result = source.result && typeof source.result === 'object' ? source.result as JsonObject : undefined;
  const events = Array.isArray(source.events) ? source.events : [];
  return {
    ok: true,
    state: source.state,
    model: source.model,
    branch: source.branch,
    head: source.head,
    spendUsd: source.spendUsd,
    tokens: source.tokens,
    diffStat: truncate(String(source.diffStat ?? '').split('\n')[0] ?? '', 200),
    ...(result ? { result: { status: result.status, summary: truncate(result.summary, 200) } } : {}),
    events: events.slice(-5).map((event) => {
      const row = event as JsonObject;
      return { seq: row.seq, at: row.at, kind: row.kind, data: truncate(row.data, 200) };
    }),
  } as ToolOutcome<Record<string, unknown>>;
}

function compactWakes(outcome: ToolOutcome<unknown>, verbose: boolean): ToolOutcome<unknown> {
  if (verbose || !outcome.ok) return outcome;
  const source = outcome as unknown as JsonObject;
  if (!Array.isArray(source.wakes)) return outcome;
  return {
    ok: true,
    wakes: source.wakes.map((wake) => {
      const row = wake as JsonObject;
      const detail = row.summary ?? row.data ?? '';
      if (row.kind === 'ask') return truncate(detail, 2000);
      return truncate(`${String(row.kind ?? 'wake')} ${String(row.workerId ?? '').trim()} ${truncate(detail, 130)}`.replace(/\s+/g, ' ').trim(), 160);
    }),
  } as ToolOutcome<Record<string, unknown>>;
}

function compactGate(outcome: ToolOutcome<unknown>, verbose: boolean): ToolOutcome<unknown> {
  if (verbose || !outcome.ok) return outcome;
  const source = outcome as JsonObject;
  const checks = Array.isArray(source.checks) ? source.checks : undefined;
  return {
    ok: true,
    ...(source.head === undefined ? {} : { head: source.head }),
    ...(source.passed === undefined ? {} : { passed: source.passed }),
    ...(source.queued === undefined ? {} : { queued: source.queued }),
    ...(source.gateId === undefined ? {} : { gateId: source.gateId }),
    ...(checks ? { checks: checks.map((check) => {
      const row = check as JsonObject;
      return { name: row.name, exitCode: row.exitCode, outputPath: row.outputPath, durationMs: row.durationMs };
    }) } : {}),
  };
}

function compactPr(outcome: ToolOutcome<unknown>, verbose: boolean): ToolOutcome<unknown> {
  if (verbose || !outcome.ok) return outcome;
  const source = outcome as JsonObject;
  return {
    ok: true,
    ...(source.number === undefined ? {} : { number: source.number }),
    ...(source.url === undefined ? {} : { url: source.url }),
    ...(source.head === undefined ? {} : { head: source.head }),
    ...(source.updated === undefined ? {} : { updated: source.updated }),
  };
}

function compactRunStatus(outcome: ToolOutcome<unknown>, verbose: boolean): ToolOutcome<unknown> {
  if (verbose || !outcome.ok) return outcome;
  const source = outcome as JsonObject;
  const keys = ['spendUsd', 'spendCapUsd', 'spendWarnUsd', 'aboveSoftCap', 'activeWorkers', 'maxWorkers', 'unknownCostEvents', 'warning'];
  return { ok: true, ...Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])) };
}

function compactOutcome(name: string, input: unknown, outcome: ToolOutcome<unknown>): ToolOutcome<unknown> {
  const verbose = Boolean(input && typeof input === 'object' && (input as JsonObject).verbose === true);
  if (verbose) return outcome;
  switch (name) {
    case 'worker.list': return compactList(outcome, false);
    case 'worker.inspect': return compactInspect(outcome, false);
    case 'wake.list': return compactWakes(outcome, false);
    case 'gate.run': return compactGate(outcome, false);
    case 'pr.open': return compactPr(outcome, false);
    case 'run.status': return compactRunStatus(outcome, false);
    default: return outcome;
  }
}

function compactZodSchema(value: unknown, required: boolean): z.ZodType {
  if (!value || typeof value !== 'object') return z.unknown();
  const source = value as JsonObject;
  let schema: z.ZodType;
  if (source.enum && Array.isArray(source.enum) && source.enum.every((item) => typeof item === 'string')) {
    const values = source.enum as [string, ...string[]];
    schema = z.enum(values);
  } else if (source.type === 'object' && source.properties && typeof source.properties === 'object') {
    const requiredFields = new Set(Array.isArray(source.required) ? source.required.filter((item): item is string => typeof item === 'string') : []);
    const shape = Object.fromEntries(Object.entries(source.properties as JsonObject).map(([key, child]) => [key, compactZodSchema(child, requiredFields.has(key) && !(child && typeof child === 'object' && 'default' in child))]));
    schema = z.object(shape).strict();
  } else if (source.type === 'array') {
    schema = z.array(compactZodSchema(source.items, true));
  } else if (source.type === 'string') schema = z.string();
  else if (source.type === 'integer') schema = z.number().int();
  else if (source.type === 'number') schema = z.number();
  else if (source.type === 'boolean') schema = z.boolean();
  else schema = z.unknown();
  return required ? schema : schema.optional();
}

export function compactInputValidator(schema: z.ZodObject): z.ZodObject {
  const json = z.toJSONSchema(schema) as JsonObject;
  const required = new Set(Array.isArray(json.required) ? json.required.filter((item): item is string => typeof item === 'string') : []);
  const properties = json.properties && typeof json.properties === 'object' ? json.properties as JsonObject : {};
  const shape = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, compactZodSchema(value, required.has(key) && !(value && typeof value === 'object' && 'default' in value))]));
  return z.object(shape).strict();
}

function compactJsonSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactJsonSchemaValue);
  if (!value || typeof value !== 'object') return value;
  const source = value as JsonObject;
  const result: JsonObject = {};
  if (source.type !== undefined) result.type = source.type;
  if (Array.isArray(source.enum)) result.enum = source.enum;
  if (source.properties && typeof source.properties === 'object') {
    const properties = source.properties as JsonObject;
    result.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, compactJsonSchemaValue(child)]));
    const required = Array.isArray(source.required)
      ? source.required.filter((key): key is string => {
        if (typeof key !== 'string') return false;
        const child = properties[key];
        return !(child && typeof child === 'object' && 'default' in child);
      })
      : [];
    if (required.length) result.required = required;
  }
  if (source.items !== undefined) result.items = compactJsonSchemaValue(source.items);
  for (const key of ['anyOf', 'oneOf']) if (source[key] !== undefined) result[key] = compactJsonSchemaValue(source[key]);
  return result;
}

export function compactInputSchema(schema: z.ZodObject): Record<string, unknown> {
  return compactJsonSchemaValue(z.toJSONSchema(schema)) as Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = [
  def('daemon.control', 'Inspect or change daemon lifecycle.', daemonInput, (h, i) => h.lifecycle.control(i)),
  def('budget.open', 'Open a project budget.', budgetOpenInput, (h, i) => h.budgetOpen(i)),
  def('budget.close', 'Close a project budget.', budgetCloseInput, (h, i) => h.budgetClose(i)),
  def('budget.status', 'List project budget status.', budgetStatusInput, (h, i) => h.budgetStatus(i)),
  def('envelope.get', 'Read a project autonomy envelope.', envelopeGetInput, (h, i) => h.envelopeGet(i)),
  def('envelope.check', 'Check actions against project rules.', envelopeCheckInput, (h, i) => h.envelopeCheck(i)),
  def('tap.request', 'Request a one-time human approval code.', tapRequestInput, (h, i) => h.tapRequest(i)),
  def('tap.confirm', 'Confirm a one-time human approval code.', tapConfirmInput, (h, i) => h.tapConfirm(i)),
  def('worker.spawn', 'Start an isolated worker.', spawnInput, (h, i) => h.spawn(i)),
  def('worker.inspect', 'Inspect worker state and recent activity.', inspectInput, (h, i) => h.inspect(i)),
  def('worker.list', 'List workers by repository or state.', listInput, (h, i) => h.list(i)),
  def('worker.wait', 'Wait for workers to settle.', waitInput, (h, i) => h.wait(i)),
  def('worker.steer', 'Send a follow-up turn to a worker.', steerInput, (h, i) => h.steer(i)),
  def('worker.retry', 'Retry a named worker failure.', retryInput, (h, i) => h.retryWorker(i)),
  def('worker.stop', 'Stop a worker at its next turn boundary.', stopInput, (h, i) => h.stop(i)),
  def('gate.run', 'Run checks against a worker commit.', gateInput, (h, i) => h.gate(i)),
  def('gate.baseline', 'Run and record a red baseline.', baselineInput, (h, i) => h.baseline(i)),
  def('claims.check', 'Check worker claims against its diff.', claimsCheckInput, (h, i) => h.claimsCheck(i)),
  def('pr.open', 'Open a PR after an exact-head passing gate.', prOpenInput, (h, i) => h.prOpen(i)),
  def('pr.status', 'Get PR state and checks.', prStatusInput, (h, i) => h.prStatus(i)),
  def('review.request', 'Review an open PR.', reviewInput, (h, i) => h.reviewRequest(i)),
  def('review.record', 'Record an exact-head review verdict.', reviewRecordInput, (h, i) => h.reviewRecord(i)),
  def('run.status', 'Get spend, caps, and worker capacity.', runStatusInput, (h) => h.runStatus()),
  def('routing.check', 'Probe configured routing candidates.', routingCheckInput, (h) => h.routingCheckNow()),
  def('spend.set', 'Update spend caps and worker limits.', spendSetInput, (h, i) => h.spendSet(i)),
  def('pr.merge', 'Merge a verified exact-head PR.', prMergeInput, (h, i) => h.prMerge(i)),
  def('inbox.list', 'List open worker questions.', inboxListInput, (h, i) => h.inboxList(i)),
  def('inbox.reply', 'Answer a worker question.', inboxReplyInput, (h, i) => h.inboxReply(i)),
  def('notify.owner', 'Notify the operator about a project.', notifyOwnerInput, (h, i) => h.notifyOwner(i)),
  def('notify.nick', 'Alias of notify.owner.', notifyOwnerInput, (h, i) => h.notifyOwner(i)),
  def('supervisor.register', 'Register a project supervisor.', supervisorRegisterInput, (h, i) => h.supervisorRegister(i)),
  def('supervisor.list', 'List registered supervisors.', supervisorListInput, (h) => h.supervisorList()),
  def('wake.list', 'List project supervisor wakes.', wakeListInput, (h, i) => h.wakeList(i)),
  def('supervisor.rotate', 'Queue a supervisor startup wake.', supervisorRotateInput, (h, i) => h.supervisorRotate(i)),
  def('jev.check', 'Run a bounded Jev judgement.', jevCheckInput, (h, i) => h.jevCheck(i)),
  def('jev.label', 'Label a Jev call.', jevLabelInput, (h, i) => h.jevLabel(i)),
  def('memory.write', 'Write a local memory page.', memoryWriteInput, (h, i) => h.memoryWrite(i)),
  def('memory.log', 'Append a dated memory entry.', memoryLogInput, (h, i) => h.memoryLog(i)),
  def('memory.list', 'List local memory pages.', memoryListInput, (h, i) => h.memoryList(i)),
  def('scorecard.export', 'Export a project scorecard.', scorecardExportInput, (h, i) => h.scorecardExport(i)),
  def('merge.enqueue', 'Queue a pull request for merge.', mergeEnqueueInput, (h, i) => h.mergeEnqueue(i)),
  def('merge.queue', 'List queued pull requests.', mergeQueueInput, (h, i) => h.mergeQueue(i)),
  def('merge.dequeue', 'Remove a queued pull request.', mergeDequeueInput, (h, i) => h.mergeDequeue(i)),
  def('deploy.run', 'Deploy a SHA and run smoke checks.', deployRunInput, (h, i) => h.deployRun(i)),
  def('deploy.status', 'List recorded deployments.', deployStatusInput, (h, i) => h.deployStatus(i)),
  def('deploy.rollback', 'Roll back a production deployment.', deployRollbackInput, (h, i) => h.deployRollback(i)),
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

export function createToolRegistry(helm: Helm, profile: ToolProfile = 'all', compactResponses = false): {
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
        const outcome = await tool.call(helm, parsed.data as never) as ToolOutcome<Record<string, unknown>>;
        return (compactResponses ? compactOutcome(name, parsed.data, outcome) : outcome) as ToolOutcome<Record<string, unknown>>;
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally { release?.(); }
    },
  };
}
