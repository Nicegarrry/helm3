/** Stable stdio shim: schemas and validation belong exclusively to the daemon. */
import { request } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { daemonConnection } from '../bin/daemon-auth.mjs';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export const SHIM_VERSION = 1;
export const MIN_SHIM_VERSION = 1;
export const SHIM_RESTART_NOTE = 'Restart this MCP session: its Helm shim is below the supported minimum.';
const WAIT_PROGRESS_MS = 30_000;

type ProgressWorker = Readonly<{
  workerId: string;
  state: string;
  lastEvent?: Readonly<{ kind?: unknown; data?: unknown }> | null;
}>;

type ProgressState = Readonly<{
  workers?: readonly ProgressWorker[];
  run?: Readonly<{ capacity?: Readonly<{ queue?: readonly Readonly<{ workerId?: unknown }>[] }> }>;
}>;

function activity(worker: ProgressWorker): string {
  const event = worker.lastEvent;
  if (!event) return 'waiting for worker activity';
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data) ?? '';
  return `${String(event.kind ?? 'activity')}: ${data}`.replace(/\s+/g, ' ').slice(0, 240);
}

function waitProgress(state: ProgressState, workerId: string, started: number, timeoutMs: number) {
  const worker = state.workers?.find((candidate) => candidate.workerId === workerId);
  const position = state.run?.capacity?.queue?.findIndex((candidate) => candidate.workerId === workerId);
  const etaMs = Math.max(0, started + timeoutMs - Date.now());
  return {
    state: worker?.state ?? 'unknown',
    position: position === undefined || position < 0 ? null : position + 1,
    etaMs,
    activity: worker ? activity(worker) : 'worker is no longer visible',
  };
}

function progressSignature(progress: ReturnType<typeof waitProgress>): string {
  return JSON.stringify({ state: progress.state, position: progress.position, activity: progress.activity });
}

/** Only failures proving no admission are replayed; interrupted responses are ambiguous. */
export async function proxyRequest(port: number, path: string, input: unknown, profile: string, home?: string, onHash?: (hash: string) => void, retryMs = 60_000): Promise<any> {
  const deadline = Date.now() + retryMs;
  let delay = 100;
  while (true) {
    const result = await new Promise<{ value: any; retry?: boolean }>((resolve) => {
      let connection;
      try { connection = daemonConnection(home); }
      catch { resolve({ value: { ok: false, reason: 'daemon authentication unavailable' }, retry: true }); return; }
      // Each attempt gets a fresh socket; an idle socket can belong to the stopped daemon.
      const req = request({ host: '127.0.0.1', port: connection.port ?? port, path, agent: false,
        method: input === undefined ? 'GET' : 'POST',
        headers: { authorization: connection.authorization, 'content-type': 'application/json', 'x-helm-mcp': '1', 'x-helm-tools': profile, 'x-helm-shim': String(SHIM_VERSION) } }, (res) => {
        const hash = res.headers['x-helm-tools-hash'];
        if (typeof hash === 'string') onHash?.(hash);
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('error', () => resolve({ value: { ok: false, reason: 'daemon response interrupted; mutation outcome may be unknown, inspect before retrying' } }));
        res.on('end', () => {
          let value;
          try { value = JSON.parse(body); }
          catch { value = { ok: false, reason: `daemon returned ${res.statusCode}: ${body.slice(0, 200)}` }; }
          resolve({ value, retry: res.statusCode === 401 || (value.ok === false && typeof value.reason === 'string' && value.reason.startsWith('daemon is draining;') && value.reason.includes('no work was admitted')) });
        });
      });
      // Bound connection establishment, without timing out long-running worker.wait responses.
      const connecting = setTimeout(() => req.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), Math.max(1, deadline - Date.now()));
      req.on('socket', (socket) => {
        if (socket.connecting) socket.once('connect', () => clearTimeout(connecting));
        else clearTimeout(connecting);
      });
      req.on('error', (err: NodeJS.ErrnoException) => { clearTimeout(connecting); resolve({ value: { ok: false, reason: `daemon unreachable: ${err.message}` }, retry: err.code === 'ECONNREFUSED' }); });
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
    if (!result.retry || Date.now() >= deadline) return result.value;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, deadline - Date.now())));
    delay = Math.min(delay * 2, 2000);
  }
}

export async function serveStdioProxy(port: number, profile = process.env.HELM_TOOLS ?? 'core', home?: string, transport: Transport = new StdioServerTransport(), pollMs = 60_000, progressPollMs = 1_000) {
  const server = new Server({ name: 'helm', version: String(SHIM_VERSION) }, { capabilities: { tools: { listChanged: true } } });
  let hash: string | undefined;
  let connected = false;
  const observe = (next: string) => {
    const changed = hash !== undefined && next !== hash;
    hash = next;
    if (changed && connected) void server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {});
  };
  const list = async () => {
    const result = await proxyRequest(port, `/mcp/tools?profile=${encodeURIComponent(profile)}`, undefined, profile, home, observe);
    if (!Array.isArray(result.tools)) throw new Error(result.reason ?? 'daemon tool list unavailable');
    return { tools: result.tools };
  };
  // Fetch before initialize completes, and always serve tools/list from the live daemon.
  await list();
  server.setRequestHandler(ListToolsRequestSchema, list);
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const input = params.arguments ?? {};
    const progressToken = params._meta?.progressToken;
    if (params.name !== 'worker.wait' || (typeof progressToken !== 'string' && typeof progressToken !== 'number')) {
      return { content: [{ type: 'text', text: JSON.stringify(await proxyRequest(port, `/tools/${encodeURIComponent(params.name)}`, input, profile, home, observe)) }] };
    }
    const workerIds = Array.isArray((input as { workerIds?: unknown }).workerIds)
      ? (input as { workerIds: unknown[] }).workerIds.filter((id): id is string => typeof id === 'string')
      : [];
    const timeoutMs = typeof (input as { timeoutMs?: unknown }).timeoutMs === 'number' ? (input as { timeoutMs: number }).timeoutMs : 600_000;
    const started = Date.now();
    const sent = new Map<string, string>();
    const sentAt = new Map<string, number>();
    const publish = async (force = false) => {
      const snapshot = await proxyRequest(port, '/api/state', undefined, profile, home, observe) as ProgressState;
      for (const workerId of workerIds) {
        const update = waitProgress(snapshot, workerId, started, timeoutMs);
        const signature = progressSignature(update);
        const last = sent.get(workerId);
        const now = Date.now();
        if (!force && last === signature && now - (sentAt.get(workerId) ?? 0) < WAIT_PROGRESS_MS) continue;
        sent.set(workerId, signature);
        sentAt.set(workerId, now);
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: Math.min(timeoutMs, Date.now() - started),
            total: timeoutMs,
            message: `state=${update.state}; position=${update.position ?? '-'}; etaMs=${update.etaMs}; activity=${update.activity}`,
            _meta: { helm: update },
          },
        });
      }
    };
    await publish(true).catch(() => undefined);
    let publishing = false;
    const progress = setInterval(() => {
      if (publishing) return;
      publishing = true;
      void publish().catch(() => undefined).finally(() => { publishing = false; });
    }, progressPollMs);
    progress.unref();
    try {
      const outcome = await proxyRequest(port, `/tools/${encodeURIComponent(params.name)}`, input, profile, home, observe);
      await publish().catch(() => undefined);
      return { content: [{ type: 'text', text: JSON.stringify(outcome) }] };
    } finally {
      clearInterval(progress);
    }
  });
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  let poll: ReturnType<typeof setInterval> | undefined;
  const onEnd = () => { void server.close(); };
  if (transport instanceof StdioServerTransport) process.stdin.once('end', onEnd);
  server.onclose = () => { connected = false; clearInterval(poll); process.stdin.off('end', onEnd); finish(); };
  await server.connect(transport);
  connected = true;
  let polling = false;
  poll = setInterval(() => {
    if (polling) return;
    polling = true;
    void list().catch(() => {}).finally(() => { polling = false; });
  }, pollMs);
  poll.unref();
  return { port, closed, async close() { clearInterval(poll); await server.close(); } };
}
