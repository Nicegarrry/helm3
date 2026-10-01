import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Helm, type PromptInput } from '../src/helm.js';
import { createSelector } from '../src/select.js';
import { loadSettings } from '../src/settings.js';
import { openStore } from '../src/store.js';
import type { Jev, JevAnswers } from '../src/jev.js';
import type { MemoryService } from '../src/memory.js';
import type { GateRunner, GitHub, HelmConfig, PrStatus, WorkerRunner, Workspace } from '../src/types.js';

function fixture(answers: JevAnswers, lessons = true, skillSources: Record<string, string> = { allowed: '---\nname: allowed\ndescription: the allowed skill\n---\nUse this guidance.' }) {
  const home = mkdtempSync(join(tmpdir(), 'helm-select-')); const skills = join(home, 'skills');
  for (const [name, source] of Object.entries(skillSources)) { mkdirSync(join(skills, name), { recursive: true }); writeFileSync(join(skills, name, 'SKILL.md'), source); }
  const lessonPath = 'team/lesson/keep.md';
  if (lessons) { mkdirSync(join(home, 'memory', 'team', 'lesson'), { recursive: true }); writeFileSync(join(home, 'memory', lessonPath), '---\ntype: lesson\ntitle: Keep\nsummary: keep the change narrow\nstatus: "active"\n---\nPreserve the existing seam.\n---\n'); }
  const settings = loadSettings(home); const configured = { ...settings, memory: {}, select: { ...settings.select, skillDirs: [skills], skillAllow: Object.keys(skillSources) } };
  const memory: MemoryService = { write: async () => ({ ok: false, reason: 'unused' }), log: async () => ({ ok: false, reason: 'unused' }), list: async () => ({ ok: true, memories: lessons ? [{ path: lessonPath, title: 'Keep', summary: 'keep the change narrow' }] : [] }) };
  const store = openStore(':memory:'); const calls: Array<{ purpose: string; input: any }> = [];
  const jev: Jev = { shadow: true, async ask(purpose, input) { calls.push({ purpose, input }); return { ok: true, answers }; } };
  return { home, settings: configured, memory, store, calls, jev };
}

function spawnFixture(answers: JevAnswers, jevOverride?: Jev) {
  const f = fixture(answers); const messages: string[] = []; const repo = mkdtempSync(join(tmpdir(), 'helm-select-repo-'));
  const workspace: Workspace = { async resolveSha(_repo, ref) { return ref; }, async defaultBranch() { return 'main'; }, async create(_repo, path, branch, baseSha) { return { path, branch, baseSha }; }, async remove() {}, async head() { return 'a'.repeat(40); }, async isClean() { return true; }, async diffStat() { return ''; }, async patchId() { return 'patch'; }, async commitAll() { return 'commit'; }, async push() {}, async clone() {}, async fetch() {} };
  const gates: GateRunner = { async run() { return { passed: true, checks: [] }; }, async defaultChecks() { return []; } };
  const github: GitHub = { async openPr() { return { number: 1, url: 'https://example.invalid/1' }; }, async prStatus(_repo, number): Promise<PrStatus> { return { number, state: 'open', head: 'a'.repeat(40), mergeable: true, draft: false, checks: [], reviews: [], url: 'https://example.invalid/1' }; }, async comment() { return { body: '' }; }, async postComment() { return 'https://github.com/o/r/pull/1#issuecomment-1'; }, async merge() {} };
  const runner: WorkerRunner = { async run() { return { result: { status: 'succeeded', summary: 'done', changedFiles: [], commandsRun: [] }, rawText: '', sessionFile: null }; } };
  const config: HelmConfig = { home: f.home, spendCapUsd: 0, maxWorkers: 3, gateTimeoutMs: 5000 };
  const helm = new Helm({ config, store: f.store, workspace, gates, github, runner, settings: f.settings, jev: jevOverride ?? f.jev, prompts: { builder: (input: PromptInput) => { const message = input.guidance ? `Guidance selected for this task\n${input.guidance}` : 'plain'; messages.push(message); return message; }, reviewer: () => 'review', validator: () => 'validate' } });
  return { ...f, helm, repo, messages };
}

test('0.72 inlines the skill body under the guidance heading and records worker_meta.skills', async () => {
  const f = spawnFixture({ skill_or_none: { choice: 'allowed', confidence: 0.72, probabilities: {} }, lesson_or_none: { choice: 'none', confidence: 0.9, probabilities: {} } });
  try { const result = await f.helm.spawn({ repo: f.repo, objective: 'task', acceptance: 'done', model: 'acme/model', role: 'builder', contextPaths: [], allowWorkflows: false }); assert.equal(result.ok, true); if (!result.ok) return; assert.ok(result.workerId); await f.helm.settle(result.workerId); assert.match(f.messages[0]!, /Guidance selected for this task/); assert.match(f.messages[0]!, /Use this guidance/); assert.deepEqual(f.store.getMeta(result.workerId)?.skills, ['allowed']); } finally { f.store.close(); }
});

test('0.65 records select.suggested only and inlines nothing', async () => {
  const f = spawnFixture({ skill_or_none: { choice: 'allowed', confidence: 0.65, probabilities: {} }, lesson_or_none: { choice: 'none', confidence: 0.65, probabilities: {} } });
  try { const result = await f.helm.spawn({ repo: f.repo, objective: 'task', model: 'acme/model', role: 'builder', contextPaths: [], allowWorkflows: false }); assert.equal(result.ok, true); if (!result.ok) return; assert.ok(result.workerId); const events = f.store.listEvents(result.workerId).filter((event) => event.kind.startsWith('select')); assert.deepEqual(events.map((event) => event.kind), ['select.suggested']); assert.equal(f.messages[0], 'plain'); await f.helm.settle(result.workerId); } finally { f.store.close(); }
});

test("choice 'none' inlines nothing", async () => {
  const f = fixture({ skill_or_none: { choice: 'none', confidence: 0.9, probabilities: {} }, lesson_or_none: { choice: 'none', confidence: 0.9, probabilities: {} } });
  try { const result = await createSelector({ ...f }).select({ objective: 'task' }); assert.equal(result.guidance, ''); assert.deepEqual(result.skills, []); } finally { f.store.close(); }
});

test("explicit ['none'] skips Jev", async () => {
  const f = fixture({});
  try { const result = await createSelector({ ...f }).select({ objective: 'task', skills: ['none'] }); assert.equal(result.guidance, ''); assert.equal(f.calls.length, 0); } finally { f.store.close(); }
});

test('an explicit skill outside skillAllow is refused', async () => {
  const f = fixture({});
  try { await assert.rejects(() => createSelector({ ...f }).select({ objective: 'task', skills: ['outside'] }), /not in select.skillAllow/); } finally { f.store.close(); }
});

test('a skill outside skillAllow never appears in Jev criteria', async () => {
  const f = fixture({ skill_or_none: { choice: 'none', confidence: 0.9, probabilities: {} }, lesson_or_none: { choice: 'none', confidence: 0.9, probabilities: {} } });
  try { await createSelector({ ...f }).select({ objective: 'task' }); const criteria = f.calls[0]!.input.questions.skill_or_none.criteria; assert.deepEqual(Object.keys(criteria), ['allowed', 'none']); assert.ok(!Object.hasOwn(criteria, 'outside')); } finally { f.store.close(); }
});

test('skill description frontmatter handles folded, literal, quoted-colon, and missing values', async () => {
  const f = fixture({ skill_or_none: { choice: 'none', confidence: 0.9, probabilities: {} } }, false, {
    folded: '---\nname: folded\ndescription: >\n  first folded line\n  second folded line\n---\nbody',
    literal: '---\nname: literal\ndescription: |\n  first literal line\n  second literal line\n---\nbody',
    quoted: '---\nname: quoted\ndescription: "quoted: value"\n---\nbody',
    missing: '---\nname: missing\n---\nbody',
  });
  try { await createSelector({ ...f }).select({ objective: 'task' }); const criteria = f.calls[0]!.input.questions.skill_or_none.criteria; assert.equal(criteria.folded, 'first folded line second folded line'); assert.equal(criteria.literal, 'first literal line second literal line'); assert.equal(criteria.quoted, 'quoted: value'); assert.equal(criteria.missing, 'missing'); } finally { f.store.close(); }
});

test('lessons in shadow mode are suggested but never inlined', async () => {
  const f = fixture({ skill_or_none: { choice: 'none', confidence: 0.9, probabilities: {} }, lesson_or_none: { choice: 'keep', confidence: 0.9, probabilities: {} } });
  try { const shadow = await createSelector({ ...f }).select({ objective: 'task' }); assert.equal(shadow.guidance, ''); assert.equal(shadow.suggested?.lesson, 'keep'); } finally { f.store.close(); }
});

test('no key lets spawn succeed with no guidance and a warning', async () => {
  const f = fixture({}); const noKey: Jev = { shadow: true, async ask() { return { ok: false, reason: 'no key' }; } };
  const spawned = spawnFixture({}, noKey);
  try { const result = await spawned.helm.spawn({ repo: spawned.repo, objective: 'task', model: 'acme/model', role: 'builder', contextPaths: [], allowWorkflows: false }); assert.equal(result.ok, true); assert.match(result.ok ? result.warning! : '', /no key/); assert.equal(spawned.messages[0], 'plain'); if (result.ok) { assert.ok(result.workerId); await spawned.helm.settle(result.workerId); } } finally { f.store.close(); spawned.store.close(); }
});

test('slow Jev selection does not hold the spawn lock', async () => {
  let release!: () => void; let called!: () => void; const selected = new Promise<void>((resolve) => { called = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture({}); const slow: Jev = { shadow: true, async ask() { called(); await gate; return { ok: true, answers: { skill_or_none: { choice: 'none', confidence: 0.9, probabilities: {} }, lesson_or_none: { choice: 'none', confidence: 0.9, probabilities: {} } } }; } };
  const spawned = spawnFixture({}, slow);
  try { const first = spawned.helm.spawn({ repo: spawned.repo, objective: 'slow', model: 'acme/model', role: 'builder', contextPaths: [], allowWorkflows: false }); await selected; const second = await spawned.helm.spawn({ repo: spawned.repo, objective: 'fast', model: 'acme/model', role: 'builder', contextPaths: [], allowWorkflows: false, skills: ['none'] }); assert.equal(second.ok, true); release(); const firstResult = await first; assert.equal(firstResult.ok, true); if (firstResult.ok) { assert.ok(firstResult.workerId); await spawned.helm.settle(firstResult.workerId); } if (second.ok) { assert.ok(second.workerId); await spawned.helm.settle(second.workerId); } } finally { release(); spawned.store.close(); }
});
