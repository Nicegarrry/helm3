import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Jev, JevAnswer, JevQuestion } from './jev.js';
import type { MemoryService } from './memory.js';
import type { Settings } from './settings.js';

type Skill = { id: string; name: string; description: string; body: string };
type Lesson = { slug: string; summary: string; truth: string };
export type Selection = { guidance: string; skills: string[]; suggested?: Record<string, unknown>; warning?: string };

const none = 'no skill fits; a plain edit, command or routine change';
const lessonNone = 'no lesson fits; a plain edit, command or routine change';
const skillInstruction = 'Which skill should be loaded for this task? Choose "none" if the task is routine and no skill specifically covers it.';
const lessonInstruction = 'Which lesson should be applied to this task? Choose "none" if the task is routine and no lesson specifically covers it.';

function text(value: string): string { return value.trim().slice(0, 350); }
function frontmatter(source: string, key: string): string { const match = source.match(new RegExp(`^${key}:\\s*(.*)$`, 'm')); if (!match) return ''; try { return JSON.parse(match[1]!) as string; } catch { return match[1]!.replace(/^['"]|['"]$/g, ''); } }
function content(source: string): string { const first = source.indexOf('---'); const second = first < 0 ? -1 : source.indexOf('---', first + 3); return second < 0 ? source : source.slice(second + 3).trim(); }
function truth(source: string): string { return content(source).split(/\n---\s*(?:\n|$)/, 1)[0]!.trim(); }
function pathFor(dir: string, name: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return ''; const expanded = dir === '~' ? homedir() : dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir; return join(resolve(expanded), name, 'SKILL.md'); }
function readSkill(dirs: readonly string[], id: string): Skill | undefined { for (const dir of dirs) { try { const path = pathFor(dir, id); if (!statSync(path).isFile()) continue; const source = readFileSync(path, 'utf8'); const frontName = frontmatter(source, 'name'); if (!frontName) continue; return { id, name: frontName, description: text(frontmatter(source, 'description')), body: content(source).slice(0, 8000) }; } catch { /* absent or unreadable skills are not catalogued */ } } return undefined; }
function answer(answers: Record<string, JevAnswer>, key: string): { choice?: string; confidence: number } { const value = answers[key]; return { choice: value?.choice, confidence: typeof value?.confidence === 'number' ? value.confidence : 0 }; }

export function createSelector(options: { settings: Settings; memory: MemoryService; jev?: Jev; home: string }) {
  async function catalog(): Promise<{ skills: Skill[]; lessons: Lesson[] }> {
    const skills = options.settings.select.skillAllow.map((name) => readSkill(options.settings.select.skillDirs, name)).filter((skill): skill is Skill => Boolean(skill));
    const listed = await options.memory.list({ type: 'lesson' });
    const lessons: Lesson[] = [];
    if (listed.ok) for (const row of listed.memories) { try { const source = readFileSync(join(resolve(options.settings.memory.dir ?? join(options.home, 'memory')), row.path), 'utf8'); if (frontmatter(source, 'status') !== 'active') continue; lessons.push({ slug: basename(row.path, '.md'), summary: row.summary, truth: truth(source).slice(0, 1500) }); } catch { /* stale mirror entries are ignored */ } }
    return { skills, lessons };
  }
  async function select(input: { objective: string; acceptance?: string | null; skills?: string[] }): Promise<Selection> {
    let skills: Skill[]; let lessons: Lesson[];
    try { ({ skills, lessons } = await catalog()); } catch (error) {
      if (input.skills === undefined) return { guidance: '', skills: [], warning: `selection warning: ${error instanceof Error ? error.message : String(error)}` };
      throw error;
    }
    if (input.skills !== undefined) {
      if (input.skills.includes('none')) { if (input.skills.length !== 1) throw new Error('explicit skills cannot combine none with a skill'); return { guidance: '', skills: [] }; }
      const chosen = input.skills.map((name) => skills.find((skill) => skill.id === name));
      if (chosen.some((skill) => !skill)) throw new Error('explicit skill is not in select.skillAllow or is unavailable');
      return { guidance: chosen.map((skill) => `${skill!.name}\n${skill!.body}`).join('\n\n'), skills: input.skills };
    }
    if ((!skills.length && !lessons.length) || !options.jev) return { guidance: '', skills: [] };
    const questions: Record<string, JevQuestion> = {
      skill_or_none: { type: 'choice', instructions: skillInstruction, criteria: { ...Object.fromEntries(skills.map((skill) => [skill.name, skill.description])), none } },
    };
    if (lessons.length) questions.lesson_or_none = { type: 'choice', instructions: lessonInstruction, criteria: { ...Object.fromEntries(lessons.map((lesson) => [lesson.slug, lesson.summary])), none: lessonNone } };
    let result: Awaited<ReturnType<Jev['ask']>>;
    try { result = await options.jev.ask('select', { state: { objective: input.objective, acceptance: input.acceptance ?? null }, questions }); } catch (error) { return { guidance: '', skills: [], warning: `selection warning: ${error instanceof Error ? error.message : String(error)}` }; }
    if (!result.ok) return { guidance: '', skills: [], warning: `selection warning: ${result.reason}` };
    const skillAnswer = answer(result.answers, 'skill_or_none'); const selectedSkill = skills.find((skill) => skill.name === skillAnswer.choice);
    const lessonAnswer = answer(result.answers, 'lesson_or_none'); const selectedLesson = lessons.find((lesson) => lesson.slug === lessonAnswer.choice);
    const auto = options.settings.select.autoAt;
    const guidance: string[] = []; const selected = selectedSkill && skillAnswer.confidence >= auto ? [selectedSkill] : [];
    if (selected.length) guidance.push(`${selected[0]!.name}\n${selected[0]!.body}`);
    if (selectedLesson && lessonAnswer.confidence >= auto && options.settings.select.lessons === 'on') guidance.push(`${selectedLesson.slug}\n${selectedLesson.truth}`);
    const suggested = (selectedSkill && !selected.length) || (selectedLesson && (lessonAnswer.confidence < auto || options.settings.select.lessons === 'shadow'));
    return { guidance: guidance.join('\n\n'), skills: selected.map((skill) => skill.name), ...(suggested ? { suggested: { skill: skillAnswer.choice ?? 'none', lesson: lessonAnswer.choice ?? 'none', confidence: Math.max(skillAnswer.confidence, lessonAnswer.confidence) } } : {}) };
  }
  return { select };
}
