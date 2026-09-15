import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { formatOperatorJson, readOperatorSnapshot, renderOperatorHtml } from "./projection.js";
import type { SnapshotSource } from "./types.js";

const boundPorts = new WeakMap<Server, number>();

function reply(response: ServerResponse, status: number, body: string, type: string): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
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

export function createOperatorServer(source: SnapshotSource): Server {
  const server = createServer(async (request, response) => {
    if (!requestAllowed(request, boundPorts.get(server))) { reply(response, 403, "forbidden\n", "text/plain; charset=utf-8"); return; }
    if (request.method !== "GET") { reply(response, 405, "method not allowed\n", "text/plain; charset=utf-8"); return; }
    try {
      const snapshot = await readOperatorSnapshot(source);
      if (request.url === "/api/operator/snapshot") { reply(response, 200, formatOperatorJson(snapshot), "application/json; charset=utf-8"); return; }
      if (request.url === "/") { reply(response, 200, renderOperatorHtml(snapshot), "text/html; charset=utf-8"); return; }
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
