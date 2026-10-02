import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ReviewPublicationService,
  MemoryPublicationStore,
  publicationIdentity,
  type PublicationBinding,
  type PublicationRecord,
  type PublicationReceipt,
  type PublicationStore,
} from '../../src/host/review-publication.js';
import { prepareReviewPublication, type PreparedReviewPublication, type PublicationTarget } from '../../src/host/review-publication-format.js';
import type { DurableReviewRecord } from '../../src/host/review.js';
import { ArtifactJournal } from '../../src/journal/index.js';
import { JournalReviewPublicationStore } from '../../src/host/review-publication-store.js';

const HEAD = 'a'.repeat(40);
const sha = (v: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;
const rawFixed = (seed: string): string => `raw:sha256:${createHash('sha256').update(seed).digest('hex')}`;

function makeReview(seed = 'default-seed'): DurableReviewRecord {
  return Object.freeze({
    schemaVersion: 1,
    reviewId: `review-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`,
    idempotencyKey: sha(['rev', seed]),
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
      resultRef: rawFixed(seed),
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
  setPost(fn: (p: PreparedReviewPublication) => Promise<void>): void;
  setReadback(fn: (p: PreparedReviewPublication) => Promise<PublicationReceipt | undefined>): void;
  review: DurableReviewRecord;
}>;

function makeBinding(review: DurableReviewRecord, verdict = 'PASS',
  overrides: Partial<PublicationBinding> = {}): Harness {
  const store = new MemoryPublicationStore();
  let postCount = 0;
  let postImpl: (p: PreparedReviewPublication) => Promise<void> = async () => {};
  let readbackImpl = (p: PreparedReviewPublication): Promise<PublicationReceipt | undefined> =>
    Promise.resolve({ commentId: 'c-1', url: 'https://x/c-1', body: p.body, author: 'helm-bot', observedHead: p.target.head });
  const binding: PublicationBinding = {
    store,
    loadReview: (id: string) => id === review.reviewId ? Promise.resolve(review) : Promise.resolve(undefined as unknown as DurableReviewRecord),
    readVerifiedVerdict: () => Promise.resolve(verdict),
    authorize: () => Promise.resolve(),
    inspectHead: (t) => Promise.resolve(t.head),
    expectedPublisher: () => Promise.resolve('helm-bot'),
    post: (p) => { postCount += 1; return postImpl(p); },
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

function receiptFor(p: PreparedReviewPublication, over: Partial<PublicationReceipt> = {}): PublicationReceipt {
  return { commentId: 'c-1', url: 'https://x/c-1', body: p.body, author: 'helm-bot', observedHead: p.target.head, ...over };
}

function keyFor(review: DurableReviewRecord, verdict = 'PASS'): string {
  return publicationIdentity(review, prepareReviewPublication(review, TARGET, verdict)).key;
}

// ---------------------------------------------------------------------------
// MemoryPublicationStore harness tests
// ---------------------------------------------------------------------------

test('one post + matching readback publishes', async () => {
  const review = makeReview('t1');
  const h = makeBinding(review);
  const result = await new ReviewPublicationService(h.binding).publish(review.reviewId, TARGET);
  assert.equal(result.state, 'published');
  assert.equal(h.posts(), 1);
  assert.ok(result.receipt && result.receipt.commentId);
  assert.equal((await h.store.reopen(keyFor(review)))!.state, 'published');
});

test('authority denial produces no post', async () => {
  const review = makeReview('t2');
  const h = makeBinding(review, 'PASS', { authorize: () => Promise.reject(new Error('not authorized')) });
  const result = await new ReviewPublicationService(h.binding).publish(review.reviewId, TARGET);
  assert.equal(result.state, 'denied');
  assert.equal(h.posts(), 0);
  assert.ok(result.reason);
});

test('stale pre-effect head produces no post', async () => {
  const review = makeReview('t3');
  const h = makeBinding(review, 'PASS', { inspectHead: () => Promise.resolve('b'.repeat(40)) });
  const result = await new ReviewPublicationService(h.binding).publish(review.reviewId, TARGET);
  assert.equal(result.state, 'denied');
  assert.equal(h.posts(), 0);
});

test('post throws after comment created reconciles to published with one post', async () => {
  const review = makeReview('t4');
  const h = makeBinding(review);
  h.setReadback((p) => Promise.resolve(receiptFor(p, { commentId: 'c-external' })));
  h.setPost(async () => { throw new Error('effect result unknown'); });
  const result = await new ReviewPublicationService(h.binding).publish(review.reviewId, TARGET);
  assert.equal(result.state, 'published');
  assert.equal(h.posts(), 1);
});

test('post throws with no readback then later found publishes with one post', async () => {
  const review = makeReview('t5');
  const h = makeBinding(review);
  h.setPost(async () => { throw new Error('network drop'); });
  let readbackCount = 0;
  h.setReadback((p) => { readbackCount += 1; return Promise.resolve(readbackCount > 1 ? receiptFor(p) : undefined); });
  const svc = new ReviewPublicationService(h.binding);
  const first = await svc.publish(review.reviewId, TARGET);
  assert.equal(first.state, 'unknown');
  assert.equal(h.posts(), 1);
  const second = await svc.reconcile(keyFor(review));
  assert.equal(second.state, 'published');
  assert.equal(h.posts(), 1);
});

test('replay/concurrent calls perform at most one post', async () => {
  const review = makeReview('t6');
  const h = makeBinding(review);
  const svc = new ReviewPublicationService(h.binding);
  const [r1, r2] = await Promise.all([
    svc.publish(review.reviewId, TARGET),
    svc.publish(review.reviewId, TARGET),
  ]);
  const r3 = await svc.reconcile(keyFor(review));
  assert.equal(h.posts(), 1);
  for (const r of [r1, r2, r3]) assert.equal(r.state, 'published');
});

test('crash planned restart never posts', async () => {
  const review = makeReview('t7');
  const h = makeBinding(review);
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key } = publicationIdentity(review, prepared);
  await h.store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId: review.source.runId, state: 'planned' as const, prepared }));
  h.setReadback(() => Promise.resolve(undefined));
  const result = await new ReviewPublicationService(h.binding).reconcile(key);
  assert.equal(result.state, 'unknown');
  assert.equal(h.posts(), 0);
  const result2 = await new ReviewPublicationService(h.binding).reconcile(key);
  assert.equal(result2.state, 'unknown');
  assert.equal(h.posts(), 0);
});

test('wrong author does not publish', async () => {
  const review = makeReview('t8a');
  const h = makeBinding(review);
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key } = publicationIdentity(review, prepared);
  await h.store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId: review.source.runId, state: 'planned' as const, prepared }));
  h.setReadback(p => Promise.resolve(receiptFor(p, { author: 'someone-else' })));
  const result = await new ReviewPublicationService(h.binding).reconcile(key);
  assert.notEqual(result.state, 'published');
});

test('wrong head does not publish', async () => {
  const review = makeReview('t8b');
  const h = makeBinding(review);
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key } = publicationIdentity(review, prepared);
  await h.store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId: review.source.runId, state: 'planned' as const, prepared }));
  h.setReadback(p => Promise.resolve(receiptFor(p, { observedHead: 'c'.repeat(40) })));
  const result = await new ReviewPublicationService(h.binding).reconcile(key);
  assert.notEqual(result.state, 'published');
});

test('wrong body does not publish', async () => {
  const review = makeReview('t8c');
  const h = makeBinding(review);
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key } = publicationIdentity(review, prepared);
  await h.store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId: review.source.runId, state: 'planned' as const, prepared }));
  h.setReadback(p => Promise.resolve(receiptFor(p, { body: p.body + 'tampered' })));
  const result = await new ReviewPublicationService(h.binding).reconcile(key);
  assert.notEqual(result.state, 'published');
});

test('missing receipt fields do not publish', async () => {
  const review = makeReview('t8d');
  const h = makeBinding(review);
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key } = publicationIdentity(review, prepared);
  await h.store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId: review.source.runId, state: 'planned' as const, prepared }));
  h.setReadback(p => Promise.resolve({ commentId: '', url: '', body: p.body, author: 'helm-bot', observedHead: p.target.head }));
  const result = await new ReviewPublicationService(h.binding).reconcile(key);
  assert.notEqual(result.state, 'published');
});

test('contradictory verdict same key is refused, no additional post', async () => {
  const review = makeReview('t9');
  const h = makeBinding(review);
  const svc = new ReviewPublicationService(h.binding);
  await svc.publish(review.reviewId, TARGET);
  assert.equal(h.posts(), 1);
  const contradictingBinding: PublicationBinding = {
    store: h.store,
    loadReview: () => Promise.resolve(review),
    readVerifiedVerdict: () => Promise.resolve('FAIL'),
    authorize: () => Promise.resolve(),
    inspectHead: (t) => Promise.resolve(t.head),
    expectedPublisher: () => Promise.resolve('helm-bot'),
    post: () => Promise.resolve(),
    readback: (p) => Promise.resolve(receiptFor(p)),
  };
  let threw = false;
  try {
    await new ReviewPublicationService(contradictingBinding).publish(review.reviewId, TARGET);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'same identity with a different body must refuse');
  assert.equal(h.posts(), 1, 'no additional post occurred');
});

test('missing gate evidence: readVerifiedVerdict rejects before intent', async () => {
  const review = makeReview('t10');
  const h = makeBinding(review, 'PASS', { readVerifiedVerdict: () => Promise.reject(new Error('no executable verification evidence')) });
  await assert.rejects(() => new ReviewPublicationService(h.binding).publish(review.reviewId, TARGET));
  assert.equal(await h.store.reopen(keyFor(review)), undefined);
});

test('nonterminal review never creates intent', async () => {
  const review = { ...makeReview('t11'), state: 'launched' } as unknown as DurableReviewRecord;
  const h = makeBinding(review);
  await assert.rejects(() => new ReviewPublicationService(h.binding).publish(review.reviewId, TARGET));
  assert.equal(h.posts(), 0);
});

test('wrong review identity loadReview refuses', async () => {
  const store = new MemoryPublicationStore();
  const binding: PublicationBinding = {
    store,
    loadReview: () => Promise.resolve(undefined as unknown as DurableReviewRecord),
    readVerifiedVerdict: () => Promise.resolve('PASS'),
    authorize: () => Promise.resolve(),
    inspectHead: (t) => Promise.resolve(t.head),
    expectedPublisher: () => Promise.resolve('helm-bot'),
    post: () => Promise.resolve(),
    readback: () => Promise.resolve(undefined),
  };
  await assert.rejects(
    () => new ReviewPublicationService(binding).publish('nonexistent-review-id', TARGET),
    /durable review identity does not match request/,
  );
});

// ---------------------------------------------------------------------------
// Fault injection: append fails and reopen returns undefined
// ---------------------------------------------------------------------------

test('fault injection: append failure + reopen undefined must not return published', async () => {
  const review = makeReview('fault1');
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, prepared);
  let appendCalled = false;
  const faultyStore: PublicationStore = {
    async reopen(k: string): Promise<PublicationRecord | undefined> {
      if (k !== key) return undefined;
      if (appendCalled) return undefined;
      return Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared });
    },
    async prepare(record: PublicationRecord) {
      return Object.freeze({ record, created: true });
    },
    async append(_record: PublicationRecord): Promise<void> {
      appendCalled = true;
      throw new Error('simulated durable store failure');
    },
  };
  const binding: PublicationBinding = {
    store: faultyStore,
    loadReview: () => Promise.resolve(review),
    readVerifiedVerdict: () => Promise.resolve('PASS'),
    authorize: () => Promise.resolve(),
    inspectHead: (t) => Promise.resolve(t.head),
    expectedPublisher: () => Promise.resolve('helm-bot'),
    post: () => Promise.resolve(),
    readback: (p) => Promise.resolve({ commentId: 'c-1', url: 'https://x/c-1', body: p.body, author: 'helm-bot', observedHead: p.target.head }),
  };
  const svc = new ReviewPublicationService(binding);
  await assert.rejects(svc.publish(review.reviewId, TARGET), /publication result is not durable/);
  assert.equal(appendCalled, true);
});

// ---------------------------------------------------------------------------
// JournalReviewPublicationStore tests with real ArtifactJournal
// ---------------------------------------------------------------------------

async function withJournal(fn: (journal: ArtifactJournal) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pub-test-'));
  try {
    const journal = await ArtifactJournal.open({ root: dir, hostPolicy: { allowSensitiveWrites: true } });
    try {
      await fn(journal);
    } finally {
      await journal.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('journal store: immutable intent conflict is refused', async () => {
  const review = makeReview('j1');
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, prepared);
  await withJournal(async (journal) => {
    const store = new JournalReviewPublicationStore(journal, runId);
    const a = await store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared }));
    assert.equal(a.created, true);
    const b = await store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared }));
    assert.equal(b.created, false);
    const forgedPrepared: PreparedReviewPublication = { ...prepared, body: prepared.body + 'x' };
    await assert.rejects(
      () => store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared: forgedPrepared })),
    );
  });
});

test('journal store: illegal transitions are refused', async () => {
  const review = makeReview('j2');
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, prepared);
  await withJournal(async (journal) => {
    const store = new JournalReviewPublicationStore(journal, runId);
    const planned: PublicationRecord = Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared });
    await store.prepare(planned);
    const receipt: PublicationReceipt = Object.freeze({ commentId: 'c-1', url: 'https://x/c-1', body: prepared.body, author: 'helm-bot', observedHead: prepared.target.head });
    const published: PublicationRecord = Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'published' as const, prepared, receipt });
    await store.append(published);
    const denied: PublicationRecord = Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'denied' as const, prepared, reason: 'post published' });
    await assert.rejects(() => store.append(denied), /not append-safe/);
  });
});

test('journal store: published wrong body/head/missing receipt refused', async () => {
  const review = makeReview('j3');
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, prepared);
  await withJournal(async (journal) => {
    const store = new JournalReviewPublicationStore(journal, runId);
    const planned: PublicationRecord = Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared });
    await store.prepare(planned);

    const wrongBody: PublicationRecord = Object.freeze({
      schemaVersion: 1 as const, key, runId, state: 'published' as const, prepared,
      receipt: Object.freeze({ commentId: 'c-1', url: 'https://x/c-1', body: 'wrong', author: 'helm-bot', observedHead: prepared.target.head }),
    });
    await assert.rejects(() => store.append(wrongBody));

    const wrongHead: PublicationRecord = Object.freeze({
      schemaVersion: 1 as const, key, runId, state: 'published' as const, prepared,
      receipt: Object.freeze({ commentId: 'c-1', url: 'https://x/c-1', body: prepared.body, author: 'helm-bot', observedHead: 'f'.repeat(40) }),
    });
    await assert.rejects(() => store.append(wrongHead));

    const missingReceipt: PublicationRecord = Object.freeze({
      schemaVersion: 1 as const, key, runId, state: 'published' as const, prepared,
    });
    await assert.rejects(() => store.append(missingReceipt));
  });
});

test('journal store: defensive immutable snapshots', async () => {
  const review = makeReview('j4');
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, prepared);
  await withJournal(async (journal) => {
    const store = new JournalReviewPublicationStore(journal, runId);
    const planned: PublicationRecord = Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared });
    await store.prepare(planned);
    const receipt: PublicationReceipt = Object.freeze({ commentId: 'c-1', url: 'https://x/c-1', body: prepared.body, author: 'helm-bot', observedHead: prepared.target.head });
    await store.append(Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'published' as const, prepared, receipt }));
    const record = await store.reopen(key);
    assert.ok(record);
    assert.throws(() => { (record!.prepared.target as { head: string }).head = 'zz'; });
    assert.throws(() => { (record!.receipt as { author: string }).author = 'x'; });
  });
});

test('journal store: concurrent two stores over same journal immutable claim winner', async () => {
  const review = makeReview('j5');
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, prepared);
  await withJournal(async (journal) => {
    const storeA = new JournalReviewPublicationStore(journal, runId);
    const storeB = new JournalReviewPublicationStore(journal, runId);
    const planned: PublicationRecord = Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared });
    const [a, b] = await Promise.all([storeA.prepare(planned), storeB.prepare(planned)]);
    assert.equal(a.created !== b.created, true, 'exactly one caller must win the immutable intent');
    const reopened = await storeA.reopen(key);
    assert.ok(reopened);
    assert.equal(reopened!.state, 'planned');
  });
});

test('journal store: real restart retains unknown and re-readback allows publish without new post', async () => {
  const review = makeReview('j6');
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, prepared);
  const dir = await mkdtemp(join(tmpdir(), 'pub-restart-'));
  try {
    const journal1 = await ArtifactJournal.open({ root: dir, hostPolicy: { allowSensitiveWrites: true } });
    const store1 = new JournalReviewPublicationStore(journal1, runId);
    let postCount1 = 0;
    const binding1: PublicationBinding = {
      store: store1,
      loadReview: () => Promise.resolve(review),
      readVerifiedVerdict: () => Promise.resolve('PASS'),
      authorize: () => Promise.resolve(),
      inspectHead: (t) => Promise.resolve(t.head),
      expectedPublisher: () => Promise.resolve('helm-bot'),
      post: () => { postCount1 += 1; throw new Error('simulated crash after post'); },
      readback: () => Promise.resolve(undefined),
    };
    const svc1 = new ReviewPublicationService(binding1);
    const first = await svc1.publish(review.reviewId, TARGET);
    assert.equal(first.state, 'unknown');
    assert.equal(postCount1, 1);
    await journal1.close();

    const journal2 = await ArtifactJournal.open({ root: dir, hostPolicy: { allowSensitiveWrites: true } });
    const store2 = new JournalReviewPublicationStore(journal2, runId);
    const retained = await store2.reopen(key);
    assert.ok(retained);
    assert.equal(retained!.state, 'unknown');
    let postCount2 = 0;
    const binding2: PublicationBinding = {
      store: store2,
      loadReview: () => Promise.resolve(review),
      readVerifiedVerdict: () => Promise.resolve('PASS'),
      authorize: () => Promise.resolve(),
      inspectHead: (t) => Promise.resolve(t.head),
      expectedPublisher: () => Promise.resolve('helm-bot'),
      post: () => { postCount2 += 1; return Promise.resolve(); },
      readback: (p) => Promise.resolve({ commentId: 'c-1', url: 'https://x/c-1', body: p.body, author: 'helm-bot', observedHead: p.target.head }),
    };
    const svc2 = new ReviewPublicationService(binding2);
    const second = await svc2.reconcile(key);
    assert.equal(second.state, 'published');
    assert.equal(postCount2, 0, 'reconcile must never post');
    await journal2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('journal store: conflicting intent different verdict same key refused', async () => {
  const review = makeReview('j7');
  const preparedPass = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, preparedPass);
  await withJournal(async (journal) => {
    const store = new JournalReviewPublicationStore(journal, runId);
    await store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared: preparedPass }));
    const preparedFail = prepareReviewPublication(review, TARGET, 'FAIL');
    assert.equal(publicationIdentity(review, preparedFail).key, key);
    await assert.rejects(
      () => store.prepare(Object.freeze({ schemaVersion: 1 as const, key, runId, state: 'planned' as const, prepared: preparedFail })),
      /conflicts/,
    );
  });
});

test('journal store: full publish flow end-to-end', async () => {
  const review = makeReview('j8');
  const dir = await mkdtemp(join(tmpdir(), 'pub-e2e-'));
  try {
    const journal = await ArtifactJournal.open({ root: dir, hostPolicy: { allowSensitiveWrites: true } });
    const prepared = prepareReviewPublication(review, TARGET, 'PASS');
    const { key, runId } = publicationIdentity(review, prepared);
    const store = new JournalReviewPublicationStore(journal, runId);
    let postCount = 0;
    const binding: PublicationBinding = {
      store,
      loadReview: () => Promise.resolve(review),
      readVerifiedVerdict: () => Promise.resolve('PASS'),
      authorize: () => Promise.resolve(),
      inspectHead: (t) => Promise.resolve(t.head),
      expectedPublisher: () => Promise.resolve('helm-bot'),
      post: () => { postCount += 1; return Promise.resolve(); },
      readback: (p) => Promise.resolve({ commentId: 'c-e2e', url: 'https://example.com/c-e2e', body: p.body, author: 'helm-bot', observedHead: p.target.head }),
    };
    const svc = new ReviewPublicationService(binding);
    const result = await svc.publish(review.reviewId, TARGET);
    assert.equal(result.state, 'published');
    assert.equal(postCount, 1);
    assert.ok(result.receipt);
    assert.equal(result.receipt!.commentId, 'c-e2e');
    const reopened = await store.reopen(key);
    assert.ok(reopened);
    assert.equal(reopened!.state, 'published');
    assert.equal(reopened!.receipt!.body, prepared.body);
    await journal.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('journal store: unknown to published via reconcile after restart', async () => {
  const review = makeReview('j9');
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, prepared);
  const dir = await mkdtemp(join(tmpdir(), 'pub-unknown-reconcile-'));
  try {
    const journal1 = await ArtifactJournal.open({ root: dir, hostPolicy: { allowSensitiveWrites: true } });
    const store1 = new JournalReviewPublicationStore(journal1, runId);
    const binding1: PublicationBinding = {
      store: store1,
      loadReview: () => Promise.resolve(review),
      readVerifiedVerdict: () => Promise.resolve('PASS'),
      authorize: () => Promise.resolve(),
      inspectHead: (t) => Promise.resolve(t.head),
      expectedPublisher: () => Promise.resolve('helm-bot'),
      post: () => Promise.resolve(),
      readback: () => Promise.resolve(undefined),
    };
    const svc1 = new ReviewPublicationService(binding1);
    const first = await svc1.publish(review.reviewId, TARGET);
    assert.equal(first.state, 'unknown');
    await journal1.close();

    const journal2 = await ArtifactJournal.open({ root: dir, hostPolicy: { allowSensitiveWrites: true } });
    const store2 = new JournalReviewPublicationStore(journal2, runId);
    let postCount2 = 0;
    const binding2: PublicationBinding = {
      store: store2,
      loadReview: () => Promise.resolve(review),
      readVerifiedVerdict: () => Promise.resolve('PASS'),
      authorize: () => Promise.resolve(),
      inspectHead: (t) => Promise.resolve(t.head),
      expectedPublisher: () => Promise.resolve('helm-bot'),
      post: () => { postCount2 += 1; return Promise.resolve(); },
      readback: (p) => Promise.resolve({ commentId: 'c-found', url: 'https://x/c-found', body: p.body, author: 'helm-bot', observedHead: p.target.head }),
    };
    const svc2 = new ReviewPublicationService(binding2);
    const second = await svc2.reconcile(key);
    assert.equal(second.state, 'published');
    assert.equal(postCount2, 0);
    const reopened = await store2.reopen(key);
    assert.equal(reopened!.state, 'published');
    await journal2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('loaded valid review must match the requested review identity', async () => {
  const h = makeBinding(makeReview('wrong-id'));
  await assert.rejects(new ReviewPublicationService(h.binding).publish('review-other', TARGET), /identity/);
  assert.equal(h.posts(), 0);
});

test('preflight reasons never expose adapter exception contents', async () => {
  const h = makeBinding(makeReview('generic-reason'), 'PASS', { authorize: async () => { throw new Error('PRIVATE_SENTINEL' + '😀'.repeat(400)); } });
  const result = await new ReviewPublicationService(h.binding).publish(h.review.reviewId, TARGET);
  assert.equal(result.state, 'denied');
  assert.equal(result.reason, 'publication preflight refused');
  assert.ok(Buffer.byteLength(result.reason!, 'utf8') < 512);
});

test('journal rejects a forged published root intent', async () => {
  const review = makeReview('forged-root');
  const prepared = prepareReviewPublication(review, TARGET, 'PASS');
  const { key, runId } = publicationIdentity(review, prepared);
  await withJournal(async journal => {
    await journal.append({ source: 'host.review.publication', sourceIdentity: `host.review.publication:${runId}:${key}:intent`, mediaType: 'application/json', classification: 'sensitive', bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, claimToken: 'forged', record: { schemaVersion: 1, key, runId, state: 'published', prepared, receipt: receiptFor(prepared) } })) }, { permitSensitive: true });
    await assert.rejects(new JournalReviewPublicationStore(journal, runId).reopen(key), /root must be planned/);
  });
});
