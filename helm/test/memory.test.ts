import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store.js';
import { cgLogSchema, cgWriteSchema, createMemory, memoryWriteInput } from '../src/memory.js';

function setup() { const home = mkdtempSync(join(tmpdir(), 'helm-memory-')); const store = openStore(':memory:'); const memory = createMemory({ store, home, now: () => new Date('2026-09-30T12:00:00Z') }); return { home, store, memory }; }
function writeInput(summary = 'A useful summary') { return { scope: 'project' as const, project: 'acme/widgets', type: 'lesson', title: 'A useful lesson', summary, truth: 'The truth', tags: ['helm'], refs: [{ kind: 'gh', key: 'pr/197', title: 'D1a', checked: null }] }; }

test('memory.write refuses a missing or empty summary', async () => {
  assert.equal(memoryWriteInput.safeParse({ ...writeInput(), summary: undefined }).success, false);
  const { memory } = setup();
  assert.equal((await memory.write({ ...writeInput(), summary: ' ' })).ok, false);
});

test('memory.write renders the CG page shape and enqueues exact cg_write args', async () => {
  const { home, store, memory } = setup(); const result = await memory.write(writeInput()); assert.equal(result.ok, true);
  const page = readFileSync(join(home, 'memory/projects/widgets/lesson/a-useful-lesson.md'), 'utf8');
  assert.match(page, /^---\ntype: "lesson"\ntitle: "A useful lesson"\nsummary: "A useful summary"/);
  assert.match(page, /\nThe truth\n---\n$/);
  const row = store.sql.prepare('SELECT op, path, args FROM memory_outbox').get() as { op: string; path: string; args: string };
  assert.equal(row.op, 'write'); assert.equal(row.path, 'projects/widgets/lesson/a-useful-lesson.md'); assert.equal(cgWriteSchema.safeParse(JSON.parse(row.args)).success, true);
  assert.equal((JSON.parse(row.args) as { scope: { name: string } }).scope.name, 'widgets');
});

test('memory.log prepends a dated entry directly below the timeline separator', async () => {
  const { home, store, memory } = setup(); const written = await memory.write(writeInput()); assert.equal(written.ok, true);
  await memory.log({ path: 'projects/widgets/lesson/a-useful-lesson.md', entry: 'new event' }); await memory.log({ path: 'projects/widgets/lesson/a-useful-lesson.md', entry: 'newer event' });
  const page = readFileSync(join(home, 'memory/projects/widgets/lesson/a-useful-lesson.md'), 'utf8');
  assert.ok(page.indexOf('2026-09-30 newer event') > page.indexOf('The truth'));
  assert.ok(page.indexOf('2026-09-30 newer event') < page.indexOf('2026-09-30 new event'));
  const rows = store.sql.prepare('SELECT op, args FROM memory_outbox ORDER BY id').all() as Array<{ op: string; args: string }>;
  assert.deepEqual(rows.map((row) => row.op), ['write', 'log', 'log']); assert.equal(cgLogSchema.safeParse(JSON.parse(rows[1]!.args)).success, true); assert.equal(cgLogSchema.safeParse(JSON.parse(rows[2]!.args)).success, true);
});

test('memory.write refuses a truth divider and list filters project and type', async () => {
  const { memory } = setup(); assert.deepEqual(await memory.write({ ...writeInput(), truth: 'bad\n---\ntruth' }), { ok: false, reason: 'truth may not contain a --- line (it separates truth from the timeline); use *** for a divider' });
  assert.equal((await memory.write(writeInput())).ok, true); assert.equal((await memory.write({ ...writeInput(), scope: 'team', project: undefined, type: 'retro', title: 'Team retro' })).ok, true);
  const projectList = await memory.list({ project: 'acme/widgets' }); const typeList = await memory.list({ type: 'retro' });
  assert.equal(projectList.ok, true); assert.equal(typeList.ok, true);
  if (projectList.ok && typeList.ok) {
    assert.equal(projectList.memories.length, 1);
    assert.equal(typeList.memories.length, 1);
  }
});

test('memory.log refuses traversal paths and leaves outside files unchanged', async () => {
  const { home, memory } = setup(); const victim = join(home, 'victim.txt');
  const { writeFileSync } = await import('node:fs'); writeFileSync(victim, 'safe');
  const result = await memory.log({ path: '../victim.txt', entry: 'overwrite' });
  assert.equal(result.ok, false); assert.equal(readFileSync(victim, 'utf8'), 'safe');
});
