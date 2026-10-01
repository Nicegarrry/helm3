import assert from 'node:assert/strict';
import test from 'node:test';
import { builderPrompt, reviewerPrompt, validatorPrompt, type PromptInput } from '../src/prompt.ts';

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
