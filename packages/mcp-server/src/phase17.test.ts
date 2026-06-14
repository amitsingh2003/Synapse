import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, indexRepo, resolveReferences } from '@synapse/core';
import { startHttpServer, type HttpServerHandle } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'fixtures', 'sample-shopping-app');

let dbDir: string;
let dbPath: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'cg-phase17-'));
  dbPath = join(dbDir, 'graph.db');
  const db = openDatabase({ path: dbPath });
  await indexRepo(db, { root: FIXTURE, concurrency: 2 });
  resolveReferences(db, { root: FIXTURE });
  db.close();
});

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true });
});

/**
 * Minimal MCP-over-HTTP client: drives one Streamable HTTP session by
 * issuing JSON-RPC POSTs in `enableJsonResponse`-like (single-shot) form.
 * We accept either application/json bodies or text/event-stream replies
 * and pull out the first JSON-RPC payload either way.
 */
async function rpc(
  url: string,
  body: unknown,
  sessionId: string | null,
  token?: string,
): Promise<{ status: number; sessionId: string | null; payload: unknown; headers: Headers }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (token) headers['authorization'] = `Bearer ${token}`;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const newSession = r.headers.get('mcp-session-id');
  const ct = r.headers.get('content-type') ?? '';
  let payload: unknown = null;
  const text = await r.text();
  if (text.length > 0) {
    if (ct.includes('text/event-stream')) {
      // Parse the first `data: {...}` line.
      const line = text
        .split(/\r?\n/)
        .find((l) => l.startsWith('data:'));
      if (line) payload = JSON.parse(line.slice(5).trim());
    } else {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
  }
  return { status: r.status, sessionId: newSession, payload, headers: r.headers };
}

describe('Phase 17.1 — HTTP transport', () => {
  let http: HttpServerHandle;
  beforeAll(async () => {
    http = await startHttpServer({
      serverOptions: { dbPath, rootDir: FIXTURE },
      port: 0,
      host: '127.0.0.1',
    });
  });
  afterAll(async () => {
    await http.close();
  });

  it('serves a /healthz probe', async () => {
    const u = new URL(http.url);
    const r = await fetch(`http://${u.host}/healthz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('handles initialize → tools/list → tools/call over HTTP', async () => {
    // 1) initialize (no session header — server mints one)
    const init = await rpc(
      http.url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'phase17-test', version: '0.0.0' },
        },
      },
      null,
    );
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect(init.payload).toMatchObject({ jsonrpc: '2.0', id: 1 });
    const sid = init.sessionId!;

    // Send the required `notifications/initialized` notification.
    await rpc(
      http.url,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      sid,
    );

    // 2) tools/list
    const tools = await rpc(http.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid);
    expect(tools.status).toBe(200);
    const toolNames = (
      (tools.payload as { result: { tools: { name: string }[] } }).result.tools
    ).map((t) => t.name);
    expect(toolNames).toContain('find_symbol');
    expect(toolNames).toContain('search_symbols');

    // 3) tools/call find_symbol → Cart
    const call = await rpc(
      http.url,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'find_symbol', arguments: { name: 'Cart' } },
      },
      sid,
    );
    expect(call.status).toBe(200);
    const result = (call.payload as {
      result: { structuredContent?: { symbols: { name: string }[] } };
    }).result;
    expect(result.structuredContent?.symbols?.[0]?.name).toBe('Cart');
  });
});

describe('Phase 17.2 — bearer auth', () => {
  let http: HttpServerHandle;
  const SECRET = 'super-secret-token-XYZ';
  beforeAll(async () => {
    http = await startHttpServer({
      serverOptions: { dbPath, rootDir: FIXTURE },
      port: 0,
      host: '127.0.0.1',
      bearerToken: SECRET,
    });
  });
  afterAll(async () => {
    await http.close();
  });

  it('rejects requests without a bearer token', async () => {
    const r = await fetch(http.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects requests with a wrong bearer token', async () => {
    const init = await rpc(
      http.url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      null,
      'wrong-token',
    );
    expect(init.status).toBe(401);
  });

  it('accepts requests with the correct token', async () => {
    const init = await rpc(
      http.url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      null,
      SECRET,
    );
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
  });
});

describe('Phase 17.4 — --redact-paths', () => {
  it('replaces home directory and username in tool responses', async () => {
    const home = homedir();
    let user = '';
    try {
      user = userInfo().username;
    } catch {
      user = '';
    }
    // Only meaningful if the fixture path or DB path contains the home dir.
    // Index a synthetic fixture under tmp that includes the homedir literally
    // in a file path — fixture is already under tmpdir() which is usually
    // not under homedir, so we test via getStats which mentions dbPath in
    // index_status responses (or simpler: just verify the redactor doesn't
    // break normal responses, and that paths containing literal homedir get
    // stripped).
    const httpRedacted = await startHttpServer({
      serverOptions: { dbPath, rootDir: FIXTURE, redactPaths: true },
      port: 0,
      host: '127.0.0.1',
    });
    try {
      const init = await rpc(
        httpRedacted.url,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        },
        null,
      );
      const sid = init.sessionId!;
      await rpc(
        httpRedacted.url,
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        sid,
      );

      const statusResp = await rpc(
        httpRedacted.url,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'index_status', arguments: {} },
        },
        sid,
      );
      const text = JSON.stringify(statusResp.payload);
      // The serialized response must not contain a raw home dir or username.
      if (home) expect(text).not.toContain(home);
      if (user && user.length >= 3) {
        // username may legitimately appear as a substring of unrelated tokens,
        // so we only assert it doesn't appear as a standalone word.
        const re = new RegExp(`\\b${user.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`);
        expect(text).not.toMatch(re);
      }
    } finally {
      await httpRedacted.close();
    }
  }, 15000);
});

// (port auto-allocated by the OS when caller passes port: 0)
