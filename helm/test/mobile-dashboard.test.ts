import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const dashboard = (name: string) => readFileSync(join(process.cwd(), 'dashboard', name), 'utf8');
test('mobile dashboard has private relative polling, source filters, strict stale/offline state, and no unsafe HTML writes', () => {
  const html = dashboard('index.html'); const app = dashboard('app.js'); const css = dashboard('styles.css');
  const releaseVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;
  const assetVersions = [...html.matchAll(/(?:href|src)="(?:styles|app)\.\w+\?v=([^\"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(assetVersions, [releaseVersion, releaseVersion]);
  assert.match(html, /id="project"/); assert.match(html, /id="state"/); assert.match(html, /id="source"/); assert.match(html, /source-health/); assert.match(app, /\.herenow\/data\/fleet\?limit=1/);
  assert.match(app, /STALE_MS = 90_000/); assert.match(app, /document\.hidden/); assert.match(app, /offline = true/); assert.match(app, /validSnapshot/); assert.match(app, /Waiting for first snapshot/);
  assert.match(app, /textContent/); assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML/);
  assert.match(app, /worker-details/); assert.match(app, /sourceId/); assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/); assert.match(css, /overflow-wrap: anywhere/); assert.match(css, /state-failed/);
  assert.match(html, /id="appearance"/); assert.match(html, /helm-fleet-appearance/); assert.match(css, /#f5f2ec/); assert.match(css, /#fffaf3/); assert.match(css, /#8d443b/); assert.match(css, /Bricolage Grotesque/); assert.match(css, /Hanken Grotesk/); assert.match(css, /JetBrains Mono/);
  assert.match(css, /min-height: 44px/); assert.match(css, /prefers-color-scheme/); assert.match(css, /min-width: 700px/); assert.match(app, /media\.addEventListener\('change'/);
});


test('browser validation rejects malformed snapshots and source freshness ages independently', async () => {
  const app = await import(new URL('../dashboard/app.js', import.meta.url).href);
  const now = Date.now();
  const snapshot = { schemaVersion: 2, observedAt: new Date(now).toISOString(), run: {},
    counts: {totalWorkers:0,activeWorkers:0,publishedWorkers:0,truncatedWorkers:0,sourcesComplete:true},
    sources: [{sourceId:'one',status:'live',observedAt:new Date(now).toISOString()}], workers:[], models:[] };
  assert.equal(app.validSnapshot(snapshot), true);
  for (const patch of [{schemaVersion:9},{observedAt:'invalid'},{workers:[null]},{sources:[null]},{models:[null]},{counts:{}}]) {
    assert.equal(Boolean(app.validSnapshot({...snapshot,...patch})), false);
  }
  assert.equal(app.sourceStatus(snapshot.sources[0], now + 91000), 'stale');
  assert.equal(app.sourceStatus({...snapshot.sources[0],status:'unavailable'}, now), 'unavailable');
});

test('appearance preference persists when storage is available and fails closed when it is blocked', async () => {
  const app = await import(new URL('../dashboard/app.js', import.meta.url).href);
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  assert.equal(app.persistAppearance('dark', storage), true);
  assert.equal(values.get(app.APPEARANCE_STORAGE_KEY), 'dark');
  assert.equal(app.readAppearance(storage), 'dark');
  values.set(app.APPEARANCE_STORAGE_KEY, 'not-a-theme');
  assert.equal(app.readAppearance(storage), 'system');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(app.readAppearance(blocked), 'system');
  assert.equal(app.persistAppearance('light', blocked), false);
  assert.equal(app.persistAppearance('light'), false);
});

test('system appearance follows later OS colour-scheme changes without overriding explicit choices', async () => {
  const app = await import(new URL('../dashboard/app.js', import.meta.url).href);
  assert.equal(app.resolvedTheme('system', false), 'light');
  assert.equal(app.resolvedTheme('system', true), 'dark');
  assert.equal(app.resolvedTheme('light', true), 'light');
  assert.equal(app.resolvedTheme('dark', false), 'dark');
});
