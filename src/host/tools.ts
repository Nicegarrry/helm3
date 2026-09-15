import { z } from 'zod/v3';
import type { EconomySnapshot } from '../economy/index.js';
import type { HostSnapshot } from './index.js';
import { HelmToolRegistry, type HelmTool, type HelmToolExecutionContext, type HelmToolResult } from '../runtime/orchestrator/index.js';
import type { GitHubMapSnapshot } from '../tracker/index.js';

/** A configured Brief reader is the only Brief source exposed to an orchestrator. */
export type BriefReader = Readonly<{ read(): Promise<Readonly<{ text: string; source: string; observedAt: string }>> }>;
export type HostReadToolsOptions = Readonly<{
  context: HelmToolExecutionContext;
  /** Host-owned session fence for a driver-generated session ID. */
  authorize?: (context: HelmToolExecutionContext) => Promise<void>;
  brief: BriefReader;
  host: Readonly<{ snapshot(runId: string): Promise<HostSnapshot>; readRunEvents(runId: string, limit: number): ReadonlyArray<SafeLogEvent> }>;
  map: Readonly<{ snapshot(): Promise<GitHubMapSnapshot> }>;
  economy: Readonly<{ snapshot(): EconomySnapshot }>;
}>;

/** Deliberately excludes event payloads, artifact refs, and any provider transcript. */
export type SafeLogEvent = Readonly<{
  eventId: string; kind: string; source: string; sourceEventId: string; occurredAt: string; recordedAt: string;
  commandId?: string; attemptId?: string; sessionId?: string;
}>;

function sameContext(actual: HelmToolExecutionContext, expected: HelmToolExecutionContext): boolean {
  return actual.runId === expected.runId && actual.sessionId === expected.sessionId && actual.mode === expected.mode;
}
async function refusedForContext(actual: HelmToolExecutionContext, expected: HelmToolExecutionContext, authorize?: (context: HelmToolExecutionContext) => Promise<void>): Promise<HelmToolResult | undefined> {
  if (actual.runId !== expected.runId || actual.mode !== expected.mode || (!authorize && !sameContext(actual, expected))) return { state: 'refused', reason: 'tool context is outside the trusted host binding' };
  if (actual.mode !== 'primary') return { state: 'refused', reason: 'consultant sessions cannot read the active run' };
  try { await authorize?.(actual); } catch { return { state: 'refused', reason: 'tool context is outside the trusted host binding' }; }
  return undefined;
}
function readTool<T>(expected: HelmToolExecutionContext, authorize: HostReadToolsOptions['authorize'], action: () => Promise<T>) {
  return async (_input: Record<string, unknown>, context: HelmToolExecutionContext): Promise<HelmToolResult> => {
    const refusal = await refusedForContext(context, expected, authorize); if (refusal) return refusal;
    try { return { state: 'succeeded', value: await action() }; }
    catch { return { state: 'unknown', reason: 'host read source is unavailable' }; }
  };
}

/**
 * Constructs the one host-owned read surface. Context and all data sources are
 * bound here; model supplied JSON can only select a bounded log page size.
 */
export function createHostReadToolRegistry(options: HostReadToolsOptions): HelmToolRegistry {
  const context = Object.freeze({ ...options.context });
  const tools: HelmTool[] = [
    {
      name: 'brief.get', description: 'Read the configured authoritative Brief.', input: {},
      execute: readTool(context, options.authorize, () => options.brief.read()),
    },
    {
      name: 'map.get', description: 'Read the current GitHub Map observation.', input: {},
      execute: readTool(context, options.authorize, () => options.map.snapshot()),
    },
    {
      name: 'log.query', description: 'Read a bounded, redacted page of events for this run.', input: { limit: z.number().int().min(1).max(100).optional() },
      async execute(input: Record<string, unknown>, actual: HelmToolExecutionContext): Promise<HelmToolResult> {
        const refusal = await refusedForContext(actual, context, options.authorize); if (refusal) return refusal;
        const limit = (input.limit as number | undefined) ?? 50;
        try { return { state: 'succeeded', value: { runId: context.runId, events: options.host.readRunEvents(context.runId, limit) } }; }
        catch { return { state: 'unknown', reason: 'host read source is unavailable' }; }
      },
    },
    {
      name: 'models.get', description: 'Read configured model facts and their source observation timestamps.', input: {},
      execute: readTool(context, options.authorize, async () => ({ models: options.economy.snapshot().models })),
    },
    {
      name: 'budget.get', description: 'Read run-local reservations and configured economy quota observations.', input: {},
      execute: readTool(context, options.authorize, async () => {
        const [host, economy] = await Promise.all([options.host.snapshot(context.runId), Promise.resolve().then(() => options.economy.snapshot())]);
        return {
          runId: context.runId,
          reservations: host.reservations,
          pools: economy.pools,
          quota: economy.quota,
          headroom: 'unknown',
          headroomReason: 'Run-local reservations and provider quota observations do not establish pool-wide remaining capacity.',
        };
      }),
    },
  ];
  return new HelmToolRegistry(tools);
}
