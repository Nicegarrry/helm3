import type { Command } from '../contracts/index.js';
import type { PiWorkerBinding } from '../host/index.js';
import type { ArtifactJournal } from '../journal/index.js';
import { PiNativeWorker, type PiAuthority, type PiWorkerInput } from '../runtime/pi/index.js';
import { BoundedPiAccess } from './index.js';

/**
 * Executable live binding for PiNativeRuntime. Credential resolution stays in
 * the caller-created ModelRuntime; this factory receives neither key values nor
 * environment names and always injects the required bounded access gate.
 */
export function createBoundedPiWorkerBinding(input: Readonly<{
  access: BoundedPiAccess;
  authority: () => PiAuthority;
  workerFor(command: Command, journal: ArtifactJournal, authority: PiAuthority): Omit<PiWorkerInput, 'authority' | 'journal' | 'access'>;
  prompt(command: Command): string;
  correction(command: Command): string;
}>): PiWorkerBinding {
  return {
    authority: input.authority,
    start: async ({ command, journal, authority }) => {
      const worker = input.workerFor(command, journal, authority);
      return PiNativeWorker.start({ ...worker, authority, journal, access: input.access });
    },
    prompt: input.prompt,
    correction: input.correction,
  };
}
