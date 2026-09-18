import assert from 'node:assert/strict';
import test from 'node:test';
import { ghGitHub } from '../src/github.js';
import type { ExecFn } from '../src/github.js';

type Call = { file: string; args: string[]; opts: { cwd?: string; input?: string } };

function fakeExec(responses: (call: Call) => { stdout: string; stderr: string; code: number }) {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args, opts) => {
    const call = { file, args, opts };
    calls.push(call);
    return responses(call);
  };
  return { exec, calls };
}

test('openPr: creates the PR then views it for number and url', async () => {
  const { exec, calls } = fakeExec((call) => {
    if (call.args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/9\n', stderr: '', code: 0 };
    if (call.args[1] === 'view') return { stdout: JSON.stringify({ number: 9, url: 'https://github.com/o/r/pull/9' }), stderr: '', code: 0 };
    throw new Error(`unexpected call: ${call.args.join(' ')}`);
  });
  const github = ghGitHub(exec);
  const result = await github.openPr({ cwd: '/repo', base: 'main', head: 'helm/w-1', title: 'My PR', body: 'Body text', draft: true });

  assert.deepEqual(result, { number: 9, url: 'https://github.com/o/r/pull/9' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.args, ['pr', 'create', '--base', 'main', '--head', 'helm/w-1', '--title', 'My PR', '--body', 'Body text', '--draft']);
  assert.equal(calls[0]?.opts.cwd, '/repo');
  assert.deepEqual(calls[1]?.args, ['pr', 'view', 'https://github.com/o/r/pull/9', '--json', 'number,url']);
});

test('openPr: omits --draft when draft is false', async () => {
  const { exec, calls } = fakeExec((call) => {
    if (call.args[1] === 'create') return { stdout: 'https://github.com/o/r/pull/10\n', stderr: '', code: 0 };
    return { stdout: JSON.stringify({ number: 10, url: 'https://github.com/o/r/pull/10' }), stderr: '', code: 0 };
  });
  const github = ghGitHub(exec);
  await github.openPr({ cwd: '/repo', base: 'main', head: 'helm/w-2', title: 'T', body: 'B', draft: false });
  assert.ok(!calls[0]?.args.includes('--draft'));
});

test('prStatus: maps gh pr view JSON to PrStatus, merged when mergedAt is set', async () => {
  const sample = {
    number: 5,
    state: 'CLOSED',
    headRefOid: 'a'.repeat(40),
    mergeable: 'MERGEABLE',
    mergedAt: '2026-09-18T00:00:00Z',
    url: 'https://github.com/o/r/pull/5',
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviews: [{ author: { login: 'alice' }, state: 'APPROVED' }],
  };
  const { exec, calls } = fakeExec(() => ({ stdout: JSON.stringify(sample), stderr: '', code: 0 }));
  const github = ghGitHub(exec);
  const status = await github.prStatus('o/r', 5);

  assert.equal(status.state, 'merged');
  assert.equal(status.mergeable, true);
  assert.equal(status.head, 'a'.repeat(40));
  assert.deepEqual(status.checks, [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]);
  assert.deepEqual(status.reviews, [{ author: 'alice', state: 'APPROVED' }]);
  assert.deepEqual(calls[0]?.args, ['pr', 'view', '5', '--repo', 'o/r', '--json', 'number,state,headRefOid,mergeable,statusCheckRollup,reviews,url,mergedAt']);
});

test('prStatus: open state when not merged and not closed', async () => {
  const sample = { number: 6, state: 'OPEN', headRefOid: 'b'.repeat(40), mergeable: null, url: 'u', statusCheckRollup: [], reviews: [] };
  const { exec } = fakeExec(() => ({ stdout: JSON.stringify(sample), stderr: '', code: 0 }));
  const github = ghGitHub(exec);
  const status = await github.prStatus('o/r', 6);
  assert.equal(status.state, 'open');
  assert.equal(status.mergeable, null);
});

test('comment: pipes the body on stdin via --body-file -', async () => {
  const { exec, calls } = fakeExec(() => ({ stdout: '', stderr: '', code: 0 }));
  const github = ghGitHub(exec);
  await github.comment('o/r', 3, 'nice work');
  assert.deepEqual(calls[0]?.args, ['pr', 'comment', '3', '--repo', 'o/r', '--body-file', '-']);
  assert.equal(calls[0]?.opts.input, 'nice work');
});

test('merge: calls gh api PUT with sha and squash', async () => {
  const { exec, calls } = fakeExec(() => ({ stdout: '{}', stderr: '', code: 0 }));
  const github = ghGitHub(exec);
  await github.merge('o/r', 4, 'c'.repeat(40));
  assert.deepEqual(calls[0]?.args, ['api', '-X', 'PUT', 'repos/o/r/pulls/4/merge', '-f', `sha=${'c'.repeat(40)}`, '-f', 'merge_method=squash']);
});

test('errors become thrown Error with the trimmed gh stderr', async () => {
  const { exec } = fakeExec(() => ({ stdout: '', stderr: '  permission denied  \n', code: 1 }));
  const github = ghGitHub(exec);
  await assert.rejects(() => github.merge('o/r', 4, 'd'.repeat(40)), /permission denied/);
});
