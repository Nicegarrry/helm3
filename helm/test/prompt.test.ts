import assert from 'node:assert/strict';
import test from 'node:test';
import { formatIssueBrief, builderPrompt, reviewerPrompt, validatorPrompt, type PromptInput } from '../src/prompt.js';

const input: PromptInput = { objective: 'Fix the flaky test.', acceptance: 'npm test passes.', contextPaths: [] };

const COMMIT_LINE = 'Do not commit, rebase or push. Helm commits your saved edits when your turn ends, and the supervisor handles merges.';
const NODE_MODULES_LINE = 'Do not symlink node_modules into the worktree; Helm manages dependencies.';
const GH_LINE = 'Do not run gh; workers cannot access GitHub, and the supervisor handles GitHub operations.';

for (const [name, prompt] of [['builder', builderPrompt], ['validator', validatorPrompt]] as const) {
  test(`${name} prompt says Helm commits at turn end, and covers node_modules and gh (#318)`, () => {
    const text = prompt(input);
    assert.ok(text.includes(COMMIT_LINE), `${name} prompt missing commit line`);
    assert.ok(text.includes(NODE_MODULES_LINE), `${name} prompt missing node_modules line`);
    assert.ok(text.includes(GH_LINE), `${name} prompt missing gh line`);
  });
}

test('reviewer prompt stays read-only guidance without the commit line', () => {
  const text = reviewerPrompt(input);
  assert.ok(!text.includes(COMMIT_LINE));
});

test('reviewer prompt reports all blocking findings in one pass and scopes re-reviews (#327)', () => {
  const text = reviewerPrompt(input);
  assert.ok(
    text.includes('In a single pass, list every blocking finding you can find, numbered. Separate blocking findings\nfrom non-blocking ones; non-blocking nits never gate a round.'),
    'reviewer prompt missing single-pass blocking-findings guidance',
  );
  assert.ok(
    text.includes('On a re-review, check only that the previous findings were fixed and look for regressions in the\nnew diff; do not invent new nits outside it.'),
    'reviewer prompt missing re-review scope guidance',
  );
});

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
