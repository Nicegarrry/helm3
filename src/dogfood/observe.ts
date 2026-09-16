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

type ObservationCliOptions = Readonly<{ orchestrator: 'fable' | 'astra'; stateDirectory: string; scenario: 'default' | 'native-fork'; serve: boolean }>;
const usage = 'usage: observe --orchestrator fable|astra --state-directory PATH [--scenario default|native-fork] [--serve]';

/** Parses all flags before fixture creation so invalid input cannot create state. */
export function parseObservationCli(args: readonly string[]): ObservationCliOptions {
  let orchestrator: 'fable' | 'astra' | undefined; let stateDirectory: string | undefined; let scenario: 'default' | 'native-fork' = 'default'; let scenarioProvided = false; let serve = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--serve') { if (serve) throw new Error('duplicate --serve'); serve = true; continue; }
    if (flag !== '--orchestrator' && flag !== '--state-directory' && flag !== '--scenario') throw new Error(`unknown argument: ${flag}`);
    const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--orchestrator') { if (orchestrator) throw new Error('duplicate --orchestrator'); if (value !== 'fable' && value !== 'astra') throw new Error('orchestrator must be fable or astra'); orchestrator = value; }
    else if (flag === '--state-directory') { if (stateDirectory) throw new Error('duplicate --state-directory'); stateDirectory = value; }
    else { if (scenarioProvided) throw new Error('duplicate --scenario'); if (value !== 'default' && value !== 'native-fork') throw new Error('scenario must be default or native-fork'); scenario = value; scenarioProvided = true; }
  }
  if (!orchestrator || !stateDirectory) throw new Error(usage);
  return Object.freeze({ orchestrator, stateDirectory, scenario, serve });
}

async function main(): Promise<void> {
  let options: ObservationCliOptions;
  try { options = parseObservationCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : usage}\n${usage}\n`); process.exitCode = 2; return; }
  const result = await runLocalFixture({ orchestrator: options.orchestrator, stateDirectory: resolve(options.stateDirectory), scenario: options.scenario });
  const output = { ...publicResult(result), scenario: options.scenario };
  if (!options.serve) { try { process.stdout.write(`${JSON.stringify(output)}\n`); } finally { await result.close(); } return; }
  const operator = await startLocalFixtureOperatorServer(result);
  try {
    process.stdout.write(`${JSON.stringify({ ...output, operator: { url: operator.url, apiUrl: operator.apiUrl } })}\n`);
    await new Promise<void>((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } finally { await operator.close(); await result.close(); }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) void main();
