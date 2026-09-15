import { createHash } from 'node:crypto';
import type { ArtifactJournal } from '../journal/index.js';
export type ReviewContextPurpose = 'objective' | 'acceptance' | 'factual-context';
type Approval = Readonly<{ schemaVersion: 1; runId: string; ref: string; purpose: ReviewContextPurpose }>;
const prefix = 'host.review.context';
const key = (runId: string, ref: string, purpose: ReviewContextPurpose) => `${prefix}:${runId}:${purpose}:${createHash('sha256').update(ref).digest('hex')}`;
export class JournalReviewContextStore {
  constructor(private readonly journal: ArtifactJournal, private readonly runId: string) {}
  async approve(ref: string, purpose: ReviewContextPurpose): Promise<void> { if (!ref.trim()) throw new Error('review context ref is invalid'); const value: Approval = { schemaVersion: 1, runId: this.runId, ref, purpose }; await this.journal.append({ source: prefix, sourceIdentity: key(this.runId, ref, purpose), mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(value)), classification: 'sensitive' }, { permitSensitive: true }); }
  async assertApproved(ref: string, purpose: ReviewContextPurpose): Promise<void> { const entry = (await this.journal.metadata()).find(item => item.sourceIdentity === key(this.runId, ref, purpose)); if (!entry) throw new Error('review context ref is not host-approved for this purpose'); const value = JSON.parse((await this.journal.read(entry.raw, entry.sourceIdentity, { permitSensitive: true })).toString('utf8')) as Partial<Approval>; if (value.schemaVersion !== 1 || value.runId !== this.runId || value.ref !== ref || value.purpose !== purpose) throw new Error('review context approval is malformed'); }
}
