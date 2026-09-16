import type { Command } from '../contracts/index.js';
import type { ArtifactJournal } from '../journal/index.js';
import {
  PiNativeWorker,
  type PiAuthority,
  type PiWorkerInput,
} from '../runtime/pi/index.js';
import type { WorkerFleetBinding } from './worker-fleet.js';
import type { WorktreeReservation } from '../workspace/index.js';
import { BoundedPiAccess, type BoundedPiAccessPolicy } from '../access/index.js';

/** Trusted host factories that bind one fresh attempt/command to one fresh gate. */
export type BoundedFleetRuntimeInput = Readonly<{
  /** Supplies attemptId/owner/modelRuntime/etc. Called per invocation; never store it. */
  workerFor: (command: Command, workspace: WorktreeReservation) => Omit<PiWorkerInput, 'commandId' | 'workspace' | 'authority' | 'journal' | 'access'>;
  /** Mandatory finite bound; omission is never an unbounded fallback. */
  policyFor: (command: Command, workspace: WorktreeReservation) => BoundedPiAccessPolicy;
  /** Binds settlement + reservation to THIS gate instance for THIS command. */
  authorityFor: (command: Command, access: BoundedPiAccess) => PiAuthority;
  /** Host scopes the journal from THIS command; no cached last context. */
  journalFor: (command: Command) => ArtifactJournal;
}>;

function isFactory(fn: unknown): fn is (...args: never[]) => unknown {
  return typeof fn === 'function';
}

/**
 * Reusable live bounded runtime composition for a trusted WorkerFleetBinding.
 *
 * `start`/`rehydrate` each construct a NEW `BoundedPiAccess` bound to that
 * command's authority and journal. Per-invocation guards:
 *  - all four factories must be functions (rejected at creation);
 *  - a fresh attempt never shares request counters/settlements with another;
 *  - the same commandId may NOT be re-setup here (it refuses rather than reset
 *    that command's guard, including after native failure) - a new
 *    authority/command is required for a retry.
 * Duplicate protection here is process-local; durable command admission remains
 * the host/kernel responsibility. This factory does not grant authority.
 * Fork/compact stay the existing explicitly configured lifecycle surfaces.
 */
export function createBoundedFleetRuntime(
  input: BoundedFleetRuntimeInput,
): Pick<WorkerFleetBinding, 'start' | 'rehydrate'> {
  if (
    input === null || typeof input !== 'object' ||
    !isFactory(input.workerFor) || !isFactory(input.policyFor) ||
    !isFactory(input.authorityFor) || !isFactory(input.journalFor)
  ) {
    throw new Error('bounded fleet runtime requires workerFor, policyFor, authorityFor and journalFor factories');
  }

  const seenCommands = new Set<string>();

  const compose = (command: Command, workspace: WorktreeReservation): PiWorkerInput => {
    const commandId = command.commandId;
    if (typeof commandId !== 'string' || !commandId) throw new Error('command must carry a non-empty id');
    if (seenCommands.has(commandId)) {
      throw new Error('command already has a bounded guard; supply a new authority/command to retry');
    }
    seenCommands.add(commandId);
    const worker = input.workerFor(command, workspace);
    if (worker === null || typeof worker !== 'object') throw new Error('workerFor must return a Pi worker input');
    if (typeof worker.attemptId !== 'string' || worker.owner?.attemptId !== worker.attemptId) {
      throw new Error('worker attemptId must match owner.attemptId');
    }
    const policy = input.policyFor(command, workspace);
    const access = new BoundedPiAccess(policy);
    const model = worker.model;
    if (
      !model || model.provider !== access.policy.provider || model.id !== access.policy.model ||
      model.api !== access.policy.api || model.baseUrl !== access.policy.baseUrl ||
      model.contextWindow !== access.policy.contextWindow || typeof model.maxTokens !== 'number' || model.maxTokens < access.policy.maxBilledOutputTokens
    ) {
      throw new Error('bounded policy does not match the chosen model identity');
    }
    // Bind actual commandId and actual workspace LAST so caller fields cannot replace them.
    const bound: PiWorkerInput = {
      ...worker,
      authority: input.authorityFor(command, access),
      journal: input.journalFor(command),
      access,
      commandId,
      workspace,
    };
    return bound;
  };

  return {
    start: (command, workspace) => PiNativeWorker.start(compose(command, workspace)),
    rehydrate: (command, workspace, persisted) =>
      PiNativeWorker.rehydrate(compose(command, workspace), persisted),
  };
}
