/** Stable stdio shim: schemas and validation belong exclusively to the daemon. */
import { request } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, EmptyResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { daemonConnection } from '../bin/daemon-auth.mjs';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export const SHIM_VERSION = 1;
export const MIN_SHIM_VERSION = 1;
export const SHIM_RESTART_NOTE = 'Restart this MCP session: its Helm shim is below the supported minimum.';
const WAIT_PROGRESS_MS = 30_000;
const WAIT_PROGRESS_POLL_MS = 10_000;
const PROGRESS_READ_TIMEOUT_MS = 2_000;
const PROGRESS_FLUSH_TIMEOUT_MS = 5_000;

function configuredProgressPollMs() {
  const configured = Number(process.env.HELM_PROGRESS_POLL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : WAIT_PROGRESS_POLL_MS;
}

function logProgressError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`helm stdio progress publish failed: ${message}\n`);
}

type ProgressWorker = Readonly<{
  workerId: string;
  state: string;
  lastEvent?: Readonly<{ kind?: unknown; data?: unknown }> | null;
}>;

type ProgressState = Readonly<{ workers?: readonly (ProgressWorker & { position?: number | null; etaMs?: number })[] }>;

function activity(worker: ProgressWorker): string {
  const event = worker.lastEvent;
  if (!event) return 'waiting for worker activity';
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data) ?? '';
  return `${String(event.kind ?? 'activity')}: ${data}`.replace(/\s+/g, ' ').slice(0, 240);
}

function waitProgress(state: ProgressState, workerId: string) {
  const worker = state.workers?.find((candidate) => candidate.workerId === workerId);
  return {
    state: worker?.state ?? 'unknown',
    position: worker?.position ?? null,
    etaMs: worker?.etaMs ?? 0,
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

export async function serveStdioProxy(port: number, profile = process.env.HELM_TOOLS ?? 'core', home?: string, transport: Transport = new StdioServerTransport(), pollMs = 60_000, progressPollMs = configuredProgressPollMs()) {
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
    let progressValue = 0;
    let done = false;
    let progressFailureLogged = false;
    const sent = new Map<string, string>();
    const sentAt = new Map<string, number>();
    const publish = async (force = false) => {
      if ((done && !force) || extra.signal.aborted) return;
      const query = new URLSearchParams({ workerIds: workerIds.join(','), timeoutMs: String(timeoutMs), startedAt: String(started) });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let snapshot: ProgressState & { ok?: boolean };
      try {
        snapshot = await Promise.race([
          proxyRequest(port, `/api/progress?${query}`, undefined, profile, home, observe, PROGRESS_READ_TIMEOUT_MS),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('progress read timed out')), PROGRESS_READ_TIMEOUT_MS); }),
        ]) as ProgressState & { ok?: boolean };
      } finally { clearTimeout(timeout); }
      if (snapshot.ok !== true || !Array.isArray(snapshot.workers)) throw new Error(String((snapshot as { reason?: unknown }).reason ?? 'progress read failed'));
      for (const workerId of workerIds) {
        if ((done && !force) || extra.signal.aborted) return;
        const update = waitProgress(snapshot, workerId);
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
            progress: ++progressValue,
            message: `worker=${workerId}; state=${update.state}; position=${update.position ?? '-'}; etaMs=${update.etaMs}; activity=${update.activity}`,
            _meta: { helm: { ...update, workerId } },
          },
        });
      }
    };
    const wait = proxyRequest(port, `/tools/${encodeURIComponent(params.name)}`, input, profile, home, observe);
    const publishSafely = async (force = false) => {
      try { await publish(force); }
      catch (error) { if (!progressFailureLogged) { progressFailureLogged = true; logProgressError(error); } }
    };
    const publishTerminal = async (outcome: { settled?: Array<{ workerId?: string; id?: string; state?: string; status?: string }>; workers?: Array<{ workerId?: string; id?: string; state?: string; status?: string }> }) => {
      if (extra.signal.aborted) return false;
      let sentTerminal = false;
      for (const settled of outcome.settled ?? outcome.workers ?? []) {
        const workerId = settled.workerId ?? settled.id;
        const state = settled.state ?? settled.status;
        if (!workerId || !state) continue;
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: ++progressValue,
            message: `worker=${workerId}; state=${state}; position=-; etaMs=0; activity=worker wait completed`,
            _meta: { helm: { workerId, state, position: null, etaMs: 0, activity: 'worker wait completed' } },
          },
        });
        sentTerminal = true;
      }
      return sentTerminal;
    };
    let publishing = false;
    let publishingNow: Promise<void> | undefined;
    const pollProgress = () => {
      if (publishing || extra.signal.aborted) return;
      publishing = true;
      publishingNow = publishSafely().finally(() => { publishing = false; });
    };
    pollProgress();
    const progress = setInterval(() => {
      pollProgress();
    }, progressPollMs);
    progress.unref();
    const stopProgress = () => clearInterval(progress);
    extra.signal.addEventListener('abort', stopProgress, { once: true });
    try {
      const outcome = await wait;
      done = true;
      stopProgress();
      await publishingNow;
      const terminalSent = await publishTerminal(outcome).catch((error) => { logProgressError(error); return false; });
      if (!terminalSent) await publishSafely(true);
      // SDK clients dispatch notifications on a microtask but responses synchronously, then drop progress for
      // a settled request: a final update read in the same chunk as the response is lost. Requests queue behind
      // notifications, so an answered ping proves the client dispatched every update sent before it.
      if (progressValue > 0 && !extra.signal.aborted) {
        await extra.sendRequest({ method: 'ping' }, EmptyResultSchema, { signal: extra.signal, timeout: PROGRESS_FLUSH_TIMEOUT_MS }).catch(() => {});
      }
      return { content: [{ type: 'text', text: JSON.stringify(outcome) }] };
    } finally {
      stopProgress();
      extra.signal.removeEventListener('abort', stopProgress);
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
