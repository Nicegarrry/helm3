import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkerResult,
  workerResultInstructions,
  workerResultCorrection,
} from '../../src/host/worker-result-format.js';
import { workerResultSchema, type WorkerResult } from '../../src/contracts/index.js';

const EXAMPLE_BEGIN = '<<WORKER_RESULT_EXAMPLE_BEGIN>>';
const EXAMPLE_END = '<<WORKER_RESULT_EXAMPLE_END>>';

// A valid result with nonempty object-typed acceptance_claims and artifacts.
const validResult: WorkerResult = {
  status: 'succeeded',
  summary: 'Implement the format helper.',
  changed_files: ['src/host/worker-result-format.ts'],
  commits: ['deadbee'],
  decisions: ['Keep helper pure.'],
  discoveries: ['Workers guessed nested types.'],
  tests_claimed: ['node --test'],
  acceptance_claims: [
    { criterionId: 'AC-1', claim: 'Types preserved.', evidenceRefs: ['test:parse', 'artifact:log'] },
  ],
  risks: ['Schema may drift.'],
  unresolved: ['Confirm wire order.'],
  artifacts: [{ ref: 'artifact:log', hash: 'sha256:abc', mediaType: 'text/plain' }],
  recommended_next_action: 'Wire into runtime.',
};

const validJson = JSON.stringify(validResult);

function fence(text: string): string {
  return '```json\n' + text + '\n```';
}

test('parseWorkerResult accepts direct strict JSON with object arrays', () => {
  const parsed = parseWorkerResult(validJson);
  assert.ok(parsed);
  assert.equal(parsed!.status, 'succeeded');
  assert.equal(parsed!.acceptance_claims[0]!.criterionId, 'AC-1');
  assert.deepEqual(parsed!.acceptance_claims[0]!.evidenceRefs, ['test:parse', 'artifact:log']);
  assert.equal(parsed!.artifacts[0]!.mediaType, 'text/plain');
  assert.deepEqual(parsed!.risks, ['Schema may drift.']);
});

test('parseWorkerResult accepts one complete whole-text json fence', () => {
  const parsed = parseWorkerResult(fence(validJson));
  assert.ok(parsed);
  assert.equal(parsed!.summary, validResult.summary);
});

test('parseWorkerResult refuses a json fence wrapped in prose', () => {
  assert.equal(parseWorkerResult('intro\n' + fence(validJson)), undefined);
  assert.equal(parseWorkerResult(fence(validJson) + '\ntrailing note'), undefined);
});

test('parseWorkerResult refuses an uppercase fence (lowercase only)', () => {
  assert.equal(parseWorkerResult('```JSON\n' + validJson + '\n```'), undefined);
});

test('parseWorkerResult refuses prose-prefixed JSON', () => {
  assert.equal(parseWorkerResult('Done. Here is the result: ' + validJson), undefined);
});

test('parseWorkerResult refuses concatenated JSON objects', () => {
  assert.equal(parseWorkerResult(validJson + validJson), undefined);
});

test('parseWorkerResult refuses wrong nested field types (risks as object[])', () => {
  const wrong = JSON.stringify({ ...validResult, risks: [{ why: 'nope' }] });
  assert.equal(parseWorkerResult(wrong), undefined);
});

test('parseWorkerResult refuses missing required fields', () => {
  const missing = { ...validResult } as Record<string, unknown>;
  delete missing.summary;
  assert.equal(parseWorkerResult(JSON.stringify(missing)), undefined);
});

test('parseWorkerResult refuses empty required strings', () => {
  assert.equal(parseWorkerResult(JSON.stringify({ ...validResult, summary: '' })), undefined);
});

test('workerResultCorrection flags risks.0 expected string without leaking secrets', () => {
  const bad = JSON.stringify({
    ...validResult,
    risks: [{ top_secret_field_name: 'NESTED_SENTINEL_VALUE' }],
  });
  const correction = workerResultCorrection(bad);
  assert.match(correction, /risks\.0/);
  assert.match(correction, /expected string/);
  assert.ok(!correction.includes('NESTED_SENTINEL_VALUE'));
  assert.ok(!correction.includes('top_secret_field_name'));
});

test('workerResultCorrection never echoes unknown top-level property names', () => {
  const bad = JSON.stringify({ ...validResult, rogue_root_key: 'Z' });
  const correction = workerResultCorrection(bad);
  assert.ok(!correction.includes('rogue_root_key'));
});

test('workerResultCorrection bounds schema issue bullets at 8', () => {
  const many = JSON.stringify({
    ...validResult,
    changed_files: {},
    commits: {},
    decisions: {},
    discoveries: {},
    tests_claimed: {},
    risks: {},
    unresolved: {},
    acceptance_claims: {},
    artifacts: {},
    summary: '',
    recommended_next_action: '',
  });
  const correction = workerResultCorrection(many);
  const issueLines = correction
    .split('\n')
    .filter((line) => /^- [\w.]+: [a-z_]+(?: \(|$)/.test(line));
  assert.ok(issueLines.length <= 8, `got ${issueLines.length}`);
  assert.equal(issueLines.length, 8);
  assert.match(correction, /more issue/);
});

test('workerResultCorrection says invalid JSON for malformed input without echoing it', () => {
  const malformed = '{"summary":"MALFORMED_SENTINEL", broken,,,';
  const correction = workerResultCorrection(malformed);
  assert.match(correction, /invalid JSON/);
  assert.ok(!correction.includes('MALFORMED_SENTINEL'));
});

test('workerResultCorrection bounds oversized UTF-8 input', () => {
  const big = 'BIG_SENTINEL_PREFIX ' + 'x'.repeat(130 * 1024);
  const correction = workerResultCorrection(big);
  assert.ok(correction.length < big.length);
  assert.ok(!correction.includes('BIG_SENTINEL_PREFIX'));
  assert.match(correction, /exceeds the maximum size/);
});

test('workerResultCorrection does not rewrite an already-valid result', () => {
  const correction = workerResultCorrection(validJson);
  assert.match(correction, /already validates/);
  assert.match(correction, /[Dd]o not rewrite/);
});

test('workerResultInstructions embeds a schema-valid, machine-extractable example', () => {
  const instructions = workerResultInstructions();
  const begin = instructions.indexOf(EXAMPLE_BEGIN);
  const end = instructions.indexOf(EXAMPLE_END);
  assert.ok(begin >= 0 && end > begin);
  const exampleText = instructions.slice(begin + EXAMPLE_BEGIN.length, end).trim();
  const example = JSON.parse(exampleText);
  assert.ok(workerResultSchema.safeParse(example).success);
  assert.match(instructions, /PLACEHOLDER/);
});


test('whole-fence compatibility does not trim leading whitespace or accept extra fence labels', () => {
  assert.equal(parseWorkerResult(' ' + fence(validJson)), undefined);
  assert.equal(parseWorkerResult(fence(validJson) + ' '), undefined);
  assert.equal(parseWorkerResult('```json extra\n' + validJson + '\n```'), undefined);
  assert.deepEqual(parseWorkerResult(' \n' + validJson + '\n '), validResult);
  assert.deepEqual(parseWorkerResult('```json\r\n' + validJson + '\r\n```'), validResult);
});

test('correction size cap counts UTF-8 bytes rather than JavaScript characters', () => {
  const oversized = JSON.stringify({ ...validResult, summary: 'é'.repeat(70 * 1024) });
  assert.ok(oversized.length < 128 * 1024);
  assert.match(workerResultCorrection(oversized), /exceeds the maximum size/);
});
