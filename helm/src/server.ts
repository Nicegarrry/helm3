/**
 * `helm serve`: exposes the tool registry over MCP (stdio and Streamable HTTP) plus a
 * small loopback HTTP API the CLI uses. See DESIGN.md and one-shot-brief.md section 3.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createToolRegistry } from './tools.js';
import type { Helm, Overview } from './helm.js';

export type ServeOptions = Readonly<{ helm: Helm; mode: 'stdio' | 'http'; port?: number }>;
export type ServeHandle = Readonly<{ close(): Promise<void>; port?: number }>;

type Registry = ReturnType<typeof createToolRegistry>;

export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const registry = createToolRegistry(opts.helm);
  if (opts.mode === 'stdio') {
    // stdout is the MCP channel, so the read-only status page and CLI endpoint bind on loopback HTTP alongside it.
    const http = await serveHttp(opts.helm, registry, opts.port ?? 0);
    const mcp = buildMcpServer(registry);
    await mcp.connect(new StdioServerTransport());
    return { port: http.port, async close() { await mcp.close(); await http.close(); } };
  }
  return serveHttp(opts.helm, registry, opts.port ?? 0);
}

function buildMcpServer(registry: Registry): McpServer {
  const server = new McpServer({ name: 'helm', version: '0.1.0' });
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
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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
    if (host !== `127.0.0.1:${getPort()}`) {
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
        const overview = await helm.overview();
        const body = overview.ok ? renderDashboard(overview) : `<p>error: ${escapeHtml(overview.reason)}</p>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
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

/** Escape text for safe interpolation into HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function fmtUsd(n: number): string { return `$${n.toFixed(n >= 1 ? 2 : 4)}`; }
function fmtTokens(n: number): string { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000); if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Read-only dashboard for GET / when the client asks for text/html. Server rendered, auto-refreshes, no JS. */
export function renderDashboard(o: Overview): string {
  const e = escapeHtml;
  const run = o.run;
  const cap = run.spendCapUsd > 0 ? ` / ${fmtUsd(run.spendCapUsd)} cap` : ' (no cap)';
  const workerRows = o.workers.map((w) => `<tr class="s-${e(w.state)}">
<td><code>${e(w.workerId)}</code><br><small>${e(w.repoSlug)} &middot; ${e(w.branch)}</small></td>
<td><span class="pill">${e(w.state)}</span>${w.resultStatus ? `<br><small>${e(w.resultStatus)}</small>` : ''}</td>
<td>${e(w.role)}</td><td>${e(w.model)}</td>
<td class="num">${fmtUsd(w.spendUsd)}${w.unknownCostEvents ? `<br><small>${w.unknownCostEvents} unknown</small>` : ''}</td>
<td class="num">${fmtTokens(w.tokens)}</td><td class="num">${fmtElapsed(w.elapsedMs)}</td>
<td><code>${e(w.head ? w.head.slice(0, 8) : '-')}</code></td>
<td class="obj">${e(w.objective)}</td>
<td class="ev">${w.lastEvent ? `<code>${e(w.lastEvent.kind)}</code> ${e(w.lastEvent.summary)}` : '-'}</td></tr>`).join('');
  const modelRows = o.models.map((m) => `<tr><td>${e(m.model)}</td><td class="num">${m.workers}</td><td class="num">${m.active}</td><td class="num">${fmtUsd(m.spendUsd)}</td><td class="num">${fmtTokens(m.tokens)}</td></tr>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Helm</title>
<style>
:root { color-scheme: light dark; --ok:#2e9e5b; --run:#2f7de1; --bad:#d64545; --warn:#c98a11; --mute:color-mix(in srgb, currentColor 55%, transparent); }
body { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1rem 1.25rem; }
header { display:flex; gap:1rem; align-items:baseline; flex-wrap:wrap; margin-bottom: .75rem; }
h1 { font-size: 16px; margin: 0; } h2 { font-size: 13px; margin: 1.25rem 0 .4rem; opacity:.8; text-transform: uppercase; letter-spacing:.04em; }
.live { display:inline-block; width:.55em; height:.55em; border-radius:50%; background:var(--ok); margin-right:.4em; animation: p 1.6s infinite; }
@keyframes p { 50% { opacity:.3; } }
.stat { color: var(--mute); } .stat b { color: inherit; font-weight:600; }
table { border-collapse: collapse; width: 100%; } th, td { text-align:left; vertical-align:top; padding:.35rem .55rem; border-bottom:1px solid color-mix(in srgb, currentColor 14%, transparent); }
th { color: var(--mute); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; } td.num { text-align:right; white-space:nowrap; } td.obj { max-width: 28ch; } td.ev { max-width: 32ch; overflow-wrap:anywhere; }
small { color: var(--mute); } td:first-child small { white-space: nowrap; } code { font: inherit; }
.pill { display:inline-block; padding:0 .45em; border-radius:.6em; border:1px solid currentColor; font-size:11px; }
tr.s-running .pill { color: var(--run); } tr.s-succeeded .pill { color: var(--ok); } tr.s-failed .pill, tr.s-unknown .pill { color: var(--bad); }
tr.s-idle .pill, tr.s-interrupted .pill, tr.s-stopped .pill, tr.s-queued .pill { color: var(--warn); }
</style></head>
<body>
<header><h1><span class="live"></span>Helm</h1>
<span class="stat">spend <b>${fmtUsd(run.spendUsd)}</b>${cap}</span>
<span class="stat">workers <b>${run.activeWorkers}</b> / ${run.maxWorkers} active</span>
<span class="stat">unknown-cost events <b>${run.unknownCostEvents}</b></span>
<span class="stat">observed ${e(o.observedAt)}</span></header>
<h2>Workers</h2>
<table><thead><tr><th>Worker</th><th>State</th><th>Role</th><th>Model</th><th>Spend</th><th>Tokens</th><th>Elapsed</th><th>Head</th><th>Objective</th><th>Last event</th></tr></thead>
<tbody>${workerRows || '<tr><td colspan="10"><small>no workers yet</small></td></tr>'}</tbody></table>
<h2>Models</h2>
<table><thead><tr><th>Model</th><th>Workers</th><th>Active</th><th>Spend</th><th>Tokens</th></tr></thead>
<tbody>${modelRows || '<tr><td colspan="5"><small>none observed</small></td></tr>'}</tbody></table>
<p><small>Read only. Refreshes every 3s. JSON at <code>/api/state</code>; tools over MCP at <code>/mcp</code>.</small></p>
</body></html>`;
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
