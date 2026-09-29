import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSelector } from '../src/select.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { Jev, JevAnswers } from '../src/jev.js';
import type { MemoryService } from '../src/memory.js';

function fixture(answers: JevAnswers, lessons = true) {
  const home = mkdtempSync(join(tmpdir(), 'helm-select-')); const skills = join(home, 'skills');
  mkdirSync(join(skills, 'allowed'), { recursive: true });
  writeFileSync(join(skills, 'allowed', 'SKILL.md'), '---\nname: allowed\ndescription: the allowed skill\n---\nUse this guidance.');
  const lessonPath = 'team/lesson/keep.md';
  if (lessons) { mkdirSync(join(home, 'memory', 'team', 'lesson'), { recursive: true }); writeFileSync(join(home, 'memory', lessonPath), '---\ntype: lesson\ntitle: Keep\nsummary: keep the change narrow\nstatus: "active"\n---\nPreserve the existing seam.\n---\n'); }
  const settings = loadSettings(home); const configured = { ...settings, memory: {}, select: { ...settings.select, skillDirs: [skills], skillAllow: ['allowed'] } };
  const memory: MemoryService = { write: async () => ({ ok: false, reason: 'unused' }), log: async () => ({ ok: false, reason: 'unused' }), list: async () => ({ ok: true, memories: lessons ? [{ path: lessonPath, title: 'Keep', summary: 'keep the change narrow' }] : [] }) };
  const store = openStore(':memory:'); const calls: Array<{ purpose: string; input: any }> = [];
  const jev: Jev = { shadow: true, async ask(purpose, input) { calls.push({ purpose, input }); return { ok: true, answers }; } };
  return { home, settings: configured, memory, store, calls, jev };
}

test('selection inlines a high-confidence skill and caps catalog descriptions', async () => {
  const f = fixture({ skill_or_none: { choice: 'allowed', confidence: 0.72, probabilities: {} }, lesson_or_none: { choice: 'none', confidence: 0.9, probabilities: {} } });
  try { const result = await createSelector({ ...f }).select({ objective: 'task', acceptance: 'done' }); assert.match(result.guidance, /Use this guidance/); assert.deepEqual(result.skills, ['allowed']); assert.equal(f.calls[0]!.input.state.acceptance, 'done'); assert.ok(!('forbidden' in f.calls[0]!.input.questions.skill_or_none.criteria)); } finally { f.store.close(); }
});

test('low confidence is suggestion-only, none and explicit none do not inline or call', async () => {
  const f = fixture({ skill_or_none: { choice: 'allowed', confidence: 0.65, probabilities: {} }, lesson_or_none: { choice: 'none', confidence: 0.65, probabilities: {} } });
  try { const selector = createSelector({ ...f }); const low = await selector.select({ objective: 'task' }); assert.equal(low.guidance, ''); assert.equal(low.suggested?.skill, 'allowed'); const before = f.calls.length; const none = await selector.select({ objective: 'task', skills: ['none'] }); assert.equal(none.guidance, ''); assert.equal(f.calls.length, before); } finally { f.store.close(); }
});

test('shadow lessons are suggested but never inlined and explicit disallowed skills refuse', async () => {
  const f = fixture({ skill_or_none: { choice: 'none', confidence: 0.9, probabilities: {} }, lesson_or_none: { choice: 'keep', confidence: 0.9, probabilities: {} } });
  try { const selector = createSelector({ ...f }); const shadow = await selector.select({ objective: 'task' }); assert.equal(shadow.guidance, ''); assert.equal(shadow.suggested?.lesson, 'keep'); await assert.rejects(() => selector.select({ objective: 'task', skills: ['outside'] }), /not in select.skillAllow/); } finally { f.store.close(); }
});

test('a Jev no-key result returns a warning without guidance', async () => {
  const f = fixture({}); const noKey: Jev = { shadow: true, async ask() { return { ok: false, reason: 'no key' }; } };
  try { const result = await createSelector({ ...f, jev: noKey }).select({ objective: 'task' }); assert.equal(result.guidance, ''); assert.match(result.warning!, /no key/); } finally { f.store.close(); }
});
