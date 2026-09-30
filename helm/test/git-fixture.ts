import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export function disableGitMaintenance(repo: string): void {
  execFileSync('git', ['-C', repo, 'config', 'gc.auto', '0']);
  execFileSync('git', ['-C', repo, 'config', 'maintenance.auto', 'false']);
}

export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
