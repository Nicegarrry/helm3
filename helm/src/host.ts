import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const realExec = promisify(execFile);

export type ExecResult = Readonly<{ stdout: string; stderr?: string }>;
export type HostExec = (command: string, args: readonly string[], options?: { cwd?: string }) => Promise<ExecResult>;
export type Pane = Readonly<{ id: string; workspaceId?: string; session?: string; label?: string; host: 'herdr' | 'tmux' }>;
export type HostStatus = 'idle' | 'busy' | 'unknown';

export type Host = Readonly<{
  resolve(label: string): Promise<Pane | null>;
  status(pane: Pane): Promise<HostStatus>;
  promptEmpty(pane: Pane): Promise<boolean>;
  send(pane: Pane, line: string): Promise<void>;
  create(label: string, cwd: string, command: string): Promise<Pane | null>;
}>;

const defaultExec: HostExec = async (command, args, options) => {
  const result = await realExec(command, [...args], { cwd: options?.cwd, maxBuffer: 16 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
};

function json(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function array(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === 'string') return value[key] as string;
  return undefined;
}

function paneId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return stringField(value as Record<string, unknown>, 'pane_id', 'paneId', 'id');
}

function workspaceId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return stringField(value as Record<string, unknown>, 'workspace_id', 'workspaceId', 'id');
}

function workspacePanes(value: unknown): unknown[] {
  return array(value, ['panes', 'items', 'results']);
}

function statusOf(value: unknown): HostStatus {
  if (!value || typeof value !== 'object') return 'unknown';
  const status = stringField(value as Record<string, unknown>, 'agent_status', 'agentStatus', 'status')?.toLowerCase();
  if (status === 'idle' || status === 'done') return 'idle';
  if (status === 'working' || status === 'blocked' || status === 'busy') return 'busy';
  return 'unknown';
}

function stripJsonText(stdout: string): string {
  const parsed = json(stdout);
  if (typeof parsed === 'string') return parsed;
  if (parsed && typeof parsed === 'object') {
    const text = stringField(parsed as Record<string, unknown>, 'text', 'content', 'output');
    if (text !== undefined) return text;
  }
  return stdout;
}

function promptEmptyText(text: string): boolean {
  let found = false;
  let faint = false;
  let normalText = '';
  const prompt = /❯((?:\x1b\[[0-9;]*m|[^\r\n])*)/g;
  for (const match of text.matchAll(prompt)) {
    found = true;
    faint = false;
    normalText = '';
    const suffix = match[1] ?? '';
    for (let i = 0; i < suffix.length;) {
      if (suffix[i] === '\x1b' && suffix[i + 1] === '[') {
        const end = suffix.indexOf('m', i + 2);
        if (end < 0) break;
        const code = suffix.slice(i + 2, end);
        if (code === '2' || code.split(';').includes('2')) faint = true;
        if (code === '0' || code === '22' || code.split(';').includes('0') || code.split(';').includes('22')) faint = false;
        i = end + 1;
        continue;
      }
      const char = suffix[i] ?? '';
      if (!faint && !/\s/.test(char)) normalText += char;
      i += 1;
    }
  }
  return found && normalText.length === 0;
}

export function promptEmptyTextForTest(text: string): boolean {
  return promptEmptyText(text);
}

export function herdrHost(exec: HostExec = defaultExec): Host {
  async function findWorkspace(label: string): Promise<{ id: string; raw: Record<string, unknown> } | null> {
    const result = json((await exec('herdr', ['workspace', 'list', '--json'])).stdout);
    for (const entry of array(result, ['workspaces', 'items', 'results'])) {
      if (!entry || typeof entry !== 'object') continue;
      const raw = entry as Record<string, unknown>;
      if (stringField(raw, 'label', 'name') !== label) continue;
      const id = workspaceId(raw);
      if (id) return { id, raw };
    }
    return null;
  }

  async function panes(workspace: string): Promise<unknown[]> {
    return workspacePanes(json((await exec('herdr', ['pane', 'list', '--workspace', workspace, '--json'])).stdout));
  }

  return {
    async resolve(label) {
      const workspace = await findWorkspace(label);
      if (!workspace) return null;
      const entries = await panes(workspace.id);
      const entry = entries.find((candidate) => paneId(candidate));
      const id = paneId(entry);
      return id ? { id, workspaceId: workspace.id, label, host: 'herdr' } : null;
    },
    async status(pane) {
      if (!pane.workspaceId) return 'unknown';
      try {
        const entry = (await panes(pane.workspaceId)).find((candidate) => paneId(candidate) === pane.id);
        return statusOf(entry);
      } catch {
        return 'unknown';
      }
    },
    async promptEmpty(pane) {
      const output = await exec('herdr', ['pane', 'read', pane.id, '--source', 'visible', '--lines', '8', '--ansi']);
      return promptEmptyText(stripJsonText(output.stdout));
    },
    async send(pane, line) {
      await exec('herdr', ['pane', 'run', pane.id, line]);
    },
    async create(label, cwd, command) {
      const result = json((await exec('herdr', ['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus', '--json'])).stdout);
      const raw = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const root = raw.root_pane ?? raw.rootPane ?? raw.pane;
      const id = paneId(root) ?? paneId(result);
      const workspace = workspaceId(raw) ?? stringField(raw, 'workspace_id', 'workspaceId');
      if (!id) return null;
      const pane: Pane = { id, workspaceId: workspace, label, host: 'herdr' };
      await this.send(pane, command);
      return pane;
    },
  };
}

function tmuxSession(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `helm-${slug || 'supervisor'}`;
}

export function tmuxHost(exec: HostExec = defaultExec, waitMs = 2000): Host {
  const capture = async (pane: Pane): Promise<string> => (await exec('tmux', ['capture-pane', '-p', '-t', pane.id])).stdout;
  return {
    async resolve(label) {
      const session = tmuxSession(label);
      try {
        const output = await exec('tmux', ['list-panes', '-t', session, '-F', '#{pane_id}']);
        const id = output.stdout.trim().split(/\s+/)[0];
        return id ? { id, session, label, host: 'tmux' } : null;
      } catch {
        return null;
      }
    },
    async status(pane) {
      try {
        const first = await capture(pane);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        const second = await capture(pane);
        return first === second ? 'idle' : 'busy';
      } catch {
        return 'unknown';
      }
    },
    async promptEmpty(pane) {
      return promptEmptyText(await capture(pane));
    },
    async send(pane, line) {
      await exec('tmux', ['send-keys', '-t', pane.id, '-l', line]);
      await exec('tmux', ['send-keys', '-t', pane.id, 'Enter']);
    },
    async create(label, cwd, command) {
      const session = tmuxSession(label);
      await exec('tmux', ['new-session', '-d', '-s', session, '-c', cwd, command]);
      return { id: session, session, label, host: 'tmux' };
    },
  };
}
