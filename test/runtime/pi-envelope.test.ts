import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnvelope } from '../../src/runtime/pi/index.js';

const report = JSON.stringify({ status: 'succeeded', summary: 'done', changed_files: [], commits: [], decisions: [], discoveries: [], tests_claimed: [], acceptance_claims: [], risks: [], unresolved: [], artifacts: [], recommended_next_action: 'review' });

test('accepts exactly one whole JSON fence while retaining strict WorkerResult validation', () => {
  assert.equal(parseEnvelope(`\`\`\`json\n${report}\n\`\`\``)?.status, 'succeeded');
  assert.equal(parseEnvelope(report)?.status, 'succeeded');
  assert.equal(parseEnvelope(`note\n\`\`\`json\n${report}\n\`\`\``), undefined);
  assert.equal(parseEnvelope(`\`\`\`json\n${report}\n\`\`\`\n\`\`\`json\n${report}\n\`\`\``), undefined);
  assert.equal(parseEnvelope('```json\n{"status":"succeeded"}\n```'), undefined);
});
