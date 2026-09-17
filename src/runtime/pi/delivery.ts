import type { RawArtifactRef } from '../../contracts/index.js';
import { utcTimestampSchema } from '../../contracts/index.js';
import { z } from 'zod/v3';

/**
 * A provider error is useful only as a delivery observation.  It says nothing
 * about remote billing or a usable worker result, so the receipt intentionally
 * contains no provider response bytes and keeps billing unknown.
 */
export const piModelDeliveryFailureReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('pi.model.delivery.failure'),
  modelCommandId: z.string().min(1),
  effectId: z.string().min(1),
  parentCommandId: z.string().min(1),
  attemptId: z.string().min(1),
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  api: z.string().min(1),
  streamEnded: z.literal(true),
  billing: z.literal('unknown'),
  observedAt: utcTimestampSchema,
}).strict();
export type PiModelDeliveryFailureReceipt = z.infer<typeof piModelDeliveryFailureReceiptSchema>;
export type PiModelDeliveryFailureProof = Readonly<{
  receipt: PiModelDeliveryFailureReceipt;
  receiptRef: RawArtifactRef;
}>;

/** A separate proof for a host-admitted local stop. */
export const piStoppedReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('pi.worker.stop'),
  commandId: z.string().min(1),
  attemptId: z.string().min(1),
  sessionId: z.string().min(1),
  stopped: z.literal(true),
  observedAt: utcTimestampSchema,
}).strict();
export type PiStoppedReceipt = z.infer<typeof piStoppedReceiptSchema>;

export function parsePiModelDeliveryFailureReceipt(value: unknown): PiModelDeliveryFailureReceipt {
  return piModelDeliveryFailureReceiptSchema.parse(value);
}
