import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import type { Settings } from './settings.js';
import type { Store, ToolOutcome } from './types.js';
import { z } from 'zod';

const refSchema = z.object({ kind: z.string().min(1), key: z.string().min(1), title: z.string(), checked: z.string().nullable(), live: z.boolean().optional() }).strict();
export const cgWriteSchema = z.object({ path: z.string().min(1).optional(), scope: z.union([z.object({ kind: z.literal('team') }).strict(), z.object({ kind: z.literal('project'), name: z.string().min(1) }).strict(), z.object({ kind: z.literal('personal'), handle: z.string().min(1) }).strict()]), type: z.string().min(1), title: z.string().min(1), summary: z.string(), truth: z.string(), aliases: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), refs: z.array(refSchema).optional(), status: z.string().optional(), expectedSha: z.string().min(1).optional(), force: z.boolean().optional(), reason: z.string().optional() }).strict();
export const cgLogSchema = z.object({ path: z.string().min(1), entry: z.string().min(1), date: z.string().optional() }).strict();
export const memoryWriteInput = z.object({ scope: z.enum(['team', 'project']), project: z.string().min(1).optional(), type: z.string().min(1), title: z.string().min(1), summary: z.string().min(1), truth: z.string(), tags: z.array(z.string()).optional(), refs: z.array(refSchema).optional() }).strict();
export const memoryLogInput = z.object({ path: z.string().min(1), entry: z.string().min(1) }).strict();
export const memoryListInput = z.object({ project: z.string().min(1).optional(), type: z.string().min(1).optional() }).strict();
export type MemoryWriteInput = z.infer<typeof memoryWriteInput>;
export type MemoryLogInput = z.infer<typeof memoryLogInput>;
export type MemoryListInput = z.infer<typeof memoryListInput>;

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function segment(value: string, label: string): string { if (!SEGMENT.test(value) || value === '.' || value === '..') throw new Error(label === 'type' ? 'type must be lowercase letters, numbers and hyphens' : `${label} must be a safe path segment`); return value; }
function cgSlug(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, ''); }
function repoName(project: string): string { const value = cgSlug(project.split('/').at(-1) ?? project); if (!value) throw new Error('project must produce a safe path segment'); return segment(value, 'project'); }
function slug(title: string): string { const value = cgSlug(title); if (!value) throw new Error('title must produce a non-empty slug'); return segment(value, 'title'); }
function pagePath(input: MemoryWriteInput): string { const base = input.scope === 'team' ? join('team', segment(input.type, 'type')) : join('projects', repoName(input.project ?? ''), segment(input.type, 'type')); return join(base, `${slug(input.title)}.md`); }
function yaml(value: unknown): string { return JSON.stringify(value); }
function render(input: MemoryWriteInput, timeline = ''): string { return ['---', `type: ${yaml(input.type)}`, `title: ${yaml(input.title)}`, `summary: ${yaml(input.summary)}`, `tags: ${yaml(input.tags ?? [])}`, `refs: ${yaml(input.refs ?? [])}`, 'status: "active"', '---', input.truth, '---', timeline].join('\n'); }
function today(now: () => Date): string { return now().toISOString().slice(0, 10); }
function lines(text: string): string[] { return text.split(/\r\n?|\n/); }
function timelineLine(linesValue: string[]): number { if (linesValue[0] !== '---') return -1; const frontmatter = linesValue.indexOf('---', 1); return frontmatter < 0 ? -1 : linesValue.findIndex((line, index) => index > frontmatter && line === '---'); }
function preservedTimeline(text: string): string { const pageLines = lines(text); const separator = timelineLine(pageLines); return separator < 0 ? '' : pageLines.slice(separator + 1).join('\n'); }
function exists(path: string): boolean { try { statSync(path); return true; } catch { return false; } }
function safeMemoryPath(root: string, path: string): string | null { const parts = path.split('/'); const shape = parts[0] === 'team' ? parts.length === 3 : parts[0] === 'projects' && parts.length === 4; if (!shape || !parts.at(-1)?.endsWith('.md')) return null; const segments = parts.map((part, index) => index === parts.length - 1 ? part.slice(0, -3) : part); if (segments.slice(1).some((part) => !SEGMENT.test(part) || part === '.' || part === '..')) return null; const full = resolve(root, path); const rel = relative(root, full); if (rel.startsWith('..' + sep) || rel === '..' || rel.startsWith(sep) || !exists(full) || !statSync(full).isFile()) return null; return full; }
function frontmatterValue(text: string, key: string): string { const value = text.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? ''; try { return JSON.parse(value) as string; } catch { return value.replace(/^['"]|['"]$/g, ''); } }
function ensureTables(store: Store): void { store.sql.exec('CREATE TABLE IF NOT EXISTS memory_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT NOT NULL, path TEXT NOT NULL, args TEXT NOT NULL, createdAt TEXT NOT NULL, syncedAt TEXT, error TEXT)'); }
function enqueue(store: Store, op: 'write' | 'log', path: string, args: unknown, at: string): void { store.sql.prepare('INSERT INTO memory_outbox (op, path, args, createdAt, syncedAt, error) VALUES (?, ?, ?, ?, NULL, NULL)').run(op, path, JSON.stringify(args), at); }

export type MemoryService = Readonly<{ write(input: MemoryWriteInput): Promise<ToolOutcome<{ path: string }>>; log(input: MemoryLogInput): Promise<ToolOutcome<{ path: string }>>; list(input: MemoryListInput): Promise<ToolOutcome<{ memories: Array<{ path: string; title: string; summary: string }> }>> }>;

export function createMemory(options: { store: Store; home: string; settings?: Pick<Settings, 'memory'>; now?: () => Date }): MemoryService {
  const root = resolve(options.settings?.memory.dir ?? join(options.home, 'memory')); const now = options.now ?? (() => new Date()); ensureTables(options.store);
  const write = async (input: MemoryWriteInput): Promise<ToolOutcome<{ path: string }>> => {
    if (input.scope === 'project' && !input.project) return { ok: false, reason: 'project is required for project scope' };
    if (!input.summary.trim()) return { ok: false, reason: 'summary is required and must be non-empty' };
    if (lines(input.truth).some((line) => /^\s*-{3,}\s*$/.test(line))) return { ok: false, reason: 'truth may not contain a --- line (it separates truth from the timeline); use *** for a divider' };
    let path: string; try { path = pagePath(input); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    const args = { path, scope: input.scope === 'team' ? { kind: 'team' } : { kind: 'project', name: repoName(input.project!) }, type: input.type, title: input.title, summary: input.summary, truth: input.truth, ...(input.tags ? { tags: input.tags } : {}), ...(input.refs ? { refs: input.refs } : {}) };
    const full = join(root, path); const timeline = exists(full) ? preservedTimeline(readFileSync(full, 'utf8')) : ''; mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, render(input, timeline)); enqueue(options.store, 'write', path, args, now().toISOString()); return { ok: true, path };
  };
  const log = async (input: MemoryLogInput): Promise<ToolOutcome<{ path: string }>> => {
    const full = safeMemoryPath(root, input.path); if (!full) return { ok: false, reason: `invalid or missing memory path: ${input.path}` }; const pageLines = lines(readFileSync(full, 'utf8')); const separator = timelineLine(pageLines); if (separator < 0) return { ok: false, reason: 'memory page has no timeline separator' };
    const date = today(now); const entryLines = input.entry.split(/\r\n?|\n/); pageLines.splice(separator + 1, 0, `- ${date}: ${entryLines[0]}`, ...entryLines.slice(1).map((line) => `  ${line}`)); writeFileSync(full, pageLines.join('\n')); enqueue(options.store, 'log', input.path, { path: input.path, entry: input.entry, date }, now().toISOString()); return { ok: true, path: input.path };
  };
  const list = async (input: MemoryListInput): Promise<ToolOutcome<{ memories: Array<{ path: string; title: string; summary: string }> }>> => {
    const memories: Array<{ path: string; title: string; summary: string }> = []; const walk = (dir: string): void => { for (const item of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, item.name); if (item.isDirectory()) walk(full); else if (item.name.endsWith('.md')) { const path = relative(root, full).split(sep).join('/'); if (input.project && !path.startsWith(`projects/${repoName(input.project)}/`)) continue; if (input.type && path.split('/').at(-2)?.toLowerCase() !== input.type.toLowerCase()) continue; const text = readFileSync(full, 'utf8'); memories.push({ path, title: frontmatterValue(text, 'title'), summary: frontmatterValue(text, 'summary') }); } } };
    if (exists(root)) walk(root); return { ok: true, memories: memories.sort((a, b) => a.path.localeCompare(b.path)) };
  };
  return { write, log, list };
}
