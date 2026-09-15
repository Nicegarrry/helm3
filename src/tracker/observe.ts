import { GitHubMapTracker } from './index.js';

function usage(): never { throw new Error('usage: observe --repo OWNER/REPO --map ISSUE_NUMBER'); }
function parse(argv: readonly string[]): { repo: string; parentIssue: number } {
  if (argv.length !== 4 || argv[0] !== '--repo' || argv[2] !== '--map') usage();
  const parentIssue = Number(argv[3]);
  if (!Number.isSafeInteger(parentIssue) || parentIssue < 1) usage();
  return { repo: argv[1]!, parentIssue };
}

async function main(): Promise<void> {
  try {
    const options = parse(process.argv.slice(2));
    const snapshot = await new GitHubMapTracker(options).snapshot();
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    process.exitCode = snapshot.completeness === 'complete' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'invalid observer input'}\n`);
    process.exitCode = 2;
  }
}

void main();
