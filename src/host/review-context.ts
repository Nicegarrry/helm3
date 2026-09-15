import { createHash } from 'node:crypto';
import type { ArtifactJournal } from '../journal/index.js';
export type ReviewContextPurpose = 'objective' | 'acceptance' | 'factual-context';
type Approval = Readonly<{ schemaVersion: 1; runId: string; ref: string; purpose: ReviewContextPurpose; hash: string }>;
const prefix = 'host.review.context';
const key = (runId: string, ref: string, purpose: ReviewContextPurpose) => `${prefix}:${runId}:${purpose}:${createHash('sha256').update(ref).digest('hex')}`;
export class JournalReviewContextStore {
  constructor(private readonly journal: ArtifactJournal, private readonly runId: string, private readonly readArtifact: (ref: string) => Promise<string>) {}
  async approve(ref: string, purpose: ReviewContextPurpose): Promise<void> { if (!ref.trim()) throw new Error('review context ref is invalid'); const hash = createHash('sha256').update(await this.readArtifact(ref)).digest('hex'); const value: Approval = { schemaVersion: 1, runId: this.runId, ref, purpose, hash }; await this.journal.append({ source: prefix, sourceIdentity: key(this.runId, ref, purpose), mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(value)), classification: 'sensitive' }, { permitSensitive: true }); }
  async assertApproved(ref: string, purpose: ReviewContextPurpose, text: string): Promise<void> { const entry = (await this.journal.metadata()).find(item => item.sourceIdentity === key(this.runId, ref, purpose)); if (!entry) throw new Error('review context ref is not host-approved for this purpose'); const value = JSON.parse((await this.journal.read(entry.raw, entry.sourceIdentity, { permitSensitive: true })).toString('utf8')) as Partial<Approval>; const hash = createHash('sha256').update(text).digest('hex'); if (value.schemaVersion !== 1 || value.runId !== this.runId || value.ref !== ref || value.purpose !== purpose || value.hash !== hash) throw new Error('review context approval is malformed or stale'); }
}
