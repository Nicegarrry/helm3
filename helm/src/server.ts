/** `helm serve`: exposes the tool registry over MCP (stdio and Streamable HTTP) plus a small loopback HTTP API the CLI uses. */
import { createServer, type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createToolRegistry } from './tools.js';
import { renderDashboardShell } from './ui.js';
import { VERSION } from './lifecycle.js';
import type { Helm } from './helm.js';

export type ServeOptions = Readonly<{ helm: Helm; port?: number }>;
/** `closed` resolves when the peer goes away (stdio only), so the process can exit with it. */
export type ServeHandle = Readonly<{ close(): Promise<void>; port?: number; closed?: Promise<void> }>;

type Registry = ReturnType<typeof createToolRegistry>;

/** The daemon: owns the store and the workers, serves the dashboard, the CLI endpoint and MCP over HTTP. */
export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  return serveHttp(opts.helm, createToolRegistry(opts.helm), opts.port ?? 0);
}

/** Stdio proxy: owns no workers or store; forwards calls without replay. See docs/runtime-notes.md. */
export async function serveStdioProxy(port: number): Promise<ServeHandle> {
  const local = createToolRegistry(undefined as unknown as Helm); // schemas only; `call` never runs here
  const registry: Registry = {
    list: () => local.list(),
    call: (name, input) => callDaemon(port, name, input) as ReturnType<Registry['call']>,
  };
  const mcp = buildMcpServer(registry);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once('end', () => resolve());
  });
  await mcp.connect(transport);
  return { port, closed, async close() { await mcp.close(); } };
}

export function callDaemon(port: number, name: string, input: unknown): Promise<unknown> {
  return new Promise((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/tools/${encodeURIComponent(name)}`, headers: { 'content-type': 'application/json' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('error', (err) => resolve({ ok: false, reason: `daemon response interrupted: ${err.message}; mutation outcome may be unknown, inspect before retrying` }));
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ ok: false, reason: `daemon returned ${res.statusCode}: ${body.slice(0, 200)}` }); } });
      });
      req.on('error', (err) => resolve({ ok: false, reason: `daemon unreachable on port ${port}: ${err.message}` }));
      req.end(JSON.stringify(input ?? {}));
  });
}

function buildMcpServer(registry: Registry): McpServer {
  const server = new McpServer({ name: 'helm', version: VERSION });
  for (const tool of registry.list()) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(await registry.call(tool.name, args)) }] }),
    );
  }
  return server;
}

async function serveHttp(helm: Helm, registry: Registry, requestedPort: number): Promise<ServeHandle> {
  const home = helm.config.home;
  mkdirSync(home, { recursive: true });
  let port = requestedPort;

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, helm, registry, () => port);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  port = typeof address === 'object' && address ? address.port : requestedPort;

  const serveJsonPath = join(home, 'serve.json');
  writeFileSync(serveJsonPath, JSON.stringify({ port, pid: process.pid }));

  return {
    port,
    async close() {
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      const timer = setTimeout(() => httpServer.closeAllConnections(), 100);
      await closed;
      clearTimeout(timer);
      try {
        rmSync(serveJsonPath, { force: true });
      } catch {
        // already gone
      }
    },
  };
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, helm: Helm, registry: Registry, getPort: () => number): Promise<void> {
  try {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${getPort()}` || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden: bad host');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);

    if (url.pathname === '/mcp') {
      const mcp = buildMcpServer(registry);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
      if ((req.headers.accept ?? '').includes('text/html')) {
        // The page is a static shell (src/ui.ts) that polls the /api/* endpoints below for its data.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(renderDashboardShell());
        return;
      }
      const outcome = await helm.list({});
      const body = outcome.ok ? formatWorkerTable(outcome.workers) : `error: ${outcome.reason}`;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(body);
      return;
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await helm.overview()));
      return;
    }

    const workerMatch = req.method === 'GET' ? url.pathname.match(/^\/api\/worker\/([^/]+)$/) : null;
    if (workerMatch) {
      const workerId = decodeURIComponent(workerMatch[1] ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await helm.workerDetail(workerId)));
      return;
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      // Both params are optional; recentEvents() clamps them (limit default 100, max 1000; NaN falls back to the default).
      const after = Number(url.searchParams.get('after') ?? '0');
      const limitParam = url.searchParams.get('limit');
      const outcome = limitParam === null ? await helm.recentEvents(after) : await helm.recentEvents(after, Number(limitParam));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(outcome));
      return;
    }

    if (url.pathname === '/api/status' && req.method === 'GET') {
      const status = await helm.runStatus();
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status));
      return;
    }

    const toolMatch = req.method === 'POST' ? url.pathname.match(/^\/tools\/([^/]+)$/) : null;
    if (toolMatch) {
      const name = decodeURIComponent(toolMatch[1] ?? '');
      let input: unknown;
      try {
        input = await readJsonBody(req, res);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) return; // 413 already sent, socket already torn down
        if (err instanceof InvalidJsonBodyError) {
          res.writeHead(400, { 'content-type': 'text/plain' }).end('invalid JSON body');
          return;
        }
        throw err;
      }
      const outcome = await registry.call(name, input);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(outcome));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB (F12)

class PayloadTooLargeError extends Error {}
class InvalidJsonBodyError extends Error {}

/** Cap the body at 1 MiB (413 + socket teardown past that) and turn a parse failure into 400, not 500. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      const socket = req.socket; // capture now: req.socket can go null once the request completes
      res.writeHead(413, { 'content-type': 'text/plain' }).end('payload too large', () => {
        socket?.destroy();
      });
      throw new PayloadTooLargeError('request body exceeds 1 MiB');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonBodyError('invalid JSON body');
  }
}

/** Plain-text worker table. Shared by GET / and `helm ps`, so both render identically. */
export function formatWorkerTable(
  workers: ReadonlyArray<{ workerId: string; state: string; role: string; model: string; branch: string; head: string | null; createdAt: string }>,
): string {
  if (workers.length === 0) return 'no workers';
  const header = ['WORKER', 'STATE', 'ROLE', 'MODEL', 'BRANCH', 'HEAD', 'CREATED'];
  const rows = workers.map((w) => [w.workerId, w.state, w.role, w.model, w.branch, w.head ? w.head.slice(0, 7) : '-', w.createdAt]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
