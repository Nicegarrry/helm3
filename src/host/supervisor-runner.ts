import { setTimeout as delay } from 'node:timers/promises';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import type { HostControlPlane } from './index.js';
import type { PiWorkerFleet } from './worker-fleet.js';
import type { HostWakeDispatcher, DispatchOutcome } from './wake-dispatcher.js';
import type { SupervisorSignal } from '../supervisor/index.js';

export type HostSupervisorRunnerBinding = Readonly<{
  context: HelmToolExecutionContext;
  host: HostControlPlane;
  fleet: Pick<PiWorkerFleet, 'replaySupervisorEvents'>;
  wakeDispatcher: Pick<HostWakeDispatcher, 'dispatch'>;
  observe: (signal: AbortSignal) => Promise<readonly SupervisorSignal[]>;
  intervalMs: number;
}>;

export type SupervisorCycle = Readonly<{
  observedSignals: number;
  deliveries: readonly DispatchOutcome[];
  aborted: boolean;
}>;

export class HostSupervisorRunner {
  private readonly context: HelmToolExecutionContext;
  private readonly host: HostControlPlane;
  private readonly fleet: Pick<PiWorkerFleet, 'replaySupervisorEvents'>;
  private readonly wakeDispatcher: Pick<HostWakeDispatcher, 'dispatch'>;
  private readonly observe: (signal: AbortSignal) => Promise<readonly SupervisorSignal[]>;
  private readonly intervalMs: number;
  private tickQueue: Promise<SupervisorCycle> = Promise.resolve({ observedSignals: 0, deliveries: [], aborted: false });
  private isRunning = false;

  constructor(binding: HostSupervisorRunnerBinding) {
    if (!binding || !binding.context) {
      throw new Error('missing execution context');
    }
    const { context, host, fleet, wakeDispatcher, observe, intervalMs } = binding;
    if (context.mode !== 'primary') {
      throw new Error('HostSupervisorRunner requires primary execution context');
    }
    if (!context.runId || typeof context.runId !== 'string' || context.runId.trim() === '') {
      throw new Error('HostSupervisorRunner requires nonempty runId');
    }
    if (!context.sessionId || typeof context.sessionId !== 'string' || context.sessionId.trim() === '') {
      throw new Error('HostSupervisorRunner requires nonempty sessionId');
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) {
      throw new Error('HostSupervisorRunner intervalMs must be an integer between 100 and 60000');
    }
    if (typeof observe !== 'function') {
      throw new Error('observe capability is required');
    }
    if (!host || typeof host.createSupervisor !== 'function') {
      throw new Error('host capability is required');
    }
    if (!fleet || typeof fleet.replaySupervisorEvents !== 'function') {
      throw new Error('fleet replay capability is required');
    }
    if (!wakeDispatcher || typeof wakeDispatcher.dispatch !== 'function') {
      throw new Error('wakeDispatcher capability is required');
    }

    this.context = Object.freeze({ ...context });
    this.host = host;
    this.fleet = fleet;
    this.wakeDispatcher = wakeDispatcher;
    this.observe = observe;
    this.intervalMs = intervalMs;
  }

  tick(signal: AbortSignal): Promise<SupervisorCycle> {
    const nextTick = this.tickQueue.catch(() => {}).then(() => this.executeTick(signal));
    this.tickQueue = nextTick;
    return nextTick;
  }

  private async executeTick(signal: AbortSignal): Promise<SupervisorCycle> {
    if (signal?.aborted) {
      return { observedSignals: 0, deliveries: [], aborted: true };
    }

    await this.fleet.replaySupervisorEvents(this.context.runId);
    if (signal?.aborted) {
      return { observedSignals: 0, deliveries: [], aborted: true };
    }

    const rawSignals = await this.observe(signal);
    if (signal?.aborted) {
      return { observedSignals: 0, deliveries: [], aborted: true };
    }

    const cloned = structuredClone(rawSignals);
    for (const item of cloned) {
      if (!item || item.runId !== this.context.runId) {
        throw new Error(`foreign supervisor signal: expected runId ${this.context.runId}, got ${item?.runId}`);
      }
    }

    let observedSignals = 0;
    for (const item of cloned) {
      if (signal?.aborted) {
        return { observedSignals, deliveries: [], aborted: true };
      }
      await this.host.createSupervisor().process({ signal: item });
      observedSignals++;
    }

    if (signal?.aborted) {
      return { observedSignals, deliveries: [], aborted: true };
    }

    const deliveries = await this.wakeDispatcher.dispatch(this.context, signal);
    return {
      observedSignals,
      deliveries: Object.freeze([...deliveries]),
      aborted: signal?.aborted ?? false,
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.isRunning) {
      throw new Error('HostSupervisorRunner is already running on this instance');
    }
    if (signal?.aborted) {
      return;
    }

    this.isRunning = true;
    try {
      while (!signal.aborted) {
        await this.tick(signal);
        if (signal.aborted) break;
        try {
          await delay(this.intervalMs, undefined, { signal });
        } catch (err) {
          if (signal.aborted) {
            break;
          }
          throw err;
        }
      }
    } finally {
      this.isRunning = false;
    }
  }
}
