import { createHash } from 'node:crypto';
import { z } from 'zod/v3';
import {
  type Command,
  type OrchestratorDriver,
  type OrchestratorLease,
  type Precondition,
  type Observation,
  utcTimestampSchema,
} from '../contracts/index.js';
import type {
  CommandRecord,
  EffectObservation,
  KernelEffect,
  TrustedExecutor,
} from '../core/index.js';
import { EventSupervisor, type Wake } from '../supervisor/index.js';
import type { HelmToolExecutionContext } from '../runtime/orchestrator/index.js';
import type { HostControlPlane } from './index.js';

const id = z.string().min(1).max(512);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const wakeDeliveryPayloadSchema = z.object({
  wake: z.object({
    runId: id,
    epoch: z.number().int().positive(),
    group: id,
    wakeId: id,
    causes: z.array(id).min(1).max(10000),
    evidenceRefs: z.array(id).max(1000),
  }).strict(),
  objectiveRef: z.string().min(1).max(8192),
  contextRefs: z.array(z.string().min(1).max(8192)).max(100),
}).strict();

export type WakeDeliveryPayload = z.infer<typeof wakeDeliveryPayloadSchema>;

export type HostWakeDispatcherBinding = Readonly<{
  host: HostControlPlane;
  driver: Pick<OrchestratorDriver, 'send_event' | 'invoke'>;
  commandFor(wake: Wake, owner: OrchestratorLease, payload: WakeDeliveryPayload): Command;
  executor: TrustedExecutor;
  claimExpiresAt(): string;
  readFact(pre: Precondition): Promise<Observation<boolean>>;
  verifyResult(resultRef: string, context: HelmToolExecutionContext): Promise<'succeeded' | 'failed' | 'unknown'>;
  now(): string;
}>;

export type DispatchOutcome = Readonly<{
  wakeId: string;
  state: 'handled' | 'unknown' | 'blocked';
  resultRef?: string;
}>;

export class HostWakeDispatcher {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly binding: HostWakeDispatcherBinding) {}

  dispatch(context: HelmToolExecutionContext): Promise<readonly DispatchOutcome[]> {
    const captured = Object.freeze({ ...context });
    const result = this.tail.then(() => this.dispatchInternal(captured));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async dispatchInternal(context: HelmToolExecutionContext): Promise<readonly DispatchOutcome[]> {
    if (context.mode !== 'primary') {
      return [];
    }

    const host = this.binding.host;
    const supervisorLog = host.supervisorLog();
    const supervisor = new EventSupervisor(supervisorLog, this.binding.now);

    const snapshot = await host.snapshot(context.runId);
    const currentOwner = snapshot.ownership;
    if (!currentOwner || currentOwner.sessionId !== context.sessionId || currentOwner.runId !== context.runId) {
      return [];
    }
    const currentEpoch = currentOwner.epoch;

    try {
      supervisorLog.assertCurrentOwner(currentOwner);
    } catch {
      return [];
    }

    const outcomes: DispatchOutcome[] = [];

    const existingWakeCommands = snapshot.commands.filter((cmd) => cmd.command.kind === 'orchestrator.wake');

    type CommandInfo = {
      record: CommandRecord;
      wake?: WakeDeliveryPayload['wake'];
      payload?: WakeDeliveryPayload;
    };

    const parsedExisting: CommandInfo[] = [];
    for (const rec of existingWakeCommands) {
      const parsed = wakeDeliveryPayloadSchema.safeParse(rec.command.payload);
      if (parsed.success) {
        parsedExisting.push({ record: rec, wake: parsed.data.wake, payload: parsed.data });
      } else {
        parsedExisting.push({ record: rec });
      }
    }

    const uncertainCauses = new Set<string>();
    for (const info of parsedExisting) {
      if (!info.wake) continue;
      const status = info.record.status;
      const cmdEpoch = info.wake.epoch;

      if (cmdEpoch !== currentEpoch) {
        for (const c of info.wake.causes) {
          uncertainCauses.add(c);
        }
      } else {
        if (['claimed', 'effect_started', 'observing', 'unknown', 'failed', 'refused'].includes(status)) {
          for (const c of info.wake.causes) {
            uncertainCauses.add(c);
          }
        }
      }
    }

    // Step 1: Recover already completed unacked commands BEFORE recomputing pending wakes
    for (const info of parsedExisting) {
      if (!info.wake) continue;
      const rec = info.record;
      if (rec.status !== 'succeeded') continue;
      const stillPending = supervisor.pending(currentOwner).some(wake => wake.causes.some(cause => info.wake!.causes.includes(cause)));
      if (!stillPending) continue;

      if (info.wake.runId !== context.runId || rec.command.runId !== context.runId) continue;
      if (rec.command.origin !== 'orchestrator' || rec.command.orchestratorLeaseId !== currentOwner.leaseId || rec.command.orchestratorEpoch !== currentEpoch) {
        continue;
      }
      if (info.wake.epoch !== currentEpoch) continue;

      const lastObs = rec.observations.length > 0 ? rec.observations[rec.observations.length - 1] : undefined;
      const resultRef = lastObs?.evidenceRefs?.[0];
      if (!resultRef) {
        for (const c of info.wake.causes) uncertainCauses.add(c);
        outcomes.push({ wakeId: info.wake.wakeId, state: 'unknown' });
        continue;
      }

      let verified: 'succeeded' | 'failed' | 'unknown';
      try {
        verified = await this.binding.verifyResult(resultRef, context);
      } catch {
        verified = 'unknown';
      }

      if (verified !== 'succeeded') {
        for (const c of info.wake.causes) uncertainCauses.add(c);
        outcomes.push({ wakeId: info.wake.wakeId, state: verified === 'failed' ? 'blocked' : 'unknown', resultRef });
        continue;
      }

      const originalWake: Wake = {
        runId: info.wake.runId,
        epoch: info.wake.epoch,
        group: info.wake.group,
        wakeId: info.wake.wakeId,
        causes: Object.freeze(info.wake.causes),
        evidenceRefs: Object.freeze(info.wake.evidenceRefs),
      };

      try {
        supervisorLog.assertCurrentOwner(currentOwner);
        supervisor.acknowledge(originalWake, currentOwner);
        outcomes.push({ wakeId: info.wake.wakeId, state: 'handled', resultRef });
      } catch {
        // If ack fails (e.g. causes already acknowledged or ownership changed), don't treat as newly handled
      }
    }

    // Step 2: Compute pending wakes
    let pendingWakes: readonly Wake[];
    try {
      pendingWakes = supervisor.recordWakes(currentOwner);
    } catch {
      return outcomes;
    }

    if (pendingWakes.length === 0) {
      return outcomes;
    }

    // Step 3: Process pending wakes
    for (const wake of pendingWakes) {
      const hasUncertainOverlap = wake.causes.some((cause) => uncertainCauses.has(cause));
      if (hasUncertainOverlap) {
        outcomes.push({ wakeId: wake.wakeId, state: 'unknown' });
        continue;
      }

      const expectedCommandId = `wake:${wake.wakeId}`;
      const existingInfo = parsedExisting.find((c) => c.record.command.commandId === expectedCommandId);

      if (existingInfo) {
        const st = existingInfo.record.status;
        if (['claimed', 'effect_started', 'observing', 'unknown', 'failed', 'refused'].includes(st)) {
          const outcomeState: 'unknown' | 'blocked' = st === 'refused' ? 'blocked' : 'unknown';
          outcomes.push({ wakeId: wake.wakeId, state: outcomeState });
          continue;
        }
        if (st === 'succeeded') {
          // Recovery above could not acknowledge; never call this handled.
          outcomes.push({ wakeId: wake.wakeId, state: 'unknown' });
          continue;
        }
      }

      let payload: WakeDeliveryPayload;
      let commandRecord: CommandRecord;

      if (existingInfo && existingInfo.record.status === 'queued' && existingInfo.payload) {
        payload = existingInfo.payload;
        commandRecord = existingInfo.record;
      } else {
        const artifacts = host.artifactsFor(context);
        const objectiveText = JSON.stringify(wake);
        const objectiveIdentity = `wake-objective:${wake.wakeId}`;
        const objectiveRef = await artifacts.writeText('supervisor.wake.objective', objectiveText, objectiveIdentity);

        payload = {
          wake: {
            runId: wake.runId,
            epoch: wake.epoch,
            group: wake.group,
            wakeId: wake.wakeId,
            causes: [...wake.causes],
            evidenceRefs: [...wake.evidenceRefs],
          },
          objectiveRef,
          contextRefs: [],
        };

        const command = this.binding.commandFor(wake, currentOwner, payload);
        if (
          command.kind !== 'orchestrator.wake' ||
          command.origin !== 'orchestrator' ||
          command.commandId !== expectedCommandId ||
          command.idempotencyKey !== expectedCommandId ||
          command.runId !== context.runId ||
          command.orchestratorLeaseId !== currentOwner.leaseId ||
          command.orchestratorEpoch !== currentEpoch
        ) {
          throw new Error('Command identity or envelope does not match expected wake authority');
        }

        const parsedCommandPayload = wakeDeliveryPayloadSchema.parse(command.payload);
        if (JSON.stringify(parsedCommandPayload) !== JSON.stringify(payload)) {
          throw new Error('Command payload does not match wake delivery payload');
        }

        try {
          commandRecord = host.admitOrchestrator(command, context, `wake-dispatcher:${wake.wakeId}`);
        } catch {
          outcomes.push({ wakeId: wake.wakeId, state: 'blocked' });
          continue;
        }
      }

      // Claim causes before send_event
      try {
        const plannedAtTime = utcTimestampSchema.parse(commandRecord.command.plannedAt);
        for (const cause of wake.causes) {
          const claimKey = hash([context.runId, cause]);
          supervisorLog.appendOwnedEvent({
            eventId: `wake-claim:${claimKey}`,
            schemaVersion: 1,
            kind: 'supervisor.wake_claim',
            source: 'helm.wake_dispatcher.claim',
            sourceEventId: claimKey,
            correlationId: `supervisor:${context.runId}`,
            occurredAt: plannedAtTime,
            recordedAt: plannedAtTime,
            sessionId: currentOwner.sessionId,
            payload: { commandId: commandRecord.command.commandId, runId: context.runId, cause },
          }, currentOwner);
        }
      } catch {
        outcomes.push({ wakeId: wake.wakeId, state: 'unknown' });
        continue;
      }

      const holder: { resultRef?: string; verificationStatus: 'succeeded' | 'failed' | 'unknown' } = {
        verificationStatus: 'unknown',
      };

      const effectId = `wake-effect:${wake.wakeId}`;
      const effect: KernelEffect = {
        effectId,
        execute: async () => {
          await this.binding.driver.send_event({
            sessionId: context.sessionId,
            eventRef: payload.objectiveRef,
          });

          const freshSnapshot = await host.snapshot(context.runId);
          const freshOwner = freshSnapshot.ownership;
          if (
            !freshOwner ||
            freshOwner.runId !== currentOwner.runId ||
            freshOwner.sessionId !== currentOwner.sessionId ||
            freshOwner.epoch !== currentOwner.epoch ||
            freshOwner.leaseId !== currentOwner.leaseId
          ) {
            throw new Error('Orchestrator ownership lease changed or inactive');
          }

          supervisorLog.assertCurrentOwner(currentOwner);
          const currentTs = utcTimestampSchema.parse(this.binding.now());
          const currentMs = Date.parse(currentTs);

          if (currentMs < Date.parse(freshOwner.issuedAt) || currentMs >= Date.parse(freshOwner.expiresAt)) {
            throw new Error('Orchestrator ownership lease has expired');
          }

          const leaseEntry = freshSnapshot.autonomyLeases.find((entry) => entry.lease.leaseId === commandRecord.command.leaseId);
          if (!leaseEntry) {
            throw new Error('Command autonomy lease not found in host snapshot');
          }
          if (leaseEntry.revoked) {
            throw new Error('Command autonomy lease has been revoked');
          }
          if (leaseEntry.lease.revision !== commandRecord.command.leaseRevision) {
            throw new Error('Command autonomy lease revision mismatch');
          }

          if (currentMs < Date.parse(leaseEntry.lease.issuedAt) || currentMs >= Date.parse(leaseEntry.lease.expiresAt)) {
            throw new Error('Command autonomy lease has expired');
          }
          if (currentMs < Date.parse(commandRecord.command.plannedAt)) {
            throw new Error('Current time precedes command plannedAt');
          }
          if (currentMs >= Date.parse(commandRecord.command.notAfter)) {
            throw new Error('Command notAfter has expired');
          }

          const invokeRes = await this.binding.driver.invoke({
            sessionId: context.sessionId,
            objectiveRef: payload.objectiveRef,
            contextRefs: [...payload.contextRefs],
          });

          holder.resultRef = invokeRes.resultRef;
        },
        observe: async (): Promise<EffectObservation> => {
          if (!holder.resultRef) {
            return {
              commandId: commandRecord.command.commandId,
              effectId,
              state: 'unknown',
              source: 'host.wake_dispatcher',
              observedAt: this.binding.now(),
              evidenceRefs: [],
            };
          }

          try {
            holder.verificationStatus = await this.binding.verifyResult(holder.resultRef, context);
          } catch {
            holder.verificationStatus = 'unknown';
          }

          return {
            commandId: commandRecord.command.commandId,
            effectId,
            state: holder.verificationStatus === 'succeeded' ? 'succeeded' : holder.verificationStatus === 'failed' ? 'failed' : 'unknown',
            source: 'host.wake_dispatcher',
            observedAt: this.binding.now(),
            evidenceRefs: [holder.resultRef],
          };
        },
      };

      let observation: EffectObservation;
      try {
        observation = await host.performAdmitted(
          commandRecord.command.commandId,
          this.binding.executor,
          this.binding.claimExpiresAt(),
          this.binding.readFact.bind(this.binding),
          effect,
        );
      } catch {
        outcomes.push({ wakeId: wake.wakeId, state: 'unknown' });
        continue;
      }

      if (observation.state === 'succeeded' && holder.verificationStatus === 'succeeded') {
        try {
          supervisorLog.assertCurrentOwner(currentOwner);
          supervisor.acknowledge(wake, currentOwner);
          outcomes.push({ wakeId: wake.wakeId, state: 'handled', resultRef: holder.resultRef });
        } catch {
          outcomes.push({ wakeId: wake.wakeId, state: 'unknown', resultRef: holder.resultRef });
        }
      } else {
        outcomes.push({
          wakeId: wake.wakeId,
          state: observation.state === 'failed' ? 'blocked' : 'unknown',
          resultRef: holder.resultRef,
        });
      }
    }

    return outcomes;
  }
}
