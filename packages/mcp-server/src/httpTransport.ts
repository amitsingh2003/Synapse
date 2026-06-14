/**
 * Phase 17.1 — Streamable HTTP / SSE transport for the synapse MCP server.
 * Phase 17.2 — optional bearer-token authentication.
 *
 * Uses Node's built-in `http` module; no Express dependency.
 *
 * Stateful mode: every new MCP session (initial POST without a session
 * header) spins up a fresh `StreamableHTTPServerTransport` + `McpServer`
 * pair. Subsequent requests for that session are routed by the
 * `mcp-session-id` header. Closed sessions are cleaned up automatically.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { log } from '@synapse/core';
import {
  createSynapseServer,
  type SynapseServer,
  type SynapseServerOptions,
} from './server.js';

export interface HttpServerOptions {
  /** Options forwarded to `createSynapseServer` for each new session. */
  serverOptions: SynapseServerOptions;
  /** Port to listen on (default 4000). */
  port?: number;
  /** Bind address (default '127.0.0.1' — loopback only). */
  host?: string;
  /**
   * If set, every HTTP request must carry `Authorization: Bearer <token>`.
   * Constant-time compared.
   */
  bearerToken?: string;
  /** HTTP path that hosts the MCP endpoint (default '/mcp'). */
  endpointPath?: string;
}

export interface HttpServerHandle {
  /** The underlying Node HTTP server. */
  server: Server;
  /** Resolved listen URL, e.g. `http://127.0.0.1:4000/mcp`. */
  url: string;
  /** Stop accepting connections, close every session, and free the DB handles. */
  close(): Promise<void>;
}

interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  synapse: SynapseServer;
}

function checkAuth(req: IncomingMessage, expected: string): boolean {
  const header = req.headers['authorization'];
  if (!header || Array.isArray(header)) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  // Use Node's constant-time compare; Buffer.from pads to equal length implicitly
  // by comparing byte-by-byte, so length differences are not leaked via timing.
  const provided = Buffer.from(m[1]!.trim());
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return false;
  return cryptoTimingSafeEqual(provided, expectedBuf);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', typeof body === 'string' ? 'text/plain' : 'application/json');
  res.end(text);
}

async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > limitBytes) {
        reject(new Error(`request body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

/** Start the HTTP MCP server and resolve when listening. */
export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const port = opts.port ?? 4000;
  const host = opts.host ?? '127.0.0.1';
  const endpoint = opts.endpointPath ?? '/mcp';
  const bearer = opts.bearerToken;
  const sessions = new Map<string, Session>();

  const httpServer = createServer((req, res) => {
    // CORS — when auth is enabled, restrict to localhost origins only so a
    // malicious page on the same machine cannot use a stolen bearer token.
    // When no auth is configured, wildcard is acceptable (loopback-bound).
    const origin = req.headers['origin'] as string | undefined;
    if (bearer && origin) {
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(origin);
      if (isLocalhost) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
      }
      // Non-localhost origins get no ACAO header → browser blocks them.
    } else {
      res.setHeader('access-control-allow-origin', '*');
    }
    res.setHeader('access-control-allow-headers', 'content-type, authorization, mcp-session-id');
    res.setHeader('access-control-expose-headers', 'mcp-session-id');
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Lightweight health probe — useful for Docker / load balancers.
    if (req.method === 'GET' && req.url === '/healthz') {
      send(res, 200, { ok: true, sessions: sessions.size });
      return;
    }

    // Strip query string before path match.
    const path = (req.url || '/').split('?')[0];
    if (path !== endpoint) {
      send(res, 404, { error: 'not found' });
      return;
    }

    if (bearer && !checkAuth(req, bearer)) {
      res.setHeader('www-authenticate', 'Bearer realm="synapse"');
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    void handleMcp(req, res, sessions, opts).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('http transport error', { error: msg });
      if (!res.headersSent) send(res, 500, { error: msg });
      else
        try {
          res.end();
        } catch {
          /* ignore */
        }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  // Read the actually-bound port (in case caller passed 0 to auto-allocate).
  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${boundPort}${endpoint}`;

  return {
    server: httpServer,
    url,
    async close() {
      // Close transports first so handleRequest() loops unwind cleanly.
      const all = Array.from(sessions.values());
      sessions.clear();
      await Promise.all(
        all.map(async (s) => {
          try {
            await s.transport.close();
          } catch {
            /* ignore */
          }
          try {
            s.synapse.close();
          } catch {
            /* ignore */
          }
        }),
      );
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

const MAX_BODY = 4 * 1024 * 1024; // 4 MB ceiling per JSON-RPC payload.
const MAX_SESSIONS = 100; // DoS guard: reject new sessions beyond this count.

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
  opts: HttpServerOptions,
): Promise<void> {
  const headerSession = req.headers['mcp-session-id'];
  const sessionId =
    typeof headerSession === 'string' ? headerSession : Array.isArray(headerSession) ? headerSession[0] : undefined;

  // GET (SSE stream) and DELETE (session terminate) — must reference an existing session.
  if (req.method === 'GET' || req.method === 'DELETE') {
    const sess = sessionId ? sessions.get(sessionId) : undefined;
    if (!sess) {
      send(res, 404, { error: 'session not found' });
      return;
    }
    await sess.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET,POST,DELETE,OPTIONS');
    send(res, 405, { error: 'method not allowed' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_BODY);
  } catch (err) {
    send(res, 400, { error: (err as Error).message });
    return;
  }

  let sess = sessionId ? sessions.get(sessionId) : undefined;
  if (!sess) {
    if (sessions.size >= MAX_SESSIONS) {
      send(res, 503, { error: 'session limit reached; try again later' });
      return;
    }
    sess = await createSession(sessions, opts);
  }
  await sess.transport.handleRequest(req, res, body);
}

async function createSession(
  sessions: Map<string, Session>,
  opts: HttpServerOptions,
): Promise<Session> {
  const synapse = createSynapseServer(opts.serverOptions);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      const entry: Session = { id, transport, synapse };
      sessions.set(id, entry);
      log.info('mcp session opened', { sessionId: id });
    },
  });
  transport.onclose = () => {
    const id = transport.sessionId;
    if (id && sessions.has(id)) {
      sessions.delete(id);
      log.info('mcp session closed', { sessionId: id });
    }
    try {
      synapse.close();
    } catch {
      /* ignore */
    }
  };
  await synapse.server.connect(transport);
  // Return a placeholder; the real entry is keyed in `onsessioninitialized`.
  return { id: '', transport, synapse };
}
