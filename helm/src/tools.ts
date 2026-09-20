/**
 * The tool registry: maps the eleven tool names to their zod input schemas and dispatches
 * validated calls to a Helm instance. Never throws; unknown tools and invalid input both
 * come back as { ok: false, reason }. See DESIGN.md.
 */
import type { z } from 'zod';
import {
  emptyInput,
  gateInput,
  inspectInput,
  listInput,
  prMergeInput,
  prOpenInput,
  prStatusInput,
  reviewInput,
  spawnInput,
  steerInput,
  stopInput,
  TOOL_NAMES,
  type ToolName,
  type ToolOutcome,
} from './types.js';
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
  def('worker.spawn', 'Start a new Pi worker in an isolated git worktree to work on an objective; returns the worker id, branch and worktree path.', spawnInput, (h, i) => h.spawn(i)),
  def('worker.inspect', 'Get a worker\'s current state, spend, diff stat, result and recent events.', inspectInput, (h, i) => h.inspect(i)),
  def('worker.list', 'List workers, optionally filtered by repo and/or state, as one summary per worker.', listInput, (h, i) => h.list(i)),
  def('worker.steer', 'Send a follow-up message to an idle, succeeded, failed or interrupted worker to start another turn.', steerInput, (h, i) => h.steer(i)),
  def('worker.stop', 'Request a running worker to stop at the next turn boundary and wait briefly for it to settle.', stopInput, (h, i) => h.stop(i)),
  def('gate.run', 'Run the repo\'s checks (tests, lint, etc.) against a worker\'s current commit and record pass/fail.', gateInput, (h, i) => h.gate(i)),
  def('pr.open', 'Push a worker\'s branch and open a pull request; requires a passing gate at the worker\'s current head.', prOpenInput, (h, i) => h.prOpen(i)),
  def('pr.status', 'Get a pull request\'s open/closed/merged state, mergeability, checks and reviews, by PR number or worker id.', prStatusInput, (h, i) => h.prStatus(i)),
  def('review.request', 'Spawn a reviewer worker to review an open pull request; it posts its findings as a PR comment when done.', reviewInput, (h, i) => h.reviewRequest(i)),
  def('run.status', 'Get overall spend, the spend cap, and how many worker slots are active out of the configured maximum.', emptyInput, (h) => h.runStatus()),
  def('pr.merge', 'Merge a pull request, but only if it is open, mergeable, at the exact expected head commit, and all checks passed.', prMergeInput, (h, i) => h.prMerge(i)),
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
      try {
        return await tool.call(helm, parsed.data as never);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export { TOOL_NAMES };
