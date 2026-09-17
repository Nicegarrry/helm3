import { nativeCli } from '../src/cli/native.js';
import { createLiveNativeFixture, workerEnvelope } from '../test/host/native-command-fixture.js';

/**
 * Create one disposable, provider-free native command and leave its durable
 * state on disk so the public CLI can be replayed by hand.  This example
 * deliberately uses the fixture environment seam because a fresh CLI process
 * cannot import an in-memory faux provider; the command itself still runs
 * through the shipped nativeCli and the actual Pi runtime.
 */
const main = async (): Promise<void> => {
  if (process.argv.length !== 2) throw new Error('native fixture accepts no configuration overrides');
  const fixture = await createLiveNativeFixture('task-fixture');
  try {
    await fixture.writeConfig();
    fixture.faux.setResponses([fixture.ai.fauxAssistantMessage(workerEnvelope())]);
    const result = JSON.parse(await nativeCli(['--config', fixture.configPath, '--json'], fixture.environment)) as Record<string, unknown>;
    await fixture.close(false);
    if (result.state !== 'succeeded') process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({
      fixture: true,
      state: result.state,
      commandId: result.commandId,
      paths: {
        root: fixture.root,
        config: fixture.configPath,
        repository: fixture.repo,
        stateDirectory: fixture.stateDirectory,
        destination: fixture.config.destination,
      },
      result: result.result,
    })}\n`);
  } catch (error) {
    await fixture.close(false).catch(() => undefined);
    process.stderr.write(`fixture evidence retained at ${fixture.root}\n`);
    throw error;
  }
};

void main().catch(() => {
  process.stderr.write('native fixture refused\n');
  process.exitCode = 1;
});
