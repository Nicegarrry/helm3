import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read on every request: a restart rotates the token. Never expose parse errors.
export function daemonAuthorization(home = process.env.HELM_HOME || join(homedir(), '.helm')) {
  try {
    const { token } = JSON.parse(readFileSync(join(home, 'serve.json'), 'utf8'));
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) return `Bearer ${token}`;
  } catch { /* Missing or malformed credentials fail closed. */ }
  throw new Error('daemon authentication unavailable');
}
