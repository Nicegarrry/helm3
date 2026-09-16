// Pure helpers for the native WorkerResult terminal envelope.
//
// Imports ONLY from ../contracts (never runtime) to avoid circular imports.
// Used by the coordinator to parse raw terminal output, supply model-facing
// format instructions, and emit a bounded same-session correction.

import type { ZodIssue } from 'zod/v3';
import { workerResultSchema, type WorkerResult } from '../contracts/index.js';

/** Maximum accepted UTF-8 byte length before we refuse to process the text. */
const MAX_INPUT_BYTES = 128 * 1024;

/** Maximum number of schema-issue bullets included in a correction. */
const MAX_ISSUES = 8;

/**
 * Internal illustrative example, validated through the canonical schema so any
 * schema drift fails loudly at module load. Not exported: only the three
 * requested functions are public.
 */
const WORKER_RESULT_EXAMPLE: WorkerResult = workerResultSchema.parse({
  status: 'succeeded',
  summary: 'Added the bounded retry path and its tests.',
  changed_files: ['src/core/retry.ts', 'test/core/retry.test.ts'],
  commits: ['a1b2c3d'],
  decisions: ['Chose exponential backoff over fixed delay.'],
  discoveries: ['Upstream call occasionally returns 429.'],
  tests_claimed: ['node --test test/core/retry.test.ts'],
  acceptance_claims: [
    {
      criterionId: 'AC-1',
      claim: 'Retry only occurs on transient failures.',
      evidenceRefs: ['test:retry-429', 'artifact:log-1'],
    },
  ],
  risks: ['Backoff could exceed the request budget.'],
  unresolved: ['Confirm the 429 rate ceiling with the platform owner.'],
  artifacts: [
    { ref: 'artifact:log-1', hash: 'sha256:2c26b46b68ffc68', mediaType: 'text/plain' },
  ],
  recommended_next_action: 'Review the retry timing against the request budget.',
});

const EXAMPLE_BEGIN = '<<WORKER_RESULT_EXAMPLE_BEGIN>>';
const EXAMPLE_END = '<<WORKER_RESULT_EXAMPLE_END>>';

/** Whole-text candidate JSON: a single lowercase fence, otherwise the raw text. */
function toCandidate(text: string): string {
  const fenced = text.match(/^```json\r?\n([\s\S]*)\r?\n```$/);
  return fenced ? fenced[1] : text;
}

/**
 * Parse raw terminal output into a validated {@link WorkerResult}, or
 * `undefined`. Accepted forms are strict JSON or one complete lowercase
 * ```json fence — never prose-prefixed or concatenated objects. The canonical
 * schema is authoritative; malformed claims are never coerced to success.
 */
export function parseWorkerResult(text: string): WorkerResult | undefined {
  let data: unknown;
  try {
    data = JSON.parse(toCandidate(text));
  } catch {
    return undefined;
  }
  const result = workerResultSchema.safeParse(data);
  return result.success ? result.data : undefined;
}

/**
 * Concise, model-facing result contract plus a complete illustrative object.
 * This is a result contract, not a development workflow.
 */
export function workerResultInstructions(): string {
  const exampleJson = JSON.stringify(WORKER_RESULT_EXAMPLE, null, 2);
  return [
    'When you finish, respond with EXACTLY one JSON object matching the result',
    'contract below and nothing else. No surrounding prose and no ```json fence is',
    'required; the single object is the entire message.',
    '',
    'Field rules:',
    '- status: one of "succeeded", "partial", "failed", "cancelled".',
    '- summary and recommended_next_action: nonempty strings.',
    '- changed_files, commits, decisions, discoveries, tests_claimed, risks,',
    '  unresolved: arrays of nonempty STRINGS.',
    '- acceptance_claims: array of OBJECTS, each { criterionId:string, claim:string,',
    '  evidenceRefs:array<string> }.',
    '- artifacts: array of OBJECTS, each { ref:string, hash:string, mediaType:string }.',
    '- Any list you have no entries for MUST be an empty array ([]). Never place an',
    '  object where a string is expected (e.g. risks are strings), and never add',
    '  extra top-level keys.',
    '',
    'This is a result contract only; it does not prescribe a workflow. Every value',
    'in the example is a PLACEHOLDER. acceptance_claims must reference real evidence',
    'you actually gathered (real evidenceRefs / artifacts); never fabricate evidence',
    'and never report a failed attempt as succeeded.',
    '',
    'Complete illustrative example (placeholder values):',
    EXAMPLE_BEGIN,
    exampleJson,
    EXAMPLE_END,
  ].join('\n');
}

/** A safe feedback line for one Zod issue: never the value, key, or raw message. */
function issueLine(issue: ZodIssue): string {
  const where = issue.path.length > 0 ? issue.path.join('.') : 'result';
  // Unrecognized keys carry the worker's own (possibly sensitive) names, so emit
  // only the location and the code.
  if (issue.code === 'unrecognized_keys') {
    return `- ${where}: ${issue.code} (use only the contract fields)`;
  }
  // For invalid_type the canonical Zod issue carries a safe `expected` type.
  if (issue.code === 'invalid_type') {
    return `- ${where}: ${issue.code} (expected ${issue.expected})`;
  }
  return `- ${where}: ${issue.code}`;
}

/**
 * Bounded correction for malformed or invalid terminal text. Never echoes the
 * raw text, offending values, Zod's raw messages, or unknown property names.
 * Valid input is reported as already correct and must not be rewritten.
 */
export function workerResultCorrection(text: string): string {
  if (new TextEncoder().encode(text).length > MAX_INPUT_BYTES) {
    return [
      `Your terminal result was rejected: it exceeds the maximum size (${MAX_INPUT_BYTES}`,
      'bytes UTF-8). Re-send a single compact JSON object within that limit.',
      '',
      workerResultInstructions(),
    ].join('\n');
  }

  if (parseWorkerResult(text) !== undefined) {
    return 'Your terminal result already validates against the result contract. Do not rewrite it; re-send it unchanged.';
  }

  let data: unknown;
  let malformed = false;
  try {
    data = JSON.parse(toCandidate(text));
  } catch {
    malformed = true;
  }

  if (malformed) {
    return [
      'Your terminal result was rejected: invalid JSON. Output exactly one complete,',
      'parseable JSON object (no prose, no fences required, no concatenated objects).',
      '',
      workerResultInstructions(),
    ].join('\n');
  }

  const parsed = workerResultSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const lines = issues.slice(0, MAX_ISSUES).map(issueLine);
    const extra = issues.length - lines.length;
    const bullets = [
      'Your terminal result did not match the result contract. Fix ONLY these',
      'problems (example values are placeholders; empty lists are []). Then output',
      'exactly one corrected JSON object.',
      '',
      `Schema issues (up to ${MAX_ISSUES}):`,
      ...lines,
    ];
    if (extra > 0) {
      bullets.push(`(${extra} more issue(s) of the same kind.)`);
    }
    return [...bullets, '', workerResultInstructions()].join('\n');
  }

  return 'Your terminal result already validates against the result contract. Do not rewrite it; re-send it unchanged.';
}
