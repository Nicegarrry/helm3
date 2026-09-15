import { createRequire } from 'node:module';
import { z } from 'zod/v3';
import type { GateEvidence } from '../verification/index.js';

type Database = { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] }; close(): void };
const require = createRequire(__filename);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new(path: string, options?: { timeout?: number }) => Database };
const sha = z.string().regex(/^[0-9a-f]{40}$/);

export type TrustedReviewReceipt = Readonly<{ receiptId: string; pr: number; head: string; verdict: 'approved'; builder: Readonly<{ attemptId: string; sessionId: string; family: string }>; reviewer: Readonly<{ attemptId: string; sessionId: string; family: string }> }>;

/**
 * Privileged host storage for machine-produced gate evidence and review provenance.
 * It deliberately accepts attempt/session IDs, never GitHub reviewer/login strings.
 */
export class IntegrationEvidenceRegistry {
  private readonly db: Database;
  constructor(path: string) { this.db = new DatabaseSync(path, { timeout: 5_000 }); this.db.exec('CREATE TABLE IF NOT EXISTS integration_gates (ref TEXT PRIMARY KEY, pr INTEGER NOT NULL, head TEXT NOT NULL, bytes TEXT NOT NULL); CREATE TABLE IF NOT EXISTS integration_reviews (receipt_id TEXT PRIMARY KEY, pr INTEGER NOT NULL, head TEXT NOT NULL, bytes TEXT NOT NULL)'); }
  close(): void { this.db.close(); }
  recordGate(ref: string, pr: number, evidence: GateEvidence): void {
    if (!ref.trim() || !Number.isSafeInteger(pr) || pr < 1 || !sha.safeParse(evidence.expectedHead).success || evidence.state !== 'passed' || evidence.observedHead !== evidence.expectedHead || evidence.checks.some(check => check.exitCode !== 0 || check.signal || check.timedOut || check.outputLimit)) throw new Error('Gate evidence is not an exact successful machine record');
    this.db.prepare('INSERT INTO integration_gates(ref,pr,head,bytes) VALUES(?,?,?,?)').run(ref, pr, evidence.expectedHead, JSON.stringify(evidence));
  }
  recordReview(receipt: TrustedReviewReceipt): void {
    if (!receipt.receiptId.trim() || !Number.isSafeInteger(receipt.pr) || receipt.pr < 1 || !sha.safeParse(receipt.head).success || receipt.builder.attemptId === receipt.reviewer.attemptId || receipt.builder.sessionId === receipt.reviewer.sessionId || receipt.builder.family === receipt.reviewer.family) throw new Error('Review receipt lacks independent trusted provenance');
    this.db.prepare('INSERT INTO integration_reviews(receipt_id,pr,head,bytes) VALUES(?,?,?,?)').run(receipt.receiptId, receipt.pr, receipt.head, JSON.stringify(receipt));
  }
  acceptanceEvidence(pr: number, head: string): readonly { ref: string; head: string }[] { sha.parse(head); return (this.db.prepare('SELECT ref, head FROM integration_gates WHERE pr=? AND head=?').all(pr, head) as { ref: string; head: string }[]).map(row => Object.freeze({ ...row })); }
  reviewReceipts(pr: number, head: string): readonly TrustedReviewReceipt[] { sha.parse(head); return (this.db.prepare('SELECT bytes FROM integration_reviews WHERE pr=? AND head=?').all(pr, head) as { bytes: string }[]).map(row => Object.freeze(JSON.parse(row.bytes) as TrustedReviewReceipt)); }
}
