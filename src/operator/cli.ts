import { formatOperatorCli, formatOperatorJson, validateOperatorSnapshot } from './projection.js';

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

export async function operatorCli(args: readonly string[]): Promise<string> {
  if (args.length < 2 || args.length > 3 || args[0] !== '--url' || (args.length === 3 && args[2] !== '--json')) {
    throw new Error('Usage: tsx src/operator/cli.ts --url http://127.0.0.1:PORT [--json]');
  }
  const snapshot = await readOperatorApi(args[1]);
  return args[2] === '--json' ? formatOperatorJson(snapshot) : formatOperatorCli(snapshot);
}

if (require.main === module) {
  void operatorCli(process.argv.slice(2)).then((output) => process.stdout.write(output)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Operator read failed'}\n`); process.exitCode = 1;
  });
}
