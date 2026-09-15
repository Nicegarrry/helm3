import { z } from 'zod/v3';
import { HelmToolRegistry, type HelmTool } from '../runtime/orchestrator/index.js';
import { createHostReadToolRegistry, type HostReadToolsOptions } from './tools.js';
import { PiWorkerFleet, type WorkerSpawnInput, type WorkerSteerInput } from './worker-fleet.js';

const ref = z.string().min(1).max(512);
const spawn = z.object({ objectiveRef: ref, acceptanceRef: ref, contextRefs: z.array(ref).max(32), modelId: z.string().min(1).max(128), role: z.string().min(1).max(64), label: z.string().min(1).max(128).optional() }).strict();
const inspect = z.object({ workerId: z.string().min(1).max(128) }).strict();
const steer = z.object({ workerId: z.string().min(1).max(128), objectiveRef: ref, evidenceRefs: z.array(ref).min(1).max(32), expectedSessionId: z.string().min(1).max(256), expectedHead: z.string().regex(/^[0-9a-f]{40}$/) }).strict();

/** Compose one registry for driver transports, operator reads and local CLI. */
export function createHostWorkerToolRegistry(reads: HostReadToolsOptions, fleet: PiWorkerFleet): HelmToolRegistry {
  const context = Object.freeze({ ...reads.context });
  const workerTools: HelmTool[] = [
    { name: 'worker.spawn', description: 'Durably register a host-owned Pi worker setup, then run it asynchronously.', input: spawn.shape,
      async execute(input, actual) {
        if (actual.runId !== context.runId || actual.sessionId !== context.sessionId || actual.mode !== 'primary') return { state: 'refused', reason: 'tool context is outside the trusted host binding' };
        try { await reads.authorize?.(actual); const value = await fleet.spawn(actual, spawn.parse(input) as WorkerSpawnInput); return { state: 'succeeded', value }; }
        catch { return { state: 'refused', reason: 'worker spawn was refused by trusted host authority' }; }
      } },
    { name: 'worker.inspect', description: 'Read a bounded durable worker projection and an honest live observation.', input: inspect.shape,
      async execute(input, actual) {
        if (actual.runId !== context.runId || actual.sessionId !== context.sessionId || actual.mode !== 'primary') return { state: 'refused', reason: 'tool context is outside the trusted host binding' };
        try { await reads.authorize?.(actual); return { state: 'succeeded', value: await fleet.inspect(actual, inspect.parse(input).workerId) }; }
        catch { return { state: 'unknown', reason: 'worker record is unavailable' }; }
      } },
    { name: 'worker.steer', description: 'Start one new, fenced follow-up invocation from a durably finished same Pi session.', input: steer.shape,
      async execute(input, actual) {
        if (actual.runId !== context.runId || actual.sessionId !== context.sessionId || actual.mode !== 'primary') return { state: 'refused', reason: 'tool context is outside the trusted host binding' };
        try { await reads.authorize?.(actual); return { state: 'succeeded', value: await fleet.steer(actual, steer.parse(input) as WorkerSteerInput) }; }
        catch { return { state: 'refused', reason: 'worker steer was refused by trusted host authority' }; }
      } },
    { name: 'worker.stop', description: 'Request a distinct, observed stop for a host-owned live Pi worker.', input: inspect.shape,
      async execute(input, actual) {
        if (actual.runId !== context.runId || actual.sessionId !== context.sessionId || actual.mode !== 'primary') return { state: 'refused', reason: 'tool context is outside the trusted host binding' };
        try { await reads.authorize?.(actual); return { state: 'succeeded', value: await fleet.stop(actual, inspect.parse(input).workerId) }; }
        catch { return { state: 'unknown', reason: 'worker stop outcome is unknown' }; }
      } },
  ];
  return new HelmToolRegistry([...createHostReadToolRegistry(reads).all(), ...workerTools]);
}
