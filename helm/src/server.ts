/** `helm serve`: exposes the tool registry over MCP (stdio and Streamable HTTP) plus a small loopback HTTP API the CLI uses. */
import { createServer, type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { compactInputSchema, compactInputValidator, createToolRegistry, resolveToolProfile, type ToolProfile } from './tools.js';
import { VERSION } from './lifecycle.js';
import type { Helm } from './helm.js';
import { daemonAuthorization } from '../bin/daemon-auth.mjs';

export type ServeOptions = Readonly<{ helm: Helm; port?: number }>;
/** `closed` resolves when the peer goes away (stdio only), so the process can exit with it. */
export type ServeHandle = Readonly<{ close(): Promise<void>; port?: number; closed?: Promise<void> }>;

type Registry = ReturnType<typeof createToolRegistry>;

/** The daemon: owns the store and the workers, serves the CLI endpoint and MCP over HTTP. */
export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  return serveHttp(opts.helm, createToolRegistry(opts.helm, 'all'), opts.port ?? 0);
}

export { serveStdioProxy } from './proxy.js';
import { MIN_SHIM_VERSION, SHIM_RESTART_NOTE } from './proxy.js';

export function callDaemon(port: number, name: string, input: unknown, fromMcp = false, tools?: ToolProfile, home?: string): Promise<unknown> {
  let authorization: string;
  try { authorization = daemonAuthorization(home); }
  catch { return Promise.resolve({ ok: false, reason: 'daemon authentication unavailable' }); }
  return new Promise((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/tools/${encodeURIComponent(name)}`, headers: { authorization, 'content-type': 'application/json', ...(fromMcp ? { 'x-helm-mcp': '1', 'x-helm-tools': tools ?? 'core' } : {}) } }, (res) => {
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

function advertisedTools(registry: Registry) {
  return registry.list().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: compactInputSchema(tool.inputSchema) }));
}

type Catalog = { registry: Registry; tools: ReturnType<typeof advertisedTools>; inputs: Map<string, ReturnType<typeof compactInputValidator>>; hash: string };

/** Catalogs are immutable for one daemon boot; a new release creates a new cache. */
export function createDaemonCatalogs(helm: Helm) {
  const cache = new Map<ToolProfile, Catalog>();
  return (profile: ToolProfile): Catalog => {
    let catalog = cache.get(profile);
    if (!catalog) {
      const registry = createToolRegistry(helm, profile, true);
      const tools = advertisedTools(registry);
      const inputs = new Map(registry.list().map((tool) => [tool.name, compactInputValidator(tool.inputSchema)]));
      catalog = { registry, tools, inputs, hash: createHash('sha256').update(JSON.stringify(tools)).digest('hex') };
      cache.set(profile, catalog);
    }
    return catalog;
  };
}

function buildMcpServer(catalog: Catalog): McpServer {
  const { registry, tools } = catalog;
  const server = new McpServer({ name: 'helm', version: VERSION });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: catalog.inputs.get(tool.name)! },
      async (args: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(await registry.call(tool.name, args)) }] }),
    );
  }
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  return server;
}

async function serveHttp(helm: Helm, internalRegistry: Registry, requestedPort: number): Promise<ServeHandle> {
  const home = helm.config.home;
  mkdirSync(home, { recursive: true });
  let port = requestedPort;
  const token = randomBytes(32).toString('hex');
  const getCatalog = createDaemonCatalogs(helm);

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, helm, internalRegistry, getCatalog, () => port, token);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  port = typeof address === 'object' && address ? address.port : requestedPort;

  const serveJsonPath = join(home, 'serve.json');
  const temp = `${serveJsonPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ port, pid: process.pid, token }), { mode: 0o600, flag: 'wx' });
    renameSync(temp, serveJsonPath);
  } catch (err) {
    httpServer.close();
    rmSync(temp, { force: true });
    throw err;
  }

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

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, helm: Helm, internalRegistry: Registry, getCatalog: ReturnType<typeof createDaemonCatalogs>, getPort: () => number, token: string): Promise<void> {
  try {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${getPort()}` || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden: bad host');
      return;
    }
    const authorization = req.headers.authorization;
    const supplied = Buffer.from(typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    const requestedProfile = url.pathname === '/mcp/tools' ? url.searchParams.get('profile') : url.pathname === '/mcp' ? url.searchParams.get('tools') : null;
    const catalog = getCatalog(resolveToolProfile(requestedProfile ?? req.headers['x-helm-tools']));
    res.setHeader('x-helm-tools-hash', catalog.hash);
    const shim = req.headers['x-helm-shim'];
    const oldShim = (shim !== undefined || req.headers['x-helm-mcp'] === '1') && Number(shim ?? 0) < MIN_SHIM_VERSION;
    if (oldShim) res.setHeader('x-helm-shim-note', SHIM_RESTART_NOTE);

    if (url.pathname === '/mcp/tools' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tools: catalog.tools, ...(oldShim ? { note: SHIM_RESTART_NOTE } : {}) }));
      return;
    }

    if (url.pathname === '/mcp') {
      const mcp = buildMcpServer(catalog);
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
      const outcome = await helm.list({});
      const body = outcome.ok ? formatWorkerTable(outcome.workers) : `error: ${outcome.reason}`;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(body);
      return;
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await helm.overview()));
      return;
    }

    if (url.pathname === '/api/progress' && req.method === 'GET') {
      const workerIds = (url.searchParams.get('workerIds') ?? '').split(',').filter(Boolean).slice(0, 20);
      const timeoutMs = Number(url.searchParams.get('timeoutMs'));
      const startedAt = Number(url.searchParams.get('startedAt'));
      if (!workerIds.length || !Number.isFinite(timeoutMs) || !Number.isFinite(startedAt)) { res.writeHead(400).end('invalid progress query'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await helm.progress(workerIds, timeoutMs, startedAt)));
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
      const registry = req.headers['x-helm-mcp'] === '1'
        ? catalog.registry
        : internalRegistry;
      const outcome = await registry.call(name, input);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(oldShim ? { ...outcome, note: SHIM_RESTART_NOTE } : outcome));
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
