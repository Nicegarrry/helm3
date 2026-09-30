import { readdirSync } from 'node:fs';
import type { JevAnswer, Jev } from '../jev.js';
import type { WorkerRole, LoadClass } from '../types.js';

export type { LoadClass } from '../types.js';

export const LOAD_CLASS_QUESTION = {
  type: 'choice' as const,
  instructions: 'What local machine load will this job put on the host (the model itself runs remotely)?',
  options: ['light', 'medium', 'heavy'],
  criteria: {
    light: 'docs, config, small edits; no builds or only quick type checks',
    medium: 'node/TypeScript builds and unit test suites',
    heavy: 'Xcode/iOS builds, simulators, large or parallel test suites, Docker',
  },
};

const rank: Record<LoadClass, number> = { light: 1, medium: 2, heavy: 3 };

export function loadClassFromAnswer(answer: JevAnswer | undefined): LoadClass | undefined {
  const choice = answer?.choice;
  return choice === 'light' || choice === 'medium' || choice === 'heavy' ? choice : undefined;
}

export function isIosRepository(repo: string): boolean {
  try {
    return readdirSync(repo, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && (entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace'))
      || entry.isFile() && entry.name === 'Package.swift',
    );
  } catch {
    return false;
  }
}

export function classifyLoad(input: Readonly<{
  repo?: string;
  role?: WorkerRole | 'gate';
  explicit?: LoadClass;
  jevAnswer?: JevAnswer;
}>): LoadClass {
  if (input.explicit) return input.explicit;
  const ios = input.repo ? isIosRepository(input.repo) : false;
  const repoClass: LoadClass | undefined = ios ? 'heavy' : undefined;
  const roleClass: LoadClass | undefined = input.role === 'gate' || input.role === 'reviewer' ? 'medium' : undefined;
  const answerClass = loadClassFromAnswer(input.jevAnswer);
  const base = roleClass ?? answerClass ?? 'medium';
  if (repoClass && rank[repoClass] > rank[base]) return repoClass;
  return base;
}

export async function askLoadClass(options: Readonly<{
  jev?: Jev;
  repo?: string;
  role?: WorkerRole | 'gate';
  explicit?: LoadClass;
  alreadyAsked?: boolean;
  state?: unknown;
}>): Promise<LoadClass> {
  if (options.explicit) return classifyLoad(options);
  if (options.alreadyAsked) return classifyLoad(options);
  if (!options.jev || options.role === 'gate' || options.role === 'reviewer') return classifyLoad(options);
  try {
    const result = await options.jev.ask('capacity', {
      state: options.state ?? {},
      ...(options.repo ? { project: options.repo } : {}),
      questions: { load: LOAD_CLASS_QUESTION },
    });
    return classifyLoad({ ...options, jevAnswer: result.ok ? result.answers.load : undefined });
  } catch {
    return classifyLoad(options);
  }
}
