import { resolve } from 'node:path';
import { runLocalFixture } from './index.js';
async function main(): Promise<void> {
  const args = process.argv.slice(2); const orchestrator = args[0] === '--orchestrator' ? args[1] : undefined; const state = args[2] === '--state-directory' ? args[3] : undefined;
  if ((orchestrator !== 'fable' && orchestrator !== 'astra') || !state || args.length !== 4) { process.stderr.write('usage: observe --orchestrator fable|astra --state-directory PATH\n'); process.exitCode = 2; return; }
  const result = await runLocalFixture({ orchestrator, stateDirectory: resolve(state) }); try { process.stdout.write(`${JSON.stringify({ ...result, host: undefined, close: undefined })}\n`); } finally { await result.close(); }
}
void main();
