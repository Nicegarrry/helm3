export function launchUpgrade(home: string, port: number, source: { bootId: string }, timeoutMs: number): void;
export function digestRelease(root: string): string;
export function stageRelease(home: string, repo: string, ref: string, validate?: (root: string, env: NodeJS.ProcessEnv) => void): { root: string; version: string; revision: string; digest: string };
export function control(port: number, input: Record<string, unknown>): Promise<Record<string, any>>;
export function applyUpgrade(home: string, id: string): Promise<void>;
