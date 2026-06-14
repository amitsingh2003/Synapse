#!/usr/bin/env node
/**
 * `synapse-mcp` — MCP server entry point.
 *
 * Transports:
 *   stdio (default)             — newline-delimited JSON-RPC on stdio
 *   http                        — Phase 17.1, Streamable HTTP / SSE
 *
 * Usage:
 *   synapse-mcp [--db <path>] [--root <repoRoot>] [--redact-paths]
 *   synapse-mcp --transport http [--port 4000] [--host 127.0.0.1]
 *                                  [--token <bearer>]
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSynapseServer, MCP_SERVER_VERSION } from './server.js';
import { startHttpServer, type HttpServerHandle } from './httpTransport.js';
import {
  startAutoSync,
  type AutoSyncHandle,
  TransformersEmbeddingProvider,
  type EmbeddingProvider,
} from '@synapse/core';

interface CliOptions {
  dbPath: string;
  rootDir?: string;
  redactPaths: boolean;
  transport: 'stdio' | 'http';
  port: number;
  host: string;
  token?: string;
}

const HELP =
  'synapse-mcp [options]\n' +
  '\n' +
  'Options:\n' +
  '  --db <path>            SQLite graph DB (default ./.synapse/graph.db)\n' +
  '  --root <dir>           Repo root for path relativization in responses\n' +
  '  --redact-paths         Replace home dir / username in tool output (Phase 17.4)\n' +
  '\n' +
  '  --transport <t>        "stdio" (default) or "http" (Phase 17.1)\n' +
  '  --port <n>             HTTP port (default 4000)\n' +
  '  --host <addr>          HTTP bind address (default 127.0.0.1)\n' +
  '  --token <secret>       Require Authorization: Bearer <secret> (Phase 17.2)\n' +
  '\n' +
  '  --version, -v          Print version\n' +
  '  --help, -h             Print this help\n';

function parseArgs(argv: string[]): CliOptions {
  let dbPath: string | undefined;
  let rootDir: string | undefined;
  let redactPaths = false;
  let transport: 'stdio' | 'http' = 'stdio';
  let port = 4000;
  let host = '127.0.0.1';
  let token: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`flag ${a} requires a value`);
      i++;
      return v;
    };
    switch (a) {
      case '--db':
        dbPath = resolve(next());
        break;
      case '--root':
        rootDir = resolve(next());
        break;
      case '--redact-paths':
        redactPaths = true;
        break;
      case '--transport': {
        const t = next().toLowerCase();
        if (t !== 'stdio' && t !== 'http') {
          throw new Error(`invalid --transport: ${t} (expected stdio|http)`);
        }
        transport = t;
        break;
      }
      case '--port': {
        const v = Number(next());
        if (!Number.isInteger(v) || v < 1 || v > 65535) {
          throw new Error('--port must be 1..65535');
        }
        port = v;
        break;
      }
      case '--host':
        host = next();
        break;
      case '--token':
        token = next();
        break;
      case '--version':
      case '-v':
        process.stdout.write(MCP_SERVER_VERSION + '\n');
        process.exit(0);
        break;
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  if (!dbPath) dbPath = resolve(process.cwd(), '.synapse', 'graph.db');
  return { dbPath, rootDir, redactPaths, transport, port, host, token };
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`synapse-mcp: ${(err as Error).message}\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }
  if (!existsSync(opts.dbPath)) {
    process.stderr.write(
      `synapse-mcp: DB not found at ${opts.dbPath}\n` +
        `Run \`synapse init\` first, or pass --db <path>.\n`,
    );
    process.exit(2);
  }

  // Auto-detect embeddings: if the DB has a populated embeddings table, wire up
  // TransformersEmbeddingProvider so semantic_search works out-of-the-box without
  // any extra CLI flags. The model pipeline is lazy-loaded on first query.
  // Open raw (no synapse pragmas / migrations) to avoid write-pragma errors on
  // what is effectively a read-only probe.
  let embeddingProvider: EmbeddingProvider | null = null;
  try {
    const checkDb = new Database(opts.dbPath, { readonly: true });
    try {
      const tableRow = checkDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_embeddings'")
        .get() as { name: string } | undefined;
      if (tableRow) {
        const row = checkDb
          .prepare('SELECT COUNT(*) AS n FROM symbol_embeddings')
          .get() as { n: number };
        if (row.n > 0) {
          embeddingProvider = new TransformersEmbeddingProvider();
          process.stderr.write(
            `synapse-mcp: ${row.n} embeddings detected — semantic search enabled (Transformers.js)\n`,
          );
        } else {
          process.stderr.write(
            `synapse-mcp: embeddings table empty — run \`synapse embed\` to enable semantic search\n`,
          );
        }
      } else {
        process.stderr.write(
          `synapse-mcp: no embeddings found — run \`synapse embed\` to enable semantic search\n`,
        );
      }
    } finally {
      checkDb.close();
    }
  } catch (err) {
    process.stderr.write(
      `synapse-mcp: embedding detection failed (${(err as Error).message}) — semantic search disabled\n`,
    );
  }

  // Start background auto-sync (fire-and-forget — never blocks server startup).
  // Acquires watcher.lock so only one MCP instance watches per repo.
  let autoSync: AutoSyncHandle | null = null;
  void startAutoSync({ dbPath: opts.dbPath })
    .then((h) => { autoSync = h; })
    .catch(() => { /* logged inside startAutoSync */ });

  if (opts.transport === 'http') {
    let http: HttpServerHandle;
    try {
      http = await startHttpServer({
        serverOptions: {
          dbPath: opts.dbPath,
          rootDir: opts.rootDir,
          redactPaths: opts.redactPaths,
          embeddingProvider,
        },
        port: opts.port,
        host: opts.host,
        bearerToken: opts.token,
      });
    } catch (err) {
      process.stderr.write(`synapse-mcp: failed to start HTTP server: ${(err as Error).message}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `synapse-mcp listening on ${http.url}` +
        (opts.token ? ' (bearer auth required)' : ' (no auth)') +
        '\n',
    );

    const shutdown = (): void => {
      void autoSync?.close().catch(() => undefined);
      void http
        .close()
        .catch(() => undefined)
        .finally(() => hardExit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  // Default: stdio transport — one session, this process's stdin/stdout.
  const handle = createSynapseServer({
    dbPath: opts.dbPath,
    rootDir: opts.rootDir,
    redactPaths: opts.redactPaths,
    embeddingProvider,
  });
  const transport = new StdioServerTransport();
  await handle.server.connect(transport);

  const shutdown = (): void => {
    void autoSync?.close().catch(() => undefined);
    try {
      handle.close();
    } catch {
      /* ignore */
    }
    hardExit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`synapse-mcp: fatal: ${(err as Error).message}\n`);
  hardExit(1);
});

/**
 * Exit the process without running V8/libuv finalisers.
 *
 * Background: web-tree-sitter's emscripten module keeps libuv async handles
 * alive after we're done with it. On Node 22+ (especially Node 25 on Windows)
 * the normal `process.exit()` shutdown trips `UV_HANDLE_CLOSING` asserts.
 * We silence stderr just before exit so the user never sees the cosmetic
 * noise, then fall through to `process.exit`.
 */
function hardExit(code: number): never {
  try {
    process.stderr.write('', () => {
      (process.stderr.write as (chunk: unknown) => boolean) = () => true;
      process.exit(code);
    });
  } catch {
    process.exit(code);
  }
  setImmediate(() => process.exit(code));
  return undefined as never;
}
