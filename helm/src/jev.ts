import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from './settings.js';
import type { Settings } from './settings.js';
import type { Store } from './types.js';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 10;

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Readonly<Record<string, string>> }
  | { type: 'score'; instructions: string; criteria: ReadonlyArray<string> };

export type JevAnswer = Readonly<{
  noul?: boolean;
  choice?: string;
  probabilities?: Record<string, number>;
  score?: string | number;
  confidence?: number;
}>;

export type JevAnswers = Record<string, JevAnswer>;

export type JevAskInput = Readonly<{
  workerId?: string;
  project?: string;
  state: unknown;
  questions: Readonly<Record<string, JevQuestion>>;
}>;

export type JevResult =
  | Readonly<{ ok: true; answers: JevAnswers }>
  | Readonly<{ ok: false; reason: string }>;

export type Jev = Readonly<{
  shadow: boolean;
  ask(purpose: string, input: JevAskInput): Promise<JevResult>;
}>;

type FetchLike = typeof globalThis.fetch;
type Env = Record<string, string | undefined>;

function json(value: unknown, key: string): string {
  return JSON.stringify(redact(value, key)) ?? 'null';
}

function redact(value: unknown, key: string): unknown {
  if (!key) return value;
  if (typeof value === 'string') return value.replaceAll(key, '[redacted]');
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, key)]));
  }
  return value;
}

function redactString(value: string | null, key: string): string | null {
  return key ? value?.replaceAll(key, '[redacted]') ?? null : value;
}

function errorText(error: unknown, key: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message, key) as string;
}

function inputTokens(payload: Record<string, unknown>): number | null {
  const usage = payload.usage;
  if (usage && typeof usage === 'object') {
    const row = usage as Record<string, unknown>;
    const value = row.inputTokens ?? row.input_tokens ?? row.prompt_tokens;
    if (typeof value === 'number') return value;
  }
  const value = payload.inputTokens ?? payload.input_tokens;
  return typeof value === 'number' ? value : null;
}

function answersFrom(payload: Record<string, unknown>): JevAnswers {
  const candidate = payload.answers;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('invalid response');
  return candidate as JevAnswers;
}

function primaryConfidence(answers: JevAnswers): number | null {
  for (const answer of Object.values(answers)) {
    if (typeof answer.confidence === 'number') return answer.confidence;
  }
  return null;
}

function successful(response: Response): boolean {
  return response.ok || (response.status >= 200 && response.status < 300);
}

function keyFrom(env: Env): string | undefined {
  const direct = env.TYPESAFE_API_KEY?.trim();
  if (direct) return direct;
  const fileEnv = loadEnvFile(join(env.HOME || homedir(), '.config', 'typesafe', 'env'));
  const fromFile = fileEnv.TYPESAFE_API_KEY?.trim();
  return fromFile || undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithTimeout(
  fetchFn: FetchLike,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; payload?: Record<string, unknown> }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = fetchFn(JEV_URL, { ...init, signal: controller.signal }).then(async (response) => ({
      response,
      payload: successful(response) ? await response.json() as Record<string, unknown> : undefined,
    }));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('request timeout'));
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function retryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function createJev({
  settings,
  store,
  env,
  fetch: fetchFn = globalThis.fetch,
}: {
  settings: Settings;
  store: Store;
  env: Env;
  fetch?: FetchLike;
}): Jev {
  store.sql.exec(`
    CREATE TABLE IF NOT EXISTS jev_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      purpose TEXT NOT NULL,
      workerId TEXT,
      project TEXT,
      model TEXT NOT NULL,
      questions TEXT NOT NULL,
      answers TEXT NOT NULL,
      confidence REAL,
      latencyMs INTEGER NOT NULL,
      inputTokens INTEGER,
      shadow INT NOT NULL,
      error TEXT,
      label TEXT NULL
    )
  `);

  const shadow = settings.jev.shadow;

  async function ask(purpose: string, input: JevAskInput): Promise<JevResult> {
    const startedAt = Date.now();
    const at = new Date().toISOString();
    const key = keyFrom(env);
    let answers: JevAnswers = {};
    let tokens: number | null = null;
    let confidence: number | null = null;
    let error: string | null = null;

    if (!key) {
      error = 'no key';
    } else {
      try {
        let response: Response | undefined;
        let payload: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
          const result = await requestWithTimeout(fetchFn, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: settings.jev.model, state: input.state, questions: input.questions }),
          }, settings.jev.timeoutMs);
          response = result.response;
          payload = result.payload;
          if (successful(response) || !retryable(response.status) || attempt === MAX_RETRIES) break;
          await wait(RETRY_DELAY_MS * (attempt + 1));
        }
        if (!response || !successful(response)) {
          error = `http ${response?.status ?? 'unknown'}`;
        } else {
          answers = answersFrom(payload ?? {});
          tokens = inputTokens(payload ?? {});
          confidence = typeof payload?.confidence === 'number' ? payload.confidence : primaryConfidence(answers);
        }
      } catch (cause) {
        error = errorText(cause, key);
      }
    }

    store.sql.prepare(`
      INSERT INTO jev_calls
        (at, purpose, workerId, project, model, questions, answers, confidence, latencyMs, inputTokens, shadow, error, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      at,
      redact(purpose, key ?? '') as string,
      redactString(input.workerId ?? null, key ?? ''),
      redactString(input.project ?? null, key ?? ''),
      redactString(settings.jev.model, key ?? ''),
      json(input.questions, key ?? ''),
      json(answers, key ?? ''),
      confidence,
      Date.now() - startedAt,
      tokens,
      shadow ? 1 : 0,
      error,
      null,
    );

    return error ? { ok: false, reason: error } : { ok: true, answers: redact(answers, key ?? '') as JevAnswers };
  }

  return { shadow, ask };
}
