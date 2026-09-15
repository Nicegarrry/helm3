import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { createHostSnapshotSource } from '../operator/host-source.js';
import { createOperatorServer, listenOperatorServer } from '../operator/server.js';
import { createLocalFixtureReadToolRegistry, runLocalFixture, type LocalFixtureResult } from './index.js';

export type LocalFixtureOperatorServer = Readonly<{
  url: string;
  apiUrl: string;
  close(): Promise<void>;
}>;

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

/** Serves the same read-only fixture projection as the operator CLI on loopback. */
export async function startLocalFixtureOperatorServer(result: LocalFixtureResult): Promise<LocalFixtureOperatorServer> {
  const source = createHostSnapshotSource({ host: result.host, runId: result.runId, evidenceMode: 'fixture', now: () => result.observedAt });
  const context = { runId: result.runId, sessionId: result.sessionId, mode: 'primary' as const };
  const server = createOperatorServer(source, { registry: createLocalFixtureReadToolRegistry(result), context });
  const { host, port } = await listenOperatorServer(server);
  const url = `http://${host}:${port}`;
  return Object.freeze({ url, apiUrl: `${url}/api/operator/snapshot`, close: () => closeServer(server) });
}

function publicResult(result: LocalFixtureResult): Omit<LocalFixtureResult, 'host' | 'close'> {
  const { host: _host, close: _close, ...value } = result;
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const orchestrator = args[0] === '--orchestrator' ? args[1] : undefined; const state = args[2] === '--state-directory' ? args[3] : undefined; const serve = args[4] === '--serve';
  if ((orchestrator !== 'fable' && orchestrator !== 'astra') || !state || (args.length !== 4 && !(args.length === 5 && serve))) { process.stderr.write('usage: observe --orchestrator fable|astra --state-directory PATH [--serve]\n'); process.exitCode = 2; return; }
  const result = await runLocalFixture({ orchestrator, stateDirectory: resolve(state) });
  if (!serve) { try { process.stdout.write(`${JSON.stringify(publicResult(result))}\n`); } finally { await result.close(); } return; }
  const operator = await startLocalFixtureOperatorServer(result);
  try {
    process.stdout.write(`${JSON.stringify({ ...publicResult(result), operator: { url: operator.url, apiUrl: operator.apiUrl } })}\n`);
    await new Promise<void>((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } finally { await operator.close(); await result.close(); }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) void main();
