import { formatOperatorCli, formatOperatorJson, validateOperatorSnapshot } from './projection.js';
import type { HelmToolResult } from '../runtime/orchestrator/index.js';
import { z } from 'zod/v3';

const toolResultSchema = z.union([
  z.object({ state: z.literal('succeeded'), value: z.unknown() }).strict().refine((value) => Object.hasOwn(value, 'value'), 'missing result value'),
  z.object({ state: z.enum(['refused', 'unsupported', 'unknown']), reason: z.string().min(1) }).strict(),
]);

/** CLI reads the same loopback API as the cockpit; it has no host authority. */
export async function readOperatorApi(origin: string) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Expected an explicit http://127.0.0.1:PORT origin');
  }
  const response = await fetch(new URL('/api/operator/snapshot', url), { signal: AbortSignal.timeout(5_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Operator API unavailable (${response.status})`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Operator snapshot exceeds the CLI read bound');
      chunks.push(value);
    }
    return validateOperatorSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function readOperatorToolApi(origin: string, name: 'brief.get' | 'map.get' | 'log.query' | 'models.get' | 'budget.get' | 'worker.inspect', limit?: number): Promise<HelmToolResult> {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected an explicit http://127.0.0.1:PORT origin');
  if (name !== 'log.query' && limit !== undefined) throw new Error('Only log.query accepts --limit');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) throw new Error('--limit must be between 1 and 100');
  const path = `/api/operator/read/${name}${limit === undefined ? '' : `?limit=${limit}`}`;
  const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(5_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Operator read API unavailable (${response.status})`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Operator read result exceeds the CLI read bound');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Operator read API returned invalid JSON'); }
  const validated = toolResultSchema.safeParse(parsed);
  if (!validated.success) throw new Error('Operator read API returned an invalid result');
  return validated.data as HelmToolResult;
}

export async function operatorCli(args: readonly string[]): Promise<string> {
  if (args.length >= 4 && args.length <= 6 && args[0] === '--url' && args[2] === '--read') {
    const name = args[3];
    if (!['brief.get', 'map.get', 'log.query', 'models.get', 'budget.get'].includes(name)) throw new Error('Unknown read tool');
    let limit: number | undefined;
    if (args.length > 4) {
      if (args.length !== 6 || args[4] !== '--limit' || !/^[1-9][0-9]{0,2}$/.test(args[5]!)) throw new Error('Usage: tsx src/operator/cli.ts --url http://127.0.0.1:PORT --read TOOL [--limit 1..100]');
      limit = Number(args[5]);
    }
    return `${JSON.stringify(await readOperatorToolApi(args[1], name as 'brief.get' | 'map.get' | 'log.query' | 'models.get' | 'budget.get', limit))}\n`;
  }
  if (args.length < 2 || args.length > 3 || args[0] !== '--url' || (args.length === 3 && args[2] !== '--json')) {
    throw new Error('Usage: tsx src/operator/cli.ts --url http://127.0.0.1:PORT [--json] | --url http://127.0.0.1:PORT --read TOOL [--limit 1..100]');
  }
  const snapshot = await readOperatorApi(args[1]);
  return args[2] === '--json' ? formatOperatorJson(snapshot) : formatOperatorCli(snapshot);
}

if (require.main === module) {
  void operatorCli(process.argv.slice(2)).then((output) => process.stdout.write(output)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Operator read failed'}\n`); process.exitCode = 1;
  });
}
