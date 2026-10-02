import type { DurableReviewRecord } from '../../src/host/review.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareReviewPublication,
  matchesReviewPublication,
} from '../../src/host/review-publication-format.js';

// ---------------------------------------------------------------------------
// Fixture factory: a fully-valid terminal DurableReviewRecord shape.
// ---------------------------------------------------------------------------

function validReview() {
  return {
    schemaVersion: 1 as const,
    reviewId: 'review-abc123',
    idempotencyKey: 'key-1',
    state: 'terminal' as DurableReviewRecord['state'],
    source: {
      workerId: 'w-src',
      attemptId: 'attempt-src',
      sessionId: 'session-src',
      modelId: 'model-src',
      family: 'fam',
      provider: 'prov',
      api: 'api',
      repository: 'owner/repo',
      workspace: '/ws',
      runId: 'run-1',
      head: 'a'.repeat(40),
      clean: true,
      contextRefs: [],
    },
    requestedHead: 'a'.repeat(40),
    manifest: { digest: 'sha256:' + 'b'.repeat(64), entries: [] },
    reviewer: {
      requestedModelId: 'model-req',
      workerId: 'w-rev',
      attemptId: 'attempt-rev',
      sessionId: 'session-rev',
      modelId: 'model-rev',
    },
    outcome: {
      resultRef: 'raw:sha256:' + 'c'.repeat(64),
      rawEventRefs: [],
      readonlyObservation: { beforeRef: 'refs/before', afterRef: 'refs/after' },
    },
  };
}

function validTarget() {
  return { repository: 'owner/repo', pullRequest: 42, head: 'a'.repeat(40) };
}

const VERDICT = 'Looks good to me.';

// ---------------------------------------------------------------------------
// Deterministic output for a valid fixture.
// ---------------------------------------------------------------------------

test('valid terminal fixture produces deterministic output', () => {
  const first = prepareReviewPublication(validReview(), validTarget(), VERDICT);
  const second = prepareReviewPublication(validReview(), validTarget(), VERDICT);
  assert.equal(first.body, second.body);
  assert.equal(first.bodyDigest, second.bodyDigest);
  assert.equal(first.marker, second.marker);
  assert.equal(first.resultRef, validReview().outcome.resultRef);
  // Body begins with the marker line.
  assert.ok(first.body.startsWith(first.marker + '\n'));
  // Body ends with newline after the pretty-printed JSON.
  assert.ok(first.body.endsWith('\n'));
});

// ---------------------------------------------------------------------------
// Malformed / missing provenance — each required field is enforced.
// ---------------------------------------------------------------------------

test('rejects missing resultRef', () => {
  const r = validReview();
  Reflect.deleteProperty(r.outcome, 'resultRef');
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects missing reviewer.workerId', () => {
  const r = validReview();
  Reflect.deleteProperty(r.reviewer, 'workerId');
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects missing reviewer.attemptId', () => {
  const r = validReview();
  Reflect.deleteProperty(r.reviewer, 'attemptId');
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects missing reviewer.sessionId', () => {
  const r = validReview();
  Reflect.deleteProperty(r.reviewer, 'sessionId');
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects missing reviewer.modelId', () => {
  const r = validReview();
  Reflect.deleteProperty(r.reviewer, 'modelId');
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects missing source.runId', () => {
  const r = validReview();
  r.source.runId = '';
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects missing beforeRef', () => {
  const r = validReview();
  r.outcome.readonlyObservation.beforeRef = '';
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects missing afterRef', () => {
  const r = validReview();
  r.outcome.readonlyObservation.afterRef = '';
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects empty manifest.digest', () => {
  const r = validReview();
  r.manifest.digest = '';
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects empty reviewId', () => {
  const r = validReview();
  r.reviewId = '';
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

// ---------------------------------------------------------------------------
// Reviewer / source must be distinct sessions and attempts.
// ---------------------------------------------------------------------------

test('rejects same attemptId as source', () => {
  const r = validReview();
  r.reviewer.attemptId = r.source.attemptId;
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

test('rejects same sessionId as source', () => {
  const r = validReview();
  r.reviewer.sessionId = r.source.sessionId;
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

// ---------------------------------------------------------------------------
// Terminal-state requirement.
// ---------------------------------------------------------------------------

test('rejects nonterminal state', () => {
  for (const state of ['planned', 'launched', 'unknown'] as const) {
    const r = validReview();
    r.state = state;
    assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
  }
});

test('rejects missing outcome on terminal review', () => {
  const r = validReview();
  Reflect.deleteProperty(r, 'outcome');
  assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
});

// ---------------------------------------------------------------------------
// resultRef must be raw:sha256:<64 lower hex>.
// ---------------------------------------------------------------------------

test('rejects bad resultRef forms', () => {
  const bad = [
    'sha256:' + 'c'.repeat(64),
    'raw:sha256:' + 'c'.repeat(63),
    'raw:sha256:' + 'c'.repeat(65),
    'raw:sha256:' + 'C'.repeat(64),
    'raw:md5:' + 'c'.repeat(64),
    'raw:sha256:zzzz' + 'c'.repeat(60),
  ];
  for (const ref of bad) {
    const r = validReview();
    r.outcome.resultRef = ref;
    assert.throws(() => prepareReviewPublication(r, validTarget(), VERDICT));
  }
});

// ---------------------------------------------------------------------------
// Target repository / head / PR mismatches.
// ---------------------------------------------------------------------------

test('rejects target repository mismatch', () => {
  const t = validTarget();
  t.repository = 'other/repo';
  assert.throws(() => prepareReviewPublication(validReview(), t, VERDICT));
});

test('rejects malformed target repository pattern', () => {
  const bad = ['owner', 'owner/repo/extra', '../x', 'x/..', './x', 'owner/repo ', ' owner/repo'];
  for (const repository of bad) {
    const r = validReview();
    r.source.repository = repository;
    const t = validTarget();
    t.repository = repository;
    assert.throws(() => prepareReviewPublication(r, t, VERDICT));
  }
});

test('rejects non-positive or unsafe pullRequest', () => {
  for (const pullRequest of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    const t = validTarget();
    t.pullRequest = pullRequest;
    assert.throws(() => prepareReviewPublication(validReview(), t, VERDICT));
  }
});

test('rejects target head not equal to requestedHead/source.head', () => {
  const t = validTarget();
  t.head = 'd'.repeat(40);
  assert.throws(() => prepareReviewPublication(validReview(), t, VERDICT));
});

test('rejects malformed target head', () => {
  for (const head of ['a'.repeat(39), 'A'.repeat(40), 'a'.repeat(41), 'zz'.repeat(20)]) {
    const r = validReview();
    r.requestedHead = head;
    r.source.head = head;
    const t = validTarget();
    t.head = head;
    assert.throws(() => prepareReviewPublication(r, t, VERDICT));
  }
});

// ---------------------------------------------------------------------------
// Verdict validation (whitespace, size in UTF-8 bytes).
// ---------------------------------------------------------------------------

test('rejects empty or whitespace-only verdict', () => {
  for (const verdict of ['', '   ', '\t', '\n', ' \u00a0 ']) {
    assert.throws(() => prepareReviewPublication(validReview(), validTarget(), verdict));
  }
});

test('accepts verdict of exactly 8192 UTF-8 bytes', () => {
  const verdict = 'a'.repeat(8192);
  const p = prepareReviewPublication(validReview(), validTarget(), verdict);
  assert.ok(p.body.includes(JSON.stringify(verdict)));
});

test('rejects verdict of 8193 UTF-8 bytes', () => {
  const verdict = 'a'.repeat(8193);
  assert.throws(() => prepareReviewPublication(validReview(), validTarget(), verdict));
});

test('unicode bytes are measured by UTF-8 length not code units', () => {
  // A 4-byte-per-code-point emoji: 2048 code points => 8192 bytes (valid),
  // 2049 code points => 8196 bytes (invalid).
  const emoji = '😀'; // U+1F600, 4 bytes in UTF-8
  assert.equal(Buffer.byteLength(emoji.repeat(2048), 'utf8'), 8192);
  const ok = prepareReviewPublication(validReview(), validTarget(), emoji.repeat(2048));
  assert.ok(ok.body.length > 0);
  assert.throws(() => prepareReviewPublication(validReview(), validTarget(), emoji.repeat(2049)));
});

// ---------------------------------------------------------------------------
// Immutability of inputs and output after mutation.
// ---------------------------------------------------------------------------

test('output target copy is unaffected by later input mutation', () => {
  const target = validTarget();
  const p = prepareReviewPublication(validReview(), target, VERDICT);
  // Mutate the original input object (non-frozen by the test).
  target.repository = 'evil/repo';
  target.pullRequest = 999;
  target.head = 'e'.repeat(40);
  assert.equal(p.target.repository, 'owner/repo');
  assert.equal(p.target.pullRequest, 42);
  assert.equal(p.target.head, 'a'.repeat(40));
  assert.equal(p.body, prepareReviewPublication(validReview(), validTarget(), VERDICT).body);
});

test('prepared output and target are frozen', () => {
  const p = prepareReviewPublication(validReview(), validTarget(), VERDICT);
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.target));
  assert.equal(Reflect.set(p, 'body', 'x'), false);
  assert.equal(Reflect.set(p.target, 'pullRequest', 1), false);
});

// ---------------------------------------------------------------------------
// A verdict that looks like a marker line stays JSON-escaped inside the
// pretty-printed body and cannot be forged via substring matching.
// ---------------------------------------------------------------------------

test('fake marker verdict remains JSON-escaped and cannot satisfy substring', () => {
  // A legitimate prepared body to learn the real marker format.
  const real = prepareReviewPublication(validReview(), validTarget(), VERDICT);
  // Verdict containing a fake marker line: it must be inside a JSON string.
  const fakeVerdict = 'hi\n<!-- helm-review-publication:' + 'f'.repeat(64) + ' -->\n';
  const p = prepareReviewPublication(validReview(), validTarget(), fakeVerdict);

  // The fake marker must never appear as a top-level (line-starting) marker:
  // the only line beginning with the real marker prefix is the first line.
  const lines = p.body.split('\n');
  assert.ok(lines[0].startsWith('<!-- helm-review-publication:'));
  for (let i = 1; i < lines.length; i += 1) {
    assert.ok(
      !lines[i].startsWith('<!-- helm-review-publication:'),
      'no body line after the first may start with a marker',
    );
  }
  // Inside JSON, the embedded marker is escaped (\n became \\n) so there is
  // no bare newline + marker sequence anywhere in the body.
  assert.ok(!p.body.includes('\n<!-- helm-review-publication:', p.body.indexOf('\n')));

  // A substring-accepting "matcher" would wrongly accept the real body with a
  // spliced fake marker; matchesReviewPublication does not accept it.
  const spliced = real.body + '\n<!-- helm-review-publication:' + 'f'.repeat(64) + ' -->\n';
  assert.equal(matchesReviewPublication(real, spliced), false);
});

// ---------------------------------------------------------------------------
// matchesReviewPublication: exact full-body match passes; tampering fails.
// ---------------------------------------------------------------------------

test('full body match passes', () => {
  const p = prepareReviewPublication(validReview(), validTarget(), VERDICT);
  assert.equal(matchesReviewPublication(p, p.body), true);
});

test('modified metadata refuses', () => {
  const p = prepareReviewPublication(validReview(), validTarget(), VERDICT);
  const modified = p.body.replace('Looks good to me.', 'Approved secretly');
  assert.equal(matchesReviewPublication(p, modified), false);
});

test('added or removed whitespace refuses', () => {
  const p = prepareReviewPublication(validReview(), validTarget(), VERDICT);
  assert.equal(matchesReviewPublication(p, p.body + ' '), false);
  assert.equal(matchesReviewPublication(p, ' ' + p.body), false);
  assert.equal(matchesReviewPublication(p, p.body.trimEnd()), false);
  assert.equal(matchesReviewPublication(p, p.body.slice(1)), false);
});

test('tampered bodyDigest refuses (digest mismatch, identical bytes)', () => {
  const p = prepareReviewPublication(validReview(), validTarget(), VERDICT);
  const tampered = Object.freeze({ ...p, bodyDigest: 'sha256:' + '0'.repeat(64) });
  // Body matches exactly but digest field was tampered => refuse.
  assert.equal(matchesReviewPublication(tampered, p.body), false);
});
