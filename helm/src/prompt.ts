/** Builder and reviewer prompt text, plus the WorkerResult instruction appended to every turn. */

/** What a builder/reviewer prompt is built from (mirrors helm.ts's local `PromptInput`). */
export type PromptInput = Readonly<{
  objective: string;
  acceptance: string | null;
  contextPaths: readonly string[];
}>;

/** Appended to every turn so the model ends with a machine-parseable result. */
export const RESULT_INSTRUCTION = [
  'When you are done with this turn, end your final message with EXACTLY one JSON object',
  '(strict JSON, or a single ```json fenced block) matching this shape and nothing else after it:',
  '',
  '{',
  '  "status": "succeeded" | "failed" | "partial",',
  '  "summary": "one paragraph describing what you did or found",',
  '  "changedFiles": ["path/to/file.ts"],',
  '  "commandsRun": ["npm test"],',
  '  "notes": "optional extra detail"',
  '}',
  '',
  'changedFiles and commandsRun must be arrays of strings (use [] when empty). notes is optional.',
  'Do not add any other top-level fields. Example:',
  '```json',
  '{"status":"succeeded","summary":"Added the retry helper and its test.","changedFiles":["src/retry.ts"],"commandsRun":["npm test"],"notes":""}',
  '```',
].join('\n');

function contextSection(contextPaths: readonly string[]): string {
  if (contextPaths.length === 0) return '';
  return `\n\nRelevant files to look at first:\n${contextPaths.map((p) => `- ${p}`).join('\n')}`;
}

/** Prompt for a builder worker: make the change, then report a WorkerResult. */
export function builderPrompt(input: PromptInput): string {
  const acceptance = input.acceptance ? `\n\nAcceptance criteria:\n${input.acceptance}` : '';
  return [
    `You are a coding agent working in a git worktree. Objective:\n${input.objective}${acceptance}${contextSection(input.contextPaths)}`,
    '',
    'Use the read, grep, find and ls tools to understand the code before editing. Use edit or write to',
    'make changes, and bash to run tests or checks. Work only inside this worktree; do not push, open a',
    'PR, or touch .git internals yourself. When the objective is met (or you are stuck), stop and report.',
  ].join('\n');
}

/** Prompt for a reviewer worker: read-only, reports findings and a verdict. */
export function reviewerPrompt(input: PromptInput): string {
  const acceptance = input.acceptance ? `\n\nAcceptance criteria to check against:\n${input.acceptance}` : '';
  return [
    `You are a reviewing coding agent working in a read-only checkout. Review objective:\n${input.objective}${acceptance}${contextSection(input.contextPaths)}`,
    '',
    'You may only read, grep, find, ls and run read-only bash commands (e.g. tests, linters). You must',
    'not edit or write any file, and must not run bash commands that modify files or git state.',
    '',
    "Report your findings in the WorkerResult's summary, and end the summary with a verdict line that",
    'starts with exactly "APPROVE: " or "REQUEST_CHANGES: " followed by a one-line reason.',
  ].join('\n');
}

/** Convenience dispatcher matching DESIGN.md's `buildPrompt` shorthand. */
export function buildPrompt(role: 'builder' | 'reviewer', input: PromptInput): string {
  return role === 'reviewer' ? reviewerPrompt(input) : builderPrompt(input);
}
