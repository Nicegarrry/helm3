import { z } from 'zod/v3';
import { HelmToolRegistry, type HelmTool } from '../runtime/orchestrator/index.js';
import { createHostReadToolRegistry, type HostReadToolsOptions } from './tools.js';
import { IndependentReviewService, type ReviewRequest } from './review.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const request = z.object({ sourceWorkerId: z.string().min(1).max(128), expectedHead: sha, objectiveRef: z.string().min(1).max(512), acceptanceRef: z.string().min(1).max(512), contextRefs: z.array(z.string().min(1).max(512)).max(32), reviewerModelId: z.string().min(1).max(128) }).strict();

/** Adds only the high-level review request to the normal host read surface. */
export function createHostReviewToolRegistry(reads: HostReadToolsOptions, reviews: IndependentReviewService): HelmToolRegistry {
  const expected = Object.freeze({ ...reads.context });
  const tool: HelmTool = { name: 'review.request', description: 'Launch a host-validated independent read-only Pi review of a pinned worker head.', input: request.shape,
    async execute(input, actual) {
      if (actual.runId !== expected.runId || actual.sessionId !== expected.sessionId || actual.mode !== 'primary') return { state: 'refused', reason: 'tool context is outside the trusted host binding' };
      try { await reads.authorize?.(actual); return { state: 'succeeded', value: await reviews.request(request.parse(input) as ReviewRequest) }; }
      catch { return { state: 'refused', reason: 'review request was refused by trusted host authority' }; }
    } };
  return new HelmToolRegistry([...createHostReadToolRegistry(reads).all(), tool]);
}
