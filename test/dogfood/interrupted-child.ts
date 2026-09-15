import { runLocalFixture } from '../../src/dogfood/index.js';
async function main(): Promise<void> {
  const [stateDirectory, orchestrator] = process.argv.slice(2);
  if (!stateDirectory || (orchestrator !== 'fable' && orchestrator !== 'astra')) throw new Error('fixture child needs state and orchestrator');
  await runLocalFixture({ stateDirectory, orchestrator });
}
void main();
