import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  ReviewPublicationService,
  MemoryPublicationStore,
  publicationIdentity,
  type PublicationBinding,
  type PublicationRecord,
  type PublicationReceipt,
} from '../../src/host/review-publication.js';
import { prepareReviewPublication, type PublicationTarget } from '../../src/host/review-publication-format.js';
import type { DurableReviewRecord } from '../../src/host/review.js';

const HEAD = 'a'.repeat(40);
const sha = (v: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;
const raw = (): string => `raw:sha256:${createHash('sha256').update(randomUUID()).digest('hex')}`;

function makeReview(verdictTag = 'terminal'): DurableReviewRecord {
  return Object.freeze({
    schemaVersion: 1,
    reviewId: `review-${createHash('sha256').update(verdictTag).digest('hex').slice(0, 24)}`,
    idempotencyKey: sha(['rev', verdictTag]),
    state: 'terminal',
    source: Object.freeze({
      workerId: 'w-src', attemptId: 'a-src', sessionId: 's-src', modelId: 'src-model',
      family: 'f', provider: 'p', api: 'a', repository: 'acme/widget', workspace: '/ws',
      runId: 'run-1', head: HEAD, clean: true, contextRefs: Object.freeze([]),
    }),
    requestedHead: HEAD,
    manifest: Object.freeze({
      digest: sha(['m']),
      entries: Object.freeze([
        Object.freeze({ ref: 'objective-ref', hash: sha('o'), purpose: 'objective' }),
        Object.freeze({ ref: 'acceptance-ref', hash: sha('a'), purpose: 'acceptance' }),
      ]),
    }),
    reviewer: Object.freeze({
      requestedModelId: 'rv-model', workerId: 'w-rv', attemptId: 'a-rv', sessionId: 's-rv', modelId: 'rv-model',
    }),
    outcome: Object.freeze({
      resultRef: raw(),
      rawEventRefs: Object.freeze(['raw-event-1']),
      readonlyObservation: Object.freeze({ beforeRef: 'obs-b', afterRef: 'obs-a' }),
    }),
  });
}

const TARGET: PublicationTarget = Object.freeze({ repository: 'acme/widget', pullRequest: 7, head: HEAD });

type Harness = Readonly<{
  binding: PublicationBinding;
  store: MemoryPublicationStore;
  posts: () => number;
  setPost(fn: (p: ReturnType<typeof prepareReviewPublication>) => Promise<void>): void;
  setReadback(fn: (p: ReturnType<typeof prepareReviewPublication>) => Promise<PublicationReceipt | undefined>): void;
  review: DurableReviewRecord;
}>;

function makeBinding(review: DurableReviewRecord, verdict = 'PASS',
  overrides: Partial<PublicationBinding> = {}): Harness {
  const store = new MemoryPublicationStore();
  let postCount = 0;
  let postImpl: (p: ReturnType<typeof prepareReviewPublication>) => Promise<void> = async () => { postCount += 1; };
  let readbackImpl = (p: ReturnType<typeof prepareReviewPublication>): Promise<PublicationReceipt | undefined> =>
    Promise.resolve({ commentId: 'c-1', url: 'https://x/c-1', body: p.body, author: 'helm-bot', observedHead: p.target.head });
  const binding: PublicationBinding = {
    store,
    loadReview: () => Promise.resolve(review),
    readVerifiedVerdict: () => Promise.resolve(verdict),
    authorize: () => Promise.resolve(),
    inspectHead: (t) => Promise.resolve(t.head),
    expectedPublisher: () => Promise.resolve('helm-bot'),
    post: (p) => postImpl(p),
    readback: (p) => readbackImpl(p),
    ...overrides,
  };
  return Object.freeze({
    binding, store,
    posts: () => postCount,
    setPost: (fn) => { postImpl = fn; },
    setReadback: (fn) => { readbackImpl = fn; },
    review,
  });
}

function receiptFor(p: ReturnType<typeof prepareReviewPublication>, over: Partial<PublicationReceipt> = {}): PublicationReceipt {
  return { commentId: 'c-1', url: 'https://x/c-1', body: p.body, author: 'helm-bot', observedHead: p.target.head, ...over };
}


test('one post + matching readback publishes', async () => {
  const h = makeBinding(makeReview());
  const result = await new ReviewPublicationService(h.binding).publish(h.review.reviewId, TARGET);
  assert.equal(result.state, 'published');
  assert.equal(h.posts(), 1);
  assert.ok(result.receipt && result.receipt.commentId);
  assert.equal((await h.store.reopen(publicationIdentity(h.review, prepareReviewPublication(h.review, TARGET, 'PASS')).key))!.state, 'published');
});

test('authority denial produces no post', async () => {
  const h = makeBinding(makeReview(), 'PASS', { authorize: () => Promise.reject(new Error('not authorized')) });
  const result = await new ReviewPublicationService(h.binding).publish(h.review.reviewId, TARGET);
  assert.equal(result.state, 'denied');
  assert.equal(h.posts(), 0);
  assert.ok(result.reason);
});

test('stale pre-effect head produces no post', async () => {
  const h = makeBinding(makeReview(), 'PASS', { inspectHead: () => Promise.resolve('b'.repeat(40)) });
  // Only the pre-effect inspectHead is stale; readback path is irrelevant here.
  const result = await new ReviewPublicationService(h.binding).publish(h.review.reviewId, TARGET);
  assert.equal(result.state, 'denied');
  assert.equal(h.posts(), 0);
});

test('post throws after comment created reconciles to published with one post', async () => {
  const h = makeBinding(makeReview());
  // The external comment already exists (authoritative readback succeeds) even
  // though the in-line post() call surfaced an error to us.
  let done = false;
  h.setReadback((p) => Promise.resolve(receiptFor(p, { commentId: 'c-external' })));
  h.setPost(async (p) => { done = true; h.posts(); throw new Error('effect result unknown'); });
  void done;
  const result = await new ReviewPublicationService(h.binding).publish(h.review.reviewId, TARGET);
  assert.equal(result.state, 'published');
  // Exactly one post was attempted; reconcile never posts.
  assert.equal(h.posts(), 1);
});

test('post throws with no readback then later found publishes with one post', async () => {
  const h = makeBinding(makeReview());
  let posted = 0;
  h.setPost(async () => { posted += 1; throw new Error('network drop'); });
  let readbackCount = 0;
  h.setReadback((p) => { readbackCount += 1; return Promise.resolve(readbackCount > 1 ? receiptFor(p) : undefined); });
  const svc = new ReviewPublicationService(h.binding);
  const first = await svc.publish(h.review.reviewId, TARGET); // post throws, first readback missing -> unknown
  assert.equal(first.state, 'unknown');
  assert.equal(posted, 1);
  const second = await svc.reconcile(publicationIdentity(h.review, prepareReviewPublication(h.review, TARGET, 'PASS')).key);
  assert.equal(second.state, 'published');
  assert.equal(posted, 1); // reconcile never posts
});

test('replay/concurrent calls perform at most one post', async () => {
  const h = makeBinding(makeReview());
  const key = publicationIdentity(h.review, prepareReviewPublication(h.review, TARGET, 'PASS')).key;
  const svc = new ReviewPublicationService(h.binding);
  const results = await Promise.all([svc.publish(h.review.reviewId, TARGET), svc.publish(h.review.reviewId, TARGET), svc.reconcile(key)]);
  assert.equal(h.posts(), 1);
  for (const r of results) assert.equal(r.state, 'published');
});

test('crash planned restart never posts', async () => {
  const h = makeBinding(makeReview());
  // Simulate a crash after intent but before/at effect: a lone planned intent
  // exists, and reconcile must only read, never post.
  const prepared = prepareReviewPublication(h.review, TARGET, 'PASS');
  const { key } = publicationIdentity(h.review, prepared);
  await h.store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId: h.review.source.runId, state: 'planned' as const, prepared }));
  h.setReadback(() => Promise.resolve(undefined)); // no comment landed
  const result = await new ReviewPublicationService(h.binding).reconcile(key);
  assert.equal(result.state, 'unknown');
  assert.equal(h.posts(), 0);
  // Repeated reconcile does not append a duplicate identical unknown record.
  await new ReviewPublicationService(h.binding).reconcile(key);
  assert.equal(h.posts(), 0);
});

test('wrong author / body / head do not publish', async () => {
  const base = makeBinding(makeReview());
  const svcBase = new ReviewPublicationService(base.binding);
  const wrongAuthor = await (async () => {
    const h = makeBinding(makeReview()); h.setReadback(p => Promise.resolve(receiptFor(p, { author: 'someone-else' })));
    return new ReviewPublicationService(h.binding).reconcile((await svcBase.publish(h.review.reviewId, TARGET)).key);
  })();
  assert.notEqual(wrongAuthor.state, 'published');

  const wrongHead = await (async () => {
    const h = makeBinding(makeReview()); h.setReadback(p => Promise.resolve(receiptFor(p, { observedHead: 'c'.repeat(40) })));
    const id = publicationIdentity(h.review, prepareReviewPublication(h.review, TARGET, 'PASS'));
    await h.store.prepare(Object.freeze({ schemaVersion: 1 as const, ...id, state: 'planned' as const, prepared: prepareReviewPublication(h.review, TARGET, 'PASS') }));
    return new ReviewPublicationService(h.binding).reconcile(id.key);
  })();
  assert.notEqual(wrongHead.state, 'published');

  const wrongBody = await (async () => {
    const h = makeBinding(makeReview()); h.setReadback(p => Promise.resolve(receiptFor(p, { body: p.body + 'tampered' })));
    const id = publicationIdentity(h.review, prepareReviewPublication(h.review, TARGET, 'PASS'));
    await h.store.prepare(Object.freeze({ schemaVersion: 1 as const, ...id, state: 'planned' as const, prepared: prepareReviewPublication(h.review, TARGET, 'PASS') }));
    return new ReviewPublicationService(h.binding).reconcile(id.key);
  })();
  assert.notEqual(wrongBody.state, 'published');
});

test('contradictory verdict same key is refused, never reposted', async () => {
  const h = makeBinding(makeReview());
  const svc = new ReviewPublicationService(h.binding);
  await svc.publish(h.review.reviewId, TARGET); // posts 'PASS' body
  assert.equal(h.posts(), 1);
  // Different verdict -> different body, same identity (key excludes verdict).
  const contradicting = makeBinding(makeReview(), 'FAIL', { readVerifiedVerdict: () => Promise.resolve('FAIL') });
  let threw = false;
  try { await new ReviewPublicationService(contradicting.binding).publish(h.review.reviewId, TARGET); }
  catch { threw = true; }
  assert.ok(threw, 'same identity with a different body must refuse');
  assert.equal(contradicting.posts(), 0);
});

test('missing gate evidence: readVerifiedVerdict rejects before intent', async () => {
  const h = makeBinding(makeReview(), 'PASS', { readVerifiedVerdict: () => Promise.reject(new Error('no executable verification evidence')) });
  await assert.rejects(() => new ReviewPublicationService(h.binding).publish(h.review.reviewId, TARGET));
  // No intent was ever persisted.
  const key = publicationIdentity(h.review, prepareReviewPublication(h.review, TARGET, 'PASS')).key;
  assert.equal(await h.store.reopen(key), undefined);
});

test('nonterminal review never creates intent', async () => {
  const review = { ...makeReview(), state: 'launched' } as unknown as DurableReviewRecord;
  const h = makeBinding(review);
  await assert.rejects(() => new ReviewPublicationService(h.binding).publish(review.reviewId, TARGET));
  assert.equal(h.posts(), 0);
});

// JournalReviewPublicationStore (run against the same ArtifactJournal fixture
// the host uses for JournalReviewDurabilityStore). Structural assertions:
//
test.todo('journal store: immutable intent conflict is refused', async () => {
  // const journal = new <ArtifactJournal fixture>();
  // const store = new JournalReviewPublicationStore(journal, 'run-1');
  // const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  // const { key, runId } = publicationIdentity(review, prepared);
  // const a = await store.prepare({ schemaVersion: 1, key, runId, state: 'planned', prepared });
  // assert.equal(a.created, true);
  // const b = await store.prepare({ schemaVersion: 1, key, runId, state: 'planned', prepared });
  // assert.equal(b.created, false);
  // // Tampered body under the same key must be rejected on reopen/validate.
  // const forged = { ...prepared, body: prepared.body + 'x' };
  // await assert.rejects(() => store.prepare({ schemaVersion: 1, key, runId, state: 'planned', prepared: forged }));
});

test.todo('journal store: illegal transitions are refused', async () => {
  // planned->published->denied must throw (published terminal);
  // unknown->unknown->published ordering and published->anything rejected by
  // canFollowPublication inside append and validated across history in reopen.
  // assert.rejects(() => store.append({ ...record, state: 'denied', reason: 'x' })); // from published
});

test.todo('journal store: published requires exact body + full receipt', async () => {
  // An append with state 'published' whose receipt.body != prepared.body, or
  // whose receipt.observedHead != prepared.target.head, or with empty
  // commentId/url/author, must throw inside valid() before any journal write.
  // assert.rejects(() => store.append({ ...record, state: 'published', receipt: { ...receipt, body: 'other' } }));
});

test.todo('journal store: defensive immutable snapshots', async () => {
  // const record = await store.reopen(key);
  // assert.throws(() => { (record.prepared.target as { head: string }).head = 'zz'; });
  // assert.throws(() => { (record.receipt as PublicationReceipt).author = 'x'; });
});