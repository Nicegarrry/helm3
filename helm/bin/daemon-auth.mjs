import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read on every request: a restart rotates the token. Never expose parse errors.
export function daemonConnection(home = process.env.HELM_HOME || join(homedir(), '.helm')) {
  try {
    const { token, port } = JSON.parse(readFileSync(join(home, 'serve.json'), 'utf8'));
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) return { authorization: `Bearer ${token}`, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined };
  } catch { /* Missing or malformed credentials fail closed. */ }
  throw new Error('daemon authentication unavailable');
}

export function daemonAuthorization(home) { return daemonConnection(home).authorization; }
