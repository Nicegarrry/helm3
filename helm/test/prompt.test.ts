import assert from 'node:assert/strict';
import test from 'node:test';
import { formatIssueBrief, builderPrompt, reviewerPrompt, validatorPrompt } from '../src/prompt.js';

test('formatIssueBrief: formats title and body', () => {
  const result = formatIssueBrief(42, { title: 'Fix bug', body: 'The bug is here.' });
  assert.equal(result, 'Issue #42: Fix bug\n\nThe bug is here.');
});

test('formatIssueBrief: takes last 3 non-empty comments', () => {
  const result = formatIssueBrief(100, {
    title: 'Discussion',
    body: 'Main topic',
    comments: [
      { author: 'c1', body: 'First' },
      { author: 'c2', body: 'Second' },
      { author: 'c3', body: 'Third' },
      { author: 'c4', body: 'Fourth' },
    ],
  });
  assert.ok(!result?.includes('First'));
  assert.ok(result?.includes('Second'));
  assert.ok(result?.includes('Third'));
  assert.ok(result?.includes('Fourth'));
});

test('formatIssueBrief: caps text at maxChars (default 8000)', () => {
  const longBody = 'x'.repeat(10_000);
  const result = formatIssueBrief(1, { title: 'Long issue', body: longBody });
  assert.ok(result);
  assert.equal(result.length, 8000);
});

test('formatIssueBrief: returns undefined when all fields are empty', () => {
  const result = formatIssueBrief(1, { title: '', body: '', comments: [] });
  assert.equal(result, undefined);
});

test('builderPrompt: includes issueText in brief when provided', () => {
  const prompt = builderPrompt({
    objective: 'Implement feature',
    acceptance: 'Tests pass',
    contextPaths: ['src/index.ts'],
    issueText: 'Issue #10: Feature details',
  });
  assert.ok(prompt.includes('Objective:\nImplement feature\n\nIssue #10: Feature details\n\nAcceptance criteria:\nTests pass'));
});

test('reviewerPrompt and validatorPrompt: include issueText in brief', () => {
  const rev = reviewerPrompt({
    objective: 'Review feature',
    acceptance: null,
    contextPaths: [],
    issueText: 'Issue #10: Feature details',
  });
  assert.ok(rev.includes('Review objective:\nReview feature\n\nIssue #10: Feature details'));

  const val = validatorPrompt({
    objective: 'Validate feature',
    acceptance: null,
    contextPaths: [],
    issueText: 'Issue #10: Feature details',
  });
  assert.ok(val.includes('Objective:\nValidate feature\n\nIssue #10: Feature details'));
});
