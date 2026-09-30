import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error line-cap.mjs is tested directly and has no declaration file.
import { parseCap } from '../scripts/line-cap.mjs';

test('parseCap reads the decimal k cap from AGENTS.md', () => {
  assert.equal(parseCap('Keep `helm/src` under 11.0k lines.'), 11_000);
});
