import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const dashboard = (name: string) => readFileSync(join(process.cwd(), 'dashboard', name), 'utf8');
test('mobile dashboard has private relative polling, source filters, strict stale/offline state, and no unsafe HTML writes', () => {
  const html = dashboard('index.html'); const app = dashboard('app.js'); const css = dashboard('styles.css');
  assert.match(html, /id="project"/); assert.match(html, /id="state"/); assert.match(html, /id="source"/); assert.match(html, /source-health/); assert.match(app, /\.herenow\/data\/fleet\?limit=1/);
  assert.match(app, /STALE_MS = 90_000/); assert.match(app, /document\.hidden/); assert.match(app, /offline = true/); assert.match(app, /validSnapshot/); assert.match(app, /Waiting for first snapshot/);
  assert.match(app, /textContent/); assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML/);
  assert.match(app, /worker-details/); assert.match(app, /sourceId/); assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/); assert.match(css, /overflow-wrap: anywhere/); assert.match(css, /state-failed/);
  assert.match(css, /min-height: 44px/); assert.match(css, /prefers-color-scheme/); assert.match(css, /min-width: 700px/);
});
