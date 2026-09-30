import assert from 'node:assert/strict';
import test from 'node:test';
import { hardenedGitArgs } from '../src/git.js';

test('hardenedGitArgs inserts --no-verify after the first commit or merge subcommand', () => {
  const hardened = hardenedGitArgs(['-c', 'user.name=helm', 'commit', '-m', 'message']);
  assert.deepEqual(hardened.slice(-4), ['commit', '--no-verify', '-m', 'message']);

  const merged = hardenedGitArgs(['-C', '/repo', 'merge', '--abort']);
  assert.deepEqual(merged.slice(-3), ['merge', '--no-verify', '--abort']);
});

test('hardenedGitArgs ignores later arguments named commit or merge', () => {
  assert.deepEqual(hardenedGitArgs(['log', '--grep', 'merge']), [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=ssh', '-c', 'protocol.ext.allow=never',
    'log', '--grep', 'merge',
  ]);
  assert.deepEqual(hardenedGitArgs(['branch', 'merge']).at(-2), 'branch');
  assert.equal(hardenedGitArgs(['branch', 'merge']).includes('--no-verify'), false);
});
