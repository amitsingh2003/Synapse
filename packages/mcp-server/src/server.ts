import { homedir, userInfo } from 'node:os';
import type { Database as DB } from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openDatabase } from '@synapse/core';
import { log } from '@synapse/core';
import { preWarmParsers } from '@synapse/core';
import type { EmbeddingProvider } from '@synapse/core';
import {
  findSymbol,
  findReferences,
  getDefinition,
  searchSymbols,
  listSymbolsInFile,
  outgoingCalls,
  getStats,
  getSource,
  callHierarchy,
  findImports,
  indexStatus,
  reindexFile,
  listFiles,
  semanticSearchHandler,
  hybridSearchHandler,
  exploreSymbol,
  detectCycles,
  topSymbols,
  verifySymbol,
  readOffloaded,
  grepCode,
  structuralSearch,
  scanSecurity,
  gitLog,
  gitBlame,
  findDeadCode,
  codeMetrics,
} from './handlers.js';

export const MCP_SERVER_VERSION = '0.1.0';

export interface SynapseServerOptions {
  /** Absolute path to the SQLite graph DB. */
  dbPath: string;
  /** Repo root used to render paths relative in tool responses. */
  rootDir?: string;
  /** Optional sink for tool errors (defaults to stderr). */
  onError?: (toolName: string, err: Error) => void;
  /**
   * Phase 17.4 — replace the user's home directory with `~` and their OS
   * username with `<user>` in every tool response (text + structured) and
   * error message. Useful when sharing transcripts or running over HTTP.
   */
  redactPaths?: boolean;
  /**
   * Phase 18.1 — optional embedding provider for semantic_search. When null
   * (the default) the semantic_search tool gracefully reports unavailable.
   */
  embeddingProvider?: EmbeddingProvider | null;
}

export interface SynapseServer {
  server: McpServer;
  /** Closes the underlying DB handle. Does NOT disconnect transports. */
  close(): void;
}

interface ToolResult {
  [k: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Build a string redactor that strips the OS home directory and username
 * from any text. Cheap to call on every tool response — uses literal
 * `String.split().join()` rather than regex for the path replacement.
 */
function buildRedactor(): (s: string) => string {
  const home = homedir();
  const homeFwd = home.replace(/\\/g, '/');
  let username: string | null = null;
  try {
    username = userInfo().username || null;
  } catch {
    username = null;
  }
  const userRe =
    username && username.length >= 3
      ? new RegExp(`\\b${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
      : null;
  return (s) => {
    if (!s) return s;
    let out = s;
    if (home) out = out.split(home).join('~');
    if (homeFwd && homeFwd !== home) out = out.split(homeFwd).join('~');
    if (userRe) out = out.replace(userRe, '<user>');
    return out;
  };
}

/** Walk an arbitrary JSON-ish value, applying `redact` to every string leaf. */
function redactValue(value: unknown, redact: (s: string) => string): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, redact);
    }
    return out;
  }
  return value;
}

/**
 * Wrap a handler so any thrown error becomes a graceful tool response with
 * `isError: true` instead of tearing down the JSON-RPC connection.
 *
 * Phase 8: every tool callback flows through this.
 * Phase 17.4: optionally redact home dir / username from output.
 */
function _safe<Args>(
  toolName: string,
  fn: (args: Args) => unknown | Promise<unknown>,
  onError?: (toolName: string, err: Error) => void,
  redact?: (s: string) => string,
): (args: Args, extra: unknown) => Promise<ToolResult> {
  return async (args, _extra) => {
    void _extra;
    try {
      const result = await fn(args);
      const finalResult = redact ? redactValue(result, redact) : result;
      const text = JSON.stringify(finalResult, null, 2);
      return {
        content: [{ type: 'text', text }],
        structuredContent: finalResult as unknown as Record<string, unknown>,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (onError) {
        onError(toolName, e);
      } else {
        log.error(`${toolName} failed`, { tool: toolName, error: e.message });
      }
      const msg = redact ? redact(e.message) : e.message;
      // Phase 9: rely solely on MCP `isError` + plain text message.
      // Don't duplicate error info into structuredContent.
      return {
        content: [{ type: 'text', text: `[${toolName}] ${msg}` }],
        isError: true,
      };
    }
  };
}

/**
 * Build an McpServer wired to a synapse SQLite database.
 *
 * Tools registered:
 *   - find_symbol          — exact-name symbol lookup
 *   - find_references      — incoming edges (callers / importers) of a symbol
 *   - get_definition       — best-match definition for a name (+ alternatives)
 *   - search_symbols       — substring / wildcard name search with optional
 *                            kind / language / file_glob filters and a
 *                            Levenshtein "did you mean?" hint
 *   - list_symbols_in_file — every symbol defined in a single file
 *   - outgoing_calls       — what a symbol calls / imports / extends
 *   - get_stats            — repo-wide aggregate counts
 *   - get_source           — read a source slice + context lines (Phase 15.1)
 *   - call_hierarchy       — recursive incoming/outgoing tree (Phase 15.2)
 *   - find_imports         — files that import a given module (Phase 15.3)
 *   - index_status         — schema / freshness / drift (Phase 15.4)
 *   - reindex_file         — atomic single-file reindex (Phase 15.5)
 *
 * Resources registered (Phase 15.9):
 *   - synapse://stats    — JSON DbStats document
 *   - synapse://files    — newline-delimited file list
 *   - synapse://status   — JSON IndexStatusResult
 *
 * Every tool callback is wrapped so that thrown errors come back as
 * `isError: true` tool responses rather than killing the transport.
 */
export function createSynapseServer(opts: SynapseServerOptions): SynapseServer {
  const db: DB = openDatabase({ path: opts.dbPath, readonly: true });
  const rootDir = opts.rootDir;
  const onError = opts.onError;
  const redact = opts.redactPaths ? buildRedactor() : undefined;
  // Local shim so existing `safe(name, fn, onError)` call sites pick up the
  // optional redactor without each having to thread it explicitly.
  const safe = <A>(
    name: string,
    fn: (args: A) => unknown | Promise<unknown>,
    onErr?: (toolName: string, err: Error) => void,
  ) => _safe(name, fn, onErr, redact);

  // Phase 16.3 — kick off parser pre-warm in the background so the first
  // `reindex_file` call doesn't pay the WASM load latency. Fire-and-forget;
  // errors are surfaced via `onError` but never block server start.
  void preWarmParsers().catch((err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    if (onError) onError('preWarmParsers', e);
    else log.warn('parser pre-warm failed', { error: e.message });
  });

  const server = new McpServer(
    { name: 'synapse', version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'find_symbol',
    {
      title: 'Find symbol by name',
      description:
        'Look up symbols (functions, classes, types, variables, ...) defined in the indexed repo by exact name. Returns file:line locations and signatures.',
      inputSchema: {
        name: z.string().min(1).describe('Exact symbol name to look up.'),
        limit: z.number().int().min(1).max(200).optional()
          .describe('Maximum number of matches to return (default 25).'),
      },
    },
    safe(
      'find_symbol',
      (args: { name: string; limit?: number }) =>
        findSymbol(db, { name: args.name, limit: args.limit, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'find_references',
    {
      title: 'Find references to a symbol',
      description:
        'List every incoming reference (call, import, extends, implements, generic reference) for symbols matching the given name. Use this to answer "who uses X?".',
      inputSchema: {
        name: z.string().min(1).describe('Exact symbol name to look up.'),
        in_file: z.string().optional()
          .describe('Substring filter on the defining file path (e.g. "src/cart").'),
        limit: z.number().int().min(1).max(500).optional()
          .describe('Maximum number of references returned per symbol (default 50).'),
      },
    },
    safe(
      'find_references',
      (args: { name: string; in_file?: string; limit?: number }) =>
        findReferences(db, {
          name: args.name,
          inFile: args.in_file,
          limit: args.limit,
          rootDir,
        }),
      onError,
    ),
  );

  server.registerTool(
    'get_definition',
    {
      title: 'Get definition for a symbol',
      description:
        'Return the primary definition location (and any alternative matches) for a symbol name. Use this when the model needs the canonical site of a name before reading code.',
      inputSchema: {
        name: z.string().min(1).describe('Exact symbol name.'),
        in_file: z.string().optional()
          .describe('Optional substring filter on the defining file path.'),
      },
    },
    safe(
      'get_definition',
      (args: { name: string; in_file?: string }) =>
        getDefinition(db, { name: args.name, inFile: args.in_file, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'search_symbols',
    {
      title: 'Search symbols by substring (with filters)',
      description:
        'Substring (or wildcard) search across indexed symbol names. Use this when the exact name is unknown — e.g. "cart" matches Cart, CartService, addToCart. `*` is treated as a wildcard. Optional filters narrow by symbol `kind` (function/class/method/variable/...), `language` (typescript/python/go/...), and `file_glob` (e.g. "src/**/*.ts"). When no match is found, returns a Levenshtein-based "did you mean?" hint.\n\nWhen to use: discovery when you don\'t know the exact name.\nWhen NOT to use: if you already know the name, prefer `find_symbol` or `get_definition`.',
      inputSchema: {
        query: z.string().min(2).describe('Substring or pattern (min 2 chars). `*` is treated as a wildcard.'),
        limit: z.number().int().min(1).max(500).optional()
          .describe('Maximum number of matches (default 50).'),
        kind: z.string().optional()
          .describe('Restrict to one symbol kind (e.g. "function", "class", "method", "variable", "type").'),
        language: z.string().optional()
          .describe('Restrict to one language id (e.g. "typescript", "python", "go").'),
        file_glob: z.string().optional()
          .describe('Restrict by file path glob — only `*` wildcards (e.g. "src/**/*.ts").'),
      },
    },
    safe(
      'search_symbols',
      (args: { query: string; limit?: number; kind?: string; language?: string; file_glob?: string }) =>
        searchSymbols(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'list_symbols_in_file',
    {
      title: 'List symbols in a file',
      description:
        'Return every symbol defined in a single file (functions, classes, types, variables, ...). The path may be absolute or relative to the indexed repo root.',
      inputSchema: {
        file: z.string().min(1).describe('Absolute or repo-relative file path.'),
      },
    },
    safe(
      'list_symbols_in_file',
      (args: { file: string }) => listSymbolsInFile(db, { file: args.file, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'outgoing_calls',
    {
      title: 'Outgoing calls / references from a symbol',
      description:
        'List everything a symbol calls, imports, extends, or references. Inverse of `find_references`. Use this to answer "what does X depend on?".',
      inputSchema: {
        name: z.string().min(1).describe('Exact symbol name.'),
        in_file: z.string().optional()
          .describe('Optional substring filter on the defining file path.'),
        limit: z.number().int().min(1).max(500).optional()
          .describe('Maximum number of outgoing edges per symbol (default 100).'),
      },
    },
    safe(
      'outgoing_calls',
      (args: { name: string; in_file?: string; limit?: number }) =>
        outgoingCalls(db, {
          name: args.name,
          inFile: args.in_file,
          limit: args.limit,
          rootDir,
        }),
      onError,
    ),
  );

  server.registerTool(
    'get_stats',
    {
      title: 'Repository-wide graph statistics',
      description:
        'Return aggregate counts (files, symbols, edges), breakdowns by symbol/edge kind, and DB size. Useful as a sanity check before running heavier queries.',
      inputSchema: {},
    },
    safe('get_stats', () => getStats(db), onError),
  );

  // -------------------------------------------------------------------------
  // Phase 15 — additional tools
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_source',
    {
      title: 'Read source code by file + line range',
      description:
        'Read a slice of source code from disk for the given file + start_line..end_line, plus N lines of surrounding context (default 2). Use this after `get_definition` / `find_references` to inspect the actual code without leaving the MCP surface.\n\nExample chain: search_symbols("login") → get_definition("loginUser") → get_source(file, line) → call_hierarchy("loginUser").',
      inputSchema: {
        file: z.string().min(1).describe('Absolute or repo-relative file path.'),
        start_line: z.number().int().min(1).describe('1-based start line.'),
        end_line: z.number().int().min(1).optional().describe('1-based end line (defaults to start_line).'),
        context: z.number().int().min(0).max(20).optional()
          .describe('Lines of context before/after the range (default 2, max 20).'),
      },
    },
    safe(
      'get_source',
      (args: { file: string; start_line: number; end_line?: number; context?: number }) =>
        getSource(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'call_hierarchy',
    {
      title: 'Recursive call hierarchy (incoming or outgoing)',
      description:
        'BFS-traversal over the call graph starting at a named symbol. Direction "outgoing" returns what the symbol calls (and what those call, recursively); "incoming" returns callers transitively. Use this to answer "what runs when X is invoked?" or "who depends on X?" without chaining many `outgoing_calls` requests.',
      inputSchema: {
        name: z.string().min(1).describe('Exact symbol name to start from.'),
        direction: z.enum(['incoming', 'outgoing']).optional()
          .describe('"outgoing" (default) = callees; "incoming" = callers.'),
        depth: z.number().int().min(1).max(6).optional()
          .describe('Max traversal depth (default 3, max 6).'),
        fanout: z.number().int().min(1).max(100).optional()
          .describe('Max children per node (default 20).'),
      },
    },
    safe(
      'call_hierarchy',
      (args: { name: string; direction?: 'incoming' | 'outgoing'; depth?: number; fanout?: number }) =>
        callHierarchy(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'find_imports',
    {
      title: 'Find files that import a module',
      description:
        'List every file that imports the given module specifier (exact match, e.g. "react", "./utils/cart", "@synapse/core"). Returns the importing file, local + imported names, and whether the import is type-only.\n\nUse this when answering "who depends on this module?" or "where is X library used?".',
      inputSchema: {
        module: z.string().min(1).describe('Module specifier as written in the import statement.'),
        limit: z.number().int().min(1).max(500).optional()
          .describe('Maximum number of importers returned (default 100).'),
      },
    },
    safe(
      'find_imports',
      (args: { module: string; limit?: number }) =>
        findImports(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'index_status',
    {
      title: 'Health and freshness of the index',
      description:
        'Returns the schema version, repo root, file/symbol counts, last-indexed timestamp, current git HEAD (best-effort), and a coarse drift check (count of files whose on-disk mtime is newer than indexed_at). Use this BEFORE answering questions to confirm the index reflects current code.',
      inputSchema: {},
    },
    safe('index_status', () => indexStatus(db, { rootDir }), onError),
  );

  server.registerTool(
    'reindex_file',
    {
      title: 'Re-parse a single file and update the graph',
      description:
        'Re-parse one file and atomically rewrite its symbols + edges. Use this after editing a file so subsequent queries see the new state. Resolves cross-file references afterwards by default.\n\nRequires a writable database; if the server was started in read-only mode this tool returns ok=false.',
      inputSchema: {
        file: z.string().min(1).describe('Absolute or repo-relative file path to reindex.'),
        resolve: z.boolean().optional()
          .describe('Re-run cross-file reference resolution after indexing (default true).'),
      },
    },
    safe(
      'reindex_file',
      async (args: { file: string; resolve?: boolean }) => {
        // Open a separate read-write handle on demand. The primary `db` is readonly.
        const wdb = openDatabase({ path: opts.dbPath, readonly: false });
        try {
          return await reindexFile(wdb, { ...args, rootDir });
        } finally {
          wdb.close();
        }
      },
      onError,
    ),
  );

  // -------------------------------------------------------------------------
  // Phase 18 — Semantic search tools
  // -------------------------------------------------------------------------

  const embProvider = opts.embeddingProvider ?? null;

  server.registerTool(
    'semantic_search',
    {
      title: 'Semantic search over symbols (natural language)',
      description:
        'Find symbols by meaning, not by name substring. Uses dense vector embeddings to match ' +
        'queries like "function that validates email" even when no literal token matches.\n\n' +
        '**Setup required (one time):** run `synapse embed` after indexing. This downloads ' +
        'a ~23 MB local model (Transformers.js / all-MiniLM-L6-v2) — no API key or external ' +
        'server needed. Returns `available: false, totalEmbedded: 0` until that step is done.',
      inputSchema: {
        query: z.string().min(2).describe('Natural-language description of what you\'re looking for.'),
        k: z.number().int().min(1).max(100).optional()
          .describe('Max results (default 10).'),
        kind: z.string().optional()
          .describe('Restrict to a symbol kind (function, class, method, type, interface).'),
      },
    },
    safe(
      'semantic_search',
      (args: { query: string; k?: number; kind?: string }) =>
        semanticSearchHandler(db, embProvider, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'hybrid_search',
    {
      title: 'Hybrid search: exact + FTS + fuzzy + semantic',
      description:
        'Combined search that ranks results across up to four stages: exact name match, FTS5 ' +
        'trigram match, LIKE fuzzy match, and semantic cosine similarity. Each hit carries a ' +
        '`source` tag showing which stage produced it. Uses Reciprocal Rank Fusion (RRF) for ' +
        'cross-stage ranking.\n\n' +
        '**Important fallback behavior:** without embeddings (i.e. before running `synapse embed`), ' +
        'only the first three stages run — which search symbol *names* only, not code content. ' +
        'Natural-language queries like "authentication flow" will return 0 results unless a symbol ' +
        'is literally named that. Run `synapse embed` once to unlock full NL search. ' +
        'The `source` field on each hit tells you which stage matched.',
      inputSchema: {
        query: z.string().min(2).describe('Search term or natural-language query.'),
        k: z.number().int().min(1).max(100).optional()
          .describe('Max results (default 20).'),
        kind: z.string().optional()
          .describe('Restrict to one symbol kind.'),
        language: z.string().optional()
          .describe('Restrict to one language id.'),
        file_glob: z.string().optional()
          .describe('Restrict by file path glob.'),
      },
    },
    safe(
      'hybrid_search',
      (args: { query: string; k?: number; kind?: string; language?: string; file_glob?: string }) =>
        hybridSearchHandler(db, embProvider, { ...args, rootDir }),
      onError,
    ),
  );

  // -------------------------------------------------------------------------
  // Phase 23 — Advanced code-intelligence tools
  // -------------------------------------------------------------------------

  server.registerTool(
    'explore_symbol',
    {
      title: 'Deep-dive into a symbol (source + callers + callees)',
      description:
        'Single round-trip drill-down into a symbol. Returns the definition, source snippet ' +
        '(up to 60 lines), callers (incoming edges), callees (outgoing edges), and related ' +
        'imports from the file. Use this when you need full context about a symbol without ' +
        'chaining multiple tools.\n\nIdeal for answering "explain this function" or "how is ' +
        'this class used?".',
      inputSchema: {
        name: z.string().min(1).describe('Exact symbol name to explore.'),
        file: z.string().optional()
          .describe('Optional file path filter (substring match).'),
        max_callers: z.number().int().min(1).max(50).optional()
          .describe('Max callers to return (default 15).'),
        max_callees: z.number().int().min(1).max(50).optional()
          .describe('Max callees to return (default 15).'),
      },
    },
    safe(
      'explore_symbol',
      (args: { name: string; file?: string; max_callers?: number; max_callees?: number }) =>
        exploreSymbol(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'detect_cycles',
    {
      title: 'Find import cycles in the dependency graph',
      description:
        'Detects circular import dependencies using Tarjan\'s algorithm for strongly-connected ' +
        'components. Returns each cycle as a list of file paths. Use this to identify and ' +
        'break circular dependencies that cause initialization bugs or build issues.\n\n' +
        'Returns `hint` with "acyclic" message if no cycles exist.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
          .describe('Max cycles to return (default 20, largest first).'),
      },
    },
    safe(
      'detect_cycles',
      (args: { limit?: number }) => detectCycles(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'top_symbols',
    {
      title: 'Most-connected symbols (architectural hubs)',
      description:
        'Ranks symbols by connectivity (fan-in + fan-out). The highest-scoring symbols are ' +
        'architectural hubs: widely-called functions, heavily-imported types, or god-classes. ' +
        'Use this to quickly understand the most important parts of the codebase or to ' +
        'identify refactoring targets.\n\nScore = fan_in×2 + fan_out (being called matters more).',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
          .describe('Max results (default 20).'),
        kind: z.string().optional()
          .describe('Restrict to one symbol kind (function, class, method, type).'),
      },
    },
    safe(
      'top_symbols',
      (args: { limit?: number; kind?: string }) => topSymbols(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'verify_symbol',
    {
      title: 'Verify a symbol claim against the index (anti-hallucination)',
      description:
        'Checks whether a symbol (name, file, line, signature) actually exists in the graph. ' +
        'Returns a confidence score (0–1) and per-check breakdown. Use this to validate AI-generated ' +
        'code references before presenting them to users.\n\n' +
        'Confidence ≥ 0.6 = verified; < 0.6 = likely hallucination.',
      inputSchema: {
        name: z.string().min(1).describe('Symbol name to verify.'),
        file: z.string().optional()
          .describe('Expected file path (substring match).'),
        line: z.number().int().optional()
          .describe('Expected start line (±5 tolerance).'),
        signature: z.string().optional()
          .describe('Expected signature (substring match).'),
      },
    },
    safe(
      'verify_symbol',
      (args: { name: string; file?: string; line?: number; signature?: string }) =>
        verifySymbol(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'grep_code',
    {
      title: 'Search file contents by text pattern',
      description:
        'Search every indexed file for a text pattern (regex or fixed string) and return matching lines with context and the enclosing symbol (function/class).\n\n' +
        'Use this to answer questions like:\n' +
        '  • "Where is authentication implemented?" → grep "authenticate|verifyToken"\n' +
        '  • "Who checks permissions?" → grep "hasPermission|isAuthorized"\n' +
        '  • "Where is this env variable read?" → grep "process.env.DATABASE_URL"\n\n' +
        'Each match includes the enclosing function/class name so you can immediately\n' +
        'follow up with `explore_symbol` or `call_hierarchy` to trace connections.\n\n' +
        'When to use: when you know a keyword/pattern but not the symbol name.\n' +
        'When NOT to use: if you already know the symbol name — prefer `find_symbol`.',
      inputSchema: {
        pattern: z.string().min(1)
          .describe('Regex or fixed string to search for (e.g. "authenticate", "jwt\\.verify", "Bearer").'),
        fixed_string: z.boolean().optional()
          .describe('Treat pattern as a literal string, not a regex (default false).'),
        case_sensitive: z.boolean().optional()
          .describe('Case-sensitive match (default false — case-insensitive).'),
        file_glob: z.string().optional()
          .describe('Restrict to files matching this glob (e.g. "*.ts", "src/**/*.py", "auth*").'),
        context_lines: z.number().int().min(0).max(10).optional()
          .describe('Lines of context to include before and after each match (default 2).'),
        max_matches: z.number().int().min(1).max(200).optional()
          .describe('Maximum matches to return (default 50, max 200). Results are truncated with a hint when exceeded.'),
      },
    },
    safe(
      'grep_code',
      (args: {
        pattern: string;
        fixed_string?: boolean;
        case_sensitive?: boolean;
        file_glob?: string;
        context_lines?: number;
        max_matches?: number;
      }) => grepCode(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'structural_search',
    {
      title: 'Structural code search (ast-grep patterns)',
      description:
        'Search for structural code patterns using AST-aware matching (ast-grep). Unlike regex grep, ' +
        'this understands code structure — e.g. `console.log($ARGS)` matches any console.log call ' +
        'regardless of formatting, and `function $NAME($$$) { $$$ }` matches any function.\n\n' +
        'Requires @ast-grep/napi to be installed (pnpm add @ast-grep/napi in the mcp-server package).\n\n' +
        'Examples:\n' +
        '  • Find all console.log calls: pattern="console.log($ARGS)" language="typescript"\n' +
        '  • Find async functions: pattern="async function $NAME($$$) { $$$ }" language="typescript"\n' +
        '  • Find try-catch blocks: pattern="try { $$$ } catch ($E) { $$$ }" language="javascript"',
      inputSchema: {
        pattern: z.string().min(1)
          .describe('AST-grep pattern to search for. Use $VAR for single-node capture, $$$ for multi-node.'),
        language: z.string().min(1)
          .describe('Language to parse as: typescript, javascript, python, go, rust, java, c, cpp'),
        file_glob: z.string().optional()
          .describe('Restrict to files matching this glob (e.g. "*.ts", "src/**/*.py").'),
        max_matches: z.number().int().min(1).max(200).optional()
          .describe('Maximum matches to return (default 50, max 200).'),
      },
    },
    safe(
      'structural_search',
      (args: { pattern: string; language: string; file_glob?: string; max_matches?: number }) =>
        structuralSearch(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'scan_security',
    {
      title: 'Security scan with semgrep',
      description:
        'Run semgrep static analysis over the indexed codebase and return security findings.\n\n' +
        'Requires semgrep to be installed: `pip install semgrep`\n\n' +
        'Configs:\n' +
        '  • "auto" (default) — automatically selects rules for the detected languages\n' +
        '  • "p/owasp-top-ten" — OWASP Top 10 vulnerabilities\n' +
        '  • "p/secrets" — hardcoded secrets and credentials\n' +
        '  • "p/javascript" — JS/TS-specific rules\n' +
        '  • "p/python" — Python-specific rules\n\n' +
        'Each finding includes the rule ID, file location, severity, and a descriptive message.',
      inputSchema: {
        config: z.string().optional()
          .describe('Semgrep config/ruleset (default "auto"). Examples: "p/owasp-top-ten", "p/secrets".'),
        file_glob: z.string().optional()
          .describe('Restrict scan to files matching this glob (e.g. "src/**/*.py").'),
        max_findings: z.number().int().min(1).max(500).optional()
          .describe('Maximum findings to return (default 100, max 500).'),
      },
    },
    safe(
      'scan_security',
      (args: { config?: string; file_glob?: string; max_findings?: number }) =>
        scanSecurity(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'git_log',
    {
      title: 'Git commit history for a file',
      description:
        'Show the git commit history for a specific file — who changed it, when, and why.\n\n' +
        'Requires the project to be in a git repository.\n\n' +
        'Useful for understanding:\n' +
        '  • Why a file looks the way it does (recent commits)\n' +
        '  • Who is the expert on a file (most frequent committer)\n' +
        '  • When a specific feature was introduced (by message search)\n\n' +
        'Follow up with `git_blame` to see which commit introduced a specific line.',
      inputSchema: {
        file: z.string().min(1)
          .describe('Repo-relative path to the file (e.g. "src/auth.ts").'),
        max_commits: z.number().int().min(1).max(100).optional()
          .describe('Maximum number of commits to return (default 20, max 100).'),
      },
    },
    safe(
      'git_log',
      (args: { file: string; max_commits?: number }) => gitLog(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'git_blame',
    {
      title: 'Git blame — line-level authorship',
      description:
        'Show who wrote each line of a file (or a line range), which commit introduced it, ' +
        'and the commit summary.\n\n' +
        'Requires the project to be in a git repository.\n\n' +
        'Useful for:\n' +
        '  • Understanding the context behind a specific line of code\n' +
        '  • Finding who to ask about a piece of logic\n' +
        '  • Tracing when a bug was introduced\n\n' +
        'Tip: combine with `grep_code` to find the line first, then blame it for authorship.',
      inputSchema: {
        file: z.string().min(1)
          .describe('Repo-relative path to the file (e.g. "src/auth.ts").'),
        start_line: z.number().int().min(1).optional()
          .describe('First line to blame (1-based, default: start of file).'),
        end_line: z.number().int().min(1).optional()
          .describe('Last line to blame (1-based, default: end of file). Pairs with start_line.'),
      },
    },
    safe(
      'git_blame',
      (args: { file: string; start_line?: number; end_line?: number }) =>
        gitBlame(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'find_dead_code',
    {
      title: 'Find unreferenced symbols (dead code)',
      description:
        'Find functions, methods, and classes that have NO callers or references within the indexed codebase.\n\n' +
        'A symbol is "dead" if no edge in the call graph points to it. This catches:\n' +
        '  • Orphaned utility functions nobody calls\n' +
        '  • Removed features whose implementation was left behind\n' +
        '  • Internal helpers superseded by newer code\n\n' +
        'Note: symbols called only from tests, or from code outside the indexed root, ' +
        'will also appear here. Review results before deleting.\n\n' +
        'Tip: pipe results into `explore_symbol` to verify a symbol is truly unreachable.',
      inputSchema: {
        kinds: z.array(z.string()).optional()
          .describe('Symbol kinds to check (default ["function","method","class"]). Options: function, method, class, interface, type.'),
        file_glob: z.string().optional()
          .describe('Restrict to files matching this glob (e.g. "src/**/*.ts").'),
        limit: z.number().int().min(1).max(200).optional()
          .describe('Maximum results to return (default 50).'),
      },
    },
    safe(
      'find_dead_code',
      (args: { kinds?: string[]; file_glob?: string; limit?: number }) =>
        findDeadCode(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'code_metrics',
    {
      title: 'Code complexity metrics per file',
      description:
        'Return per-file code complexity metrics derived from the symbol graph:\n' +
        '  • functions / classes count\n' +
        '  • avg_fn_lines / max_fn_lines — average and maximum function body length\n' +
        '  • total_edges_in — how many calls/references point into this file (coupling indicator)\n\n' +
        'Sort modes:\n' +
        '  • "max_fn_lines" (default) — files with the longest functions first (complexity hotspots)\n' +
        '  • "functions" — files with the most functions\n' +
        '  • "total_edges_in" — most-depended-upon files (high coupling)\n' +
        '  • "avg_fn_lines" — files with the highest average function length\n\n' +
        'Use this to identify refactoring candidates and architectural hotspots.',
      inputSchema: {
        file_glob: z.string().optional()
          .describe('Restrict to files matching this glob (e.g. "src/**/*.ts").'),
        top_n: z.number().int().min(1).max(100).optional()
          .describe('Number of files to return (default 20, max 100).'),
        sort_by: z.enum(['max_fn_lines', 'functions', 'total_edges_in', 'avg_fn_lines']).optional()
          .describe('Sort order (default "max_fn_lines").'),
      },
    },
    safe(
      'code_metrics',
      (args: { file_glob?: string; top_n?: number; sort_by?: string }) =>
        codeMetrics(db, { ...args, rootDir }),
      onError,
    ),
  );

  server.registerTool(
    'read_offloaded',
    {
      title: 'Retrieve an offloaded large result by token',
      description:
        'When a tool response exceeds 8 KB, it is automatically offloaded to a temp file ' +
        'and a compact pointer (token + preview) is returned instead. Call this tool with ' +
        'the token to retrieve the full payload.\n\nTokens expire when the server restarts.',
      inputSchema: {
        token: z.string().min(1).describe('The offload token returned by another tool.'),
      },
    },
    safe('read_offloaded', (args: { token: string }) => readOffloaded(args), onError),
  );

  // -------------------------------------------------------------------------
  // Phase 15.9 — MCP resources (read-only views over the graph)
  // -------------------------------------------------------------------------

  server.registerResource(
    'synapse-stats',
    'synapse://stats',
    {
      title: 'Synapse statistics',
      description: 'JSON document with repo-wide counts and DB size.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(getStats(db), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'synapse-files',
    'synapse://files',
    {
      title: 'Indexed files',
      description: 'Newline-delimited list of every file path in the index.',
      mimeType: 'text/plain',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/plain',
          text: listFiles(db, rootDir).files.join('\n'),
        },
      ],
    }),
  );

  server.registerResource(
    'synapse-status',
    'synapse://status',
    {
      title: 'Index status',
      description: 'Schema version, file/symbol counts, last-indexed time, drift hint.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(indexStatus(db, { rootDir }), null, 2),
        },
      ],
    }),
  );

  return {
    server,
    close: () => db.close(),
  };
}
