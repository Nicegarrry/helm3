import { createOperatorServer, listenOperatorServer } from './server.js';
import { readSavedOperatorSnapshot } from './saved-snapshot.js';

function usage(): never { throw new Error('Usage: tsx src/operator/saved-viewer.ts --snapshot PATH'); }

export async function savedViewerCli(args: readonly string[], output: Pick<NodeJS.WriteStream, 'write'> = process.stdout): Promise<void> {
  if (args.length !== 2 || args[0] !== '--snapshot' || !args[1]) usage();
  const source = await readSavedOperatorSnapshot(args[1]!);
  const server = createOperatorServer(source);
  const { host, port } = await listenOperatorServer(server);
  const close = async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); };
  output.write(`Historical, untrusted projection; it cannot authorize actions.\nOperator cockpit: http://${host}:${port}\n`);
  await new Promise<void>((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  await close();
}

if (require.main === module) {
  void savedViewerCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'saved snapshot viewer failed'}\n`);
    process.exitCode = 1;
  });
}
