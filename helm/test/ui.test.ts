import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, renderDashboardShell } from '../src/ui.js';

test('dashboard shell is a self-contained document that polls the JSON endpoints', () => {
  const html = renderDashboardShell();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes('<title>Helm</title>'));
  for (const path of ['/api/state', '/api/worker/', '/api/events?after=']) assert.ok(html.includes(path), `missing ${path}`);
  assert.ok(html.includes('/mcp'));
  assert.doesNotMatch(html, /<script\s+src=/i, 'no external scripts');
  assert.doesNotMatch(html, /<link\b/i, 'no external stylesheets');
  assert.doesNotMatch(html, /\beval\(/, 'no eval');
  assert.doesNotMatch(html, /https?:\/\//, 'no external URLs');
  assert.ok(html.includes('document.hidden'), 'pauses polling when hidden');
  assert.ok(html.includes('Intl.NumberFormat'));
  assert.ok(html.includes('<canvas'));
  assert.ok(html.includes('Read only. JSON at <code>/api/state</code>; tools over MCP at <code>/mcp</code>.'));
  assert.ok(html.split('\n').length < 450, 'shell stays compact');
});

test('escapeHtml escapes the five HTML-significant characters', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml('a & b <c> "d" \'e\''), 'a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;');
  assert.equal(escapeHtml('plain text'), 'plain text');
  assert.equal(escapeHtml(''), '');
});
