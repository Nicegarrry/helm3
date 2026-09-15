import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js' with { 'resolution-mode': 'import' };
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js' with { 'resolution-mode': 'import' };
import type { HelmToolRegistry, HelmToolResult, OrchestratorSessionGuard } from './index.js';

type McpSdk = {
  McpServer: typeof McpServer;
  StreamableHTTPServerTransport: typeof StreamableHTTPServerTransport;
};
class HttpInputError extends Error {
  constructor(readonly status: 400 | 413) { super(status === 413 ? 'MCP request body exceeds the loopback limit' : 'MCP request body is malformed'); }
}

export type AstraLoopbackSession = Readonly<{ runId: string; sessionId: string; mode: 'primary' | 'consultant' }>;
export type AstraLoopbackMcpConfig = Readonly<{ mcp_servers: Readonly<{ helm: Readonly<{ url: string; bearer_token_env_var: string }> }> }>;
export type AstraLoopbackMcpClose = Readonly<{ observed: 'stopped' | 'unknown' }>;

async function loadMcpSdk(): Promise<McpSdk> {
  const [mcp, streamableHttp] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
  ]);
  return { McpServer: mcp.McpServer, StreamableHTTPServerTransport: streamableHttp.StreamableHTTPServerTransport };
}

function result(result: HelmToolResult): { content: Array<{ type: 'text'; text: string }>; structuredContent: HelmToolResult; isError: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.state !== 'succeeded' };
}
function sameBearer(candidate: string | string[] | undefined, expected: string): boolean {
  if (typeof candidate !== 'string') return false;
  const actual = Buffer.from(candidate);
  const wanted = Buffer.from(`Bearer ${expected}`);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => server.listen({ host: '127.0.0.1', port: 0 }, () => {
    const address = server.address();
    if (!address || typeof address === 'string') { reject(new Error('Loopback MCP server did not expose a TCP port')); return; }
    resolve(address.port);
  }).once('error', reject));
}
function boundedDeadline(value: number | undefined): number {
  const deadline = value ?? 100;
  if (!Number.isInteger(deadline) || deadline < 0 || deadline > 5_000) throw new Error('MCP close deadline must be an integer from 0 to 5000 milliseconds');
  return deadline;
}

/**
 * A per-session, loopback-only MCP bridge. The generated bearer secret stays in
 * the returned in-memory environment fragment and is never written to a Helm
 * artifact or config file.
 */
export class AstraLoopbackMcpTransport {
  readonly config: AstraLoopbackMcpConfig;
  readonly env: Readonly<Record<string, string>>;
  readonly #active = new Set<Promise<HelmToolResult>>();
  readonly #protocols = new Set<{ mcp: McpServer; transport: StreamableHTTPServerTransport }>();
  #closing = false;
  #listenerClose?: Promise<void>;
  #mcpClose?: Promise<void>;

  private constructor(
    private readonly server: Server,
    private readonly sdk: McpSdk,
    private readonly registry: HelmToolRegistry,
    private readonly guard: OrchestratorSessionGuard,
    session: AstraLoopbackSession,
    private readonly token: string,
    port: number,
    envKey: string,
  ) {
    this.session = Object.freeze({ ...session });
    this.config = Object.freeze({ mcp_servers: Object.freeze({ helm: Object.freeze({ url: `http://127.0.0.1:${port}/mcp`, bearer_token_env_var: envKey }) }) });
    this.env = Object.freeze({ [envKey]: token });
  }
  private readonly session: AstraLoopbackSession;

  static async open(input: { registry: HelmToolRegistry; guard: OrchestratorSessionGuard; session: AstraLoopbackSession }): Promise<AstraLoopbackMcpTransport> {
    const sdk = await loadMcpSdk();
    const token = randomBytes(32).toString('base64url');
    const envKey = `HELM_ASTRA_MCP_TOKEN_${randomBytes(12).toString('hex').toUpperCase()}`;
    let instance: AstraLoopbackMcpTransport | undefined;
    const server = createServer((request, response) => {
      if (!instance) { response.writeHead(503).end(); return; }
      void instance.handle(request, response);
    });
    const port = await listenLoopback(server);
    instance = new AstraLoopbackMcpTransport(server, sdk, input.registry, input.guard, input.session, token, port, envKey);
    return instance;
  }

  private async invoke(name: string, input: unknown): Promise<HelmToolResult> {
    if (this.#closing) return { state: 'refused', reason: 'Helm loopback MCP transport is closing' };
    if (this.session.mode !== 'primary') return { state: 'refused', reason: 'Consultant sessions cannot issue Helm tool effects' };
    const active = (async () => {
      try { await this.guard.assertCurrent(this.session); }
      catch { return { state: 'refused' as const, reason: 'Helm session ownership is not current' }; }
      if (this.#closing) return { state: 'refused' as const, reason: 'Helm loopback MCP transport is closing' };
      return this.registry.invoke(name, input, this.session);
    })();
    this.#active.add(active);
    try { return await active; }
    finally { this.#active.delete(active); }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const expectedHost = new URL(this.config.mcp_servers.helm.url).host;
    if (this.#closing) { response.writeHead(503).end(); return; }
    if (request.url !== '/mcp') { response.writeHead(404).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }).end(); return; }
    if (request.headers.host !== expectedHost || request.headers.origin !== undefined) { response.writeHead(403).end(); return; }
    if (!sameBearer(request.headers.authorization, this.token)) { response.writeHead(401, { 'www-authenticate': 'Bearer' }).end(); return; }
    let body: unknown;
    try { body = await this.parseBody(request); }
    catch (error) {
      if (error instanceof HttpInputError) response.writeHead(error.status).end();
      else response.writeHead(500).end();
      return;
    }
    if (this.#closing) { response.writeHead(503).end(); return; }
    let protocol: { mcp: McpServer; transport: StreamableHTTPServerTransport } | undefined;
    try {
      protocol = await this.protocol();
      const dispose = () => { void this.disposeProtocol(protocol!); };
      response.once('close', dispose);
      await protocol.transport.handleRequest(request, response, body);
      if (response.writableEnded) dispose();
    } catch { if (!response.headersSent) response.writeHead(500).end(); }
  }

  private async protocol(): Promise<{ mcp: McpServer; transport: StreamableHTTPServerTransport }> {
    const mcp = new this.sdk.McpServer({ name: 'helm-astra-loopback', version: '0.0.0' });
    const transport = new this.sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const protocol = { mcp, transport }; this.#protocols.add(protocol);
    try {
      for (const tool of this.registry.all()) {
        mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => result(await this.invoke(tool.name, args)));
      }
      await mcp.connect(transport);
      return protocol;
    } catch (error) { await this.disposeProtocol(protocol); throw error; }
  }

  private async disposeProtocol(protocol: { mcp: McpServer; transport: StreamableHTTPServerTransport }): Promise<void> {
    if (!this.#protocols.delete(protocol)) return;
    await protocol.mcp.close().catch(() => undefined);
  }

  private async parseBody(request: IncomingMessage): Promise<unknown> {
    const maximum = 64 * 1024;
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined) {
      const declared = Number(contentLength);
      if (!Number.isFinite(declared) || declared < 0) throw new HttpInputError(400);
      if (declared > maximum) throw new HttpInputError(413);
    }
    const chunks: Buffer[] = []; let length = 0; let tooLarge = false;
    await new Promise<void>((resolve, reject) => {
      request.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > maximum) { tooLarge = true; return; }
        chunks.push(bytes);
      });
      request.once('end', resolve); request.once('error', reject); request.once('aborted', () => reject(new Error('MCP request aborted')));
    });
    if (tooLarge) throw new HttpInputError(413);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpInputError(400); }
  }

  private async fenceListener(): Promise<void> {
    if (!this.#listenerClose) {
      this.#closing = true;
      this.#listenerClose = closeServer(this.server);
      this.server.closeAllConnections();
      this.#mcpClose = Promise.all([...this.#protocols].map((protocol) => this.disposeProtocol(protocol))).then(() => undefined);
    }
    await this.#listenerClose;
    await this.#mcpClose;
  }

  private async drained(deadline: number): Promise<boolean> {
    if (this.#active.size === 0) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.allSettled([...this.#active]).then(() => true);
    const elapsed = new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), deadline); });
    const complete = await Promise.race([settled, elapsed]);
    if (timeout) clearTimeout(timeout);
    return complete && this.#active.size === 0;
  }

  /** Closing the transport fences new effects; a non-drained callback remains unknown. */
  async close(options: { drainDeadlineMs?: number } = {}): Promise<AstraLoopbackMcpClose> {
    const deadline = boundedDeadline(options.drainDeadlineMs);
    await this.fenceListener();
    return { observed: await this.drained(deadline) ? 'stopped' : 'unknown' };
  }
}
