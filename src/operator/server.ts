import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { formatOperatorJson, readOperatorSnapshot, renderOperatorHtml } from "./projection.js";
import type { SnapshotSource } from "./types.js";
import type { HelmToolExecutionContext, HelmToolRegistry } from '../runtime/orchestrator/index.js';

const boundPorts = new WeakMap<Server, number>();

function reply(response: ServerResponse, status: number, body: string, type: string, historical = false): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...(historical ? { "x-helm-projection": "historical-untrusted" } : {}) });
  response.end(body);
}

function allowedOrigin(origin: string, host: string): boolean {
  return origin === `http://${host}`;
}

function requestAllowed(request: IncomingMessage, port: number | undefined): boolean {
  const host = request.headers.host;
  if (host === undefined || port === undefined || host !== `127.0.0.1:${port}`) return false;
  const origin = request.headers.origin;
  return origin === undefined || (typeof origin === "string" && allowedOrigin(origin, host));
}

export type OperatorReadApi = Readonly<{ registry: HelmToolRegistry; context: HelmToolExecutionContext }>;

function readRequest(url: string | undefined): { name: string; input: Record<string, unknown> } | undefined {
  if (!url) return undefined;
  const parsed = new URL(url, 'http://127.0.0.1');
  const match = parsed.pathname.match(/^\/api\/operator\/read\/(brief\.get|map\.get|log\.query|models\.get|budget\.get|worker\.inspect)$/);
  if (!match) return undefined;
  if (match[1] !== 'log.query' && match[1] !== 'worker.inspect' && [...parsed.searchParams.keys()].length) throw new Error('read tool does not accept query parameters');
  if (match[1] === 'log.query') {
    const values = [...parsed.searchParams.entries()];
    if (values.length > 1 || (values[0] && values[0][0] !== 'limit') || (values[0] && !/^[1-9][0-9]{0,2}$/.test(values[0][1]))) throw new Error('invalid log query limit');
    return { name: match[1], input: values[0] ? { limit: Number(values[0][1]) } : {} };
  }
  if (match[1] === 'worker.inspect') {
    const values = [...parsed.searchParams.entries()];
    if (values.length !== 1 || values[0]![0] !== 'workerId' || values[0]![1].length === 0 || values[0]![1].length > 128) throw new Error('invalid worker inspection request');
    return { name: match[1], input: { workerId: values[0]![1] } };
  }
  return { name: match[1], input: {} };
}

export function createOperatorServer(source: SnapshotSource, reads?: OperatorReadApi): Server {
  const server = createServer(async (request, response) => {
    if (!requestAllowed(request, boundPorts.get(server))) { reply(response, 403, "forbidden\n", "text/plain; charset=utf-8"); return; }
    if (request.method !== "GET") { reply(response, 405, "method not allowed\n", "text/plain; charset=utf-8"); return; }
    let requestedRead: { name: string; input: Record<string, unknown> } | undefined;
    try { requestedRead = readRequest(request.url); }
    catch { reply(response, 400, "invalid read request\n", "text/plain; charset=utf-8"); return; }
    try {
      if (requestedRead) {
        if (!reads) { reply(response, 404, "not found\n", "text/plain; charset=utf-8"); return; }
        const outcome = await reads.registry.invoke(requestedRead.name, requestedRead.input, reads.context);
        reply(response, 200, JSON.stringify(outcome), "application/json; charset=utf-8"); return;
      }
      const snapshot = await readOperatorSnapshot(source);
      if (request.url === "/api/operator/snapshot") { reply(response, 200, formatOperatorJson(snapshot), "application/json; charset=utf-8", source.presentation?.mode === "historical-untrusted"); return; }
      if (request.url === "/") { reply(response, 200, renderOperatorHtml(snapshot, source.presentation), "text/html; charset=utf-8", source.presentation?.mode === "historical-untrusted"); return; }
      reply(response, 404, "not found\n", "text/plain; charset=utf-8");
    } catch {
      reply(response, 500, "snapshot unavailable\n", "text/plain; charset=utf-8");
    }
  });
  return server;
}

export async function listenOperatorServer(server: Server): Promise<{ host: "127.0.0.1"; port: number }> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0 }, () => resolve()); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("operator server did not receive an ephemeral port");
  boundPorts.set(server, address.port);
  return { host: "127.0.0.1", port: address.port };
}
