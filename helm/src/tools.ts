/** The tool registry: maps tool names to their zod input schemas and dispatches validated calls to a Helm instance. */
import type { z } from 'zod';
import {
  emptyInput,
  budgetCloseInput,
  budgetOpenInput,
  budgetStatusInput,
  daemonInput,
  gateInput,
  baselineInput,
  inspectInput,
  inboxListInput,
  inboxReplyInput,
  listInput,
  prMergeInput,
  prOpenInput,
  prStatusInput,
  reviewInput,
  spawnInput,
  steerInput,
  stopInput,
  waitInput,
  supervisorRegisterInput,
  supervisorListInput,
  wakeListInput,
  supervisorRotateInput,
  notifyNickInput,
  jevCheckInput,
  jevLabelInput,
  TOOL_NAMES,
  type ToolName,
  type ToolOutcome,
} from './types.js';
import { READ_TOOLS } from './lifecycle.js';
import type { Helm } from './helm.js';

type ToolDef = Readonly<{
  name: ToolName;
  description: string;
  inputSchema: z.ZodObject;
  call: (helm: Helm, input: never) => Promise<ToolOutcome<unknown>>;
}>;

// Cast each schema/handler pair once here so the table below stays readable; `call`'s
// input is validated against `inputSchema` before it is ever invoked.
function def<S extends z.ZodObject>(name: ToolName, description: string, inputSchema: S, call: (helm: Helm, input: z.infer<S>) => Promise<ToolOutcome<unknown>>): ToolDef {
  return { name, description, inputSchema, call: call as ToolDef['call'] };
}

const TOOLS: readonly ToolDef[] = [
  def('daemon.control', 'Inspect lifecycle, drain new work, resume admissions, safely stop an idle daemon, or apply a staged upgrade when idle. Draining refuses new mutations without replaying them.', daemonInput, (h, i) => h.lifecycle.control(i)),
  def('budget.open', 'Open a per-project sprint budget; opening one closes the previous budget for that project.', budgetOpenInput, (h, i) => h.budgetOpen(i)),
  def('budget.close', 'Close the open budget for a project.', budgetCloseInput, (h, i) => h.budgetClose(i)),
  def('budget.status', 'List project budgets with spend, remaining capacity, and attributed workers.', budgetStatusInput, (h, i) => h.budgetStatus(i)),
  def('worker.spawn', 'Start an isolated worker. Omit model for Codex subscription defaults; difficulty selects Luna effort. Explicit model overrides are honoured.', spawnInput, (h, i) => h.spawn(i)),
  def('worker.inspect', 'Get a worker\'s current state, spend, diff stat, result and recent events.', inspectInput, (h, i) => h.inspect(i)),
  def('worker.list', 'List workers, optionally filtered by repo and/or state, as one summary per worker.', listInput, (h, i) => h.list(i)),
  def('worker.wait', 'Block until any of the given workers leaves queued/running (to succeeded, failed, idle, waiting, stopped or interrupted) or the timeout passes. Use this instead of polling worker.inspect; if it returns timedOut, call it again.', waitInput, (h, i) => h.wait(i)),
  def('worker.steer', 'Send a follow-up message to an idle, waiting, succeeded, failed or interrupted worker to start another turn.', steerInput, (h, i) => h.steer(i)),
  def('worker.stop', 'Request a running worker to stop at the next turn boundary and wait briefly for it to settle.', stopInput, (h, i) => h.stop(i)),
  def('gate.run', 'Run the repo\'s checks (tests, lint, etc.) against a worker\'s current commit and record pass/fail.', gateInput, (h, i) => h.gate(i)),
  def('gate.baseline', 'Run a validator\'s acceptance test at its head and record a red baseline.', baselineInput, (h, i) => h.baseline(i)),
  def('pr.open', 'Push a worker\'s branch and open a pull request; requires a passing gate at the worker\'s current head.', prOpenInput, (h, i) => h.prOpen(i)),
  def('pr.status', 'Get a pull request\'s open/closed/merged state, mergeability, checks and reviews, by PR number or worker id.', prStatusInput, (h, i) => h.prStatus(i)),
  def('review.request', 'Review an open PR with an explicit model. Claude reviews are recorded with review.record.', reviewInput, (h, i) => h.reviewRequest(i)),
  def('run.status', 'Get overall spend, the spend cap, and how many worker slots are active out of the configured maximum.', emptyInput, (h) => h.runStatus()),
  def('pr.merge', 'Merge a pull request, but only if it is open, mergeable, at the exact expected head commit, and all checks passed.', prMergeInput, (h, i) => h.prMerge(i)),
  def('inbox.list', 'List open worker questions, optionally filtered by project or state.', inboxListInput, (h, i) => h.inboxList(i)),
  def('inbox.reply', 'Answer an open worker question and resume that worker on the same session.', inboxReplyInput, (h, i) => h.inboxReply(i)),
  def('notify.nick', 'Post an immediate project notification to Nick, rate-limited to once per minute.', notifyNickInput, (h, i) => h.notifyNick(i)),
  def('supervisor.register', 'Register or update the owner supervisor for a project.', supervisorRegisterInput, (h, i) => h.supervisorRegister(i)),
  def('supervisor.list', 'List registered project supervisors.', supervisorListInput, (h) => h.supervisorList()),
  def('wake.list', 'List unacknowledged supervisor wakes for a project, optionally acknowledging them.', wakeListInput, (h, i) => h.wakeList(i)),
  def('supervisor.rotate', 'Queue a compact command and the supervisor startup wake.', supervisorRotateInput, (h, i) => h.supervisorRotate(i)),
  def('jev.check', 'Run a bounded Jev judgement preset and record the call.', jevCheckInput, (h, i) => h.jevCheck(i)),
  def('jev.label', 'Label a recorded Jev call for calibration.', jevLabelInput, (h, i) => h.jevLabel(i)),
];

const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function createToolRegistry(helm: Helm): {
  list(): Array<{ name: ToolName; description: string; inputSchema: z.ZodObject }>;
  call(name: string, input: unknown): Promise<ToolOutcome<unknown>>;
} {
  return {
    list() {
      return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },
    async call(name, input) {
      const tool = BY_NAME.get(name);
      if (!tool) return { ok: false, reason: `unknown tool: ${name}` };
      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) return { ok: false, reason: `invalid input: ${parsed.error.message}` };
      let release: (() => void) | undefined;
      try {
        if (!READ_TOOLS.has(name)) release = helm.lifecycle?.admit(name);
        return await tool.call(helm, parsed.data as never);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally { release?.(); }
    },
  };
}

export { TOOL_NAMES };
