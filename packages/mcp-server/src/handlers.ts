import { relative, isAbsolute, resolve as pathResolve, dirname, join } from 'node:path';
import type { parse as SgParse, Lang as SgLang } from '@ast-grep/napi';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import {
  Queries,
  collectStats,
  indexFile,
  resolveReferences,
  getManifestValue,
  groupByTier,
  type SymbolRow,
  type IncomingEdge,
  type OutgoingEdge,
  type DbStats,
  type IndexTier,
} from '@synapse/core';

/**
 * Pure handler functions used by both the MCP tool wrappers and the unit
 * tests. They operate directly on an open SQLite DB so they can be invoked
 * without spinning up the JSON-RPC transport.
 *
 * All `file` fields are returned as paths RELATIVE to `rootDir` when
 * provided, otherwise as the absolute paths stored in the DB.
 */

export interface SymbolHit {
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line: number;
  signature: string | null;
}

export interface ReferenceHit {
  kind: string;
  file: string;
  line: number;
  col: number;
  from: { name: string; kind: string } | null;
}

export interface ReferencesForSymbol {
  symbol: SymbolHit;
  references: ReferenceHit[];
  truncated: boolean;
}

export interface DefinitionResult {
  found: boolean;
  symbol?: SymbolHit & { doc: string | null };
  /** Other candidates when more than one symbol matched the name. */
  alternatives?: SymbolHit[];
  /** Phase 9: hint when not found. */
  hint?: string;
}

function fmtPath(p: string, rootDir?: string): string {
  // Phase 10: files.path is already repo-relative with forward slashes.
  // Phase 15: also accept absolute paths (e.g. from get_source) and
  // relativize them against rootDir for a consistent output shape.
  if (rootDir && isAbsolute(p)) {
    const rel = relative(rootDir, p).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..')) return rel;
  }
  return p;
}

function toHit(row: SymbolRow & { file_path: string }, rootDir?: string): SymbolHit {
  return {
    name: row.name,
    kind: row.kind,
    file: fmtPath(row.file_path, rootDir),
    line: row.start_line,
    end_line: row.end_line,
    signature: row.signature ?? null,
  };
}

function toRef(e: IncomingEdge, rootDir?: string): ReferenceHit {
  return {
    kind: e.kind,
    file: fmtPath(e.file_path, rootDir),
    line: e.line,
    col: e.col,
    from: e.source_name
      ? { name: e.source_name, kind: e.source_kind ?? 'unknown' }
      : null,
  };
}

export function findSymbol(
  db: DB,
  args: { name: string; limit?: number; rootDir?: string },
): { symbols: SymbolHit[]; total: number; hint?: string } {
  const q = new Queries(db);
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
  const rows = q.searchByName(args.name, limit);
  if (rows.length === 0) {
    // Phase 9: help the LLM understand why nothing was found
    const fuzzy = q.searchByNameLike(`%${escapeLike(args.name)}%`, 5);
    if (fuzzy.length > 0) {
      return {
        symbols: [],
        total: 0,
        hint: `No exact match for "${args.name}". Did you mean: ${fuzzy.map((r) => r.name).join(', ')}?`,
      };
    }
    return { symbols: [], total: 0, hint: `No symbol named "${args.name}" in the index.` };
  }
  return { symbols: rows.map((r) => toHit(r, args.rootDir)), total: rows.length };
}

export function findReferences(
  db: DB,
  args: { name: string; inFile?: string; limit?: number; rootDir?: string },
): { results: ReferencesForSymbol[] } {
  const q = new Queries(db);
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
  let symbols = q.searchByName(args.name, 25);
  if (args.inFile) {
    const needle = args.inFile;
    symbols = symbols.filter((s) => s.file_path.includes(needle));
  }
  const results: ReferencesForSymbol[] = symbols.map((sym) => {
    const edges = q.incomingEdges(sym.id);
    const truncated = edges.length > limit;
    return {
      symbol: toHit(sym, args.rootDir),
      references: edges.slice(0, limit).map((e) => toRef(e, args.rootDir)),
      truncated,
    };
  });
  return { results };
}

export function getDefinition(
  db: DB,
  args: { name: string; inFile?: string; rootDir?: string },
): DefinitionResult {
  const q = new Queries(db);
  let symbols = q.searchByName(args.name, 10);
  if (args.inFile) {
    const needle = args.inFile;
    symbols = symbols.filter((s) => s.file_path.includes(needle));
  }
  if (symbols.length === 0) {
    const fuzzy = q.searchByNameLike(`%${escapeLike(args.name)}%`, 5);
    const hint = fuzzy.length > 0
      ? `No exact match for "${args.name}". Did you mean: ${fuzzy.map((r) => r.name).join(', ')}?`
      : `No symbol named "${args.name}" in the index.`;
    return { found: false, hint };
  }
  const [primary, ...rest] = symbols;
  return {
    found: true,
    symbol: {
      ...toHit(primary!, args.rootDir),
      doc: primary!.doc ?? null,
    },
    alternatives: rest.length > 0 ? rest.map((r) => toHit(r, args.rootDir)) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Phase 7 — expanded tool surface
// ---------------------------------------------------------------------------

export interface OutgoingCall {
  kind: string;
  line: number;
  col: number;
  /** The local source name that the parser captured for this edge. */
  to_name: string | null;
  /** Resolved target (if Phase 3 linked it to a definition). */
  resolved: {
    name: string;
    kind: string;
    file: string;
    line: number;
  } | null;
}

export interface OutgoingCallsResult {
  symbol: SymbolHit;
  outgoing: OutgoingCall[];
  truncated: boolean;
}

export interface FileSymbolsResult {
  file: string;
  found: boolean;
  language?: string;
  symbols: SymbolHit[];
  /** Phase 9: hint when file not found. */
  hint?: string;
}

/**
 * Escape SQL LIKE meta-characters so user input can't accidentally wildcard.
 * Uses `\` as the ESCAPE char (passed to queries layer).
 */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Substring search across symbol names. Wraps `searchByNameLike` with `%`
 * wildcards so callers can pass plain text. Use `*` as an explicit wildcard.
 *
 * Phase 9: user-supplied `%` and `_` are escaped before reaching SQL.
 * Minimum query length is 2 to prevent degenerate full-table scans.
 */
export function searchSymbols(
  db: DB,
  args: {
    query: string;
    limit?: number;
    rootDir?: string;
    /** Phase 15.6 — restrict to a single SymbolKind (e.g. 'function'). */
    kind?: string;
    /** Phase 15.6 — restrict to a single language id (e.g. 'typescript'). */
    language?: string;
    /** Phase 15.6 — restrict by file-path glob (e.g. 'src/**\/*.ts'). */
    file_glob?: string;
  },
): { symbols: SymbolHit[]; total: number; hint?: string } {
  if (args.query.length < 2) {
    return { symbols: [], total: 0, hint: 'Query must be at least 2 characters.' };
  }
  const q = new Queries(db);
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
  // Map user `*` wildcards to SQL `%` AFTER escaping other metas.
  const escaped = escapeLike(args.query.replace(/\*/g, '\x00'))
    .replace(/\x00/g, '%');
  const pattern = escaped.includes('%') ? escaped : `%${escaped}%`;
  // Phase 16.1 — when the query is a plain alphanumeric substring of length
  // ≥ 3 with no SQL wildcards, anchor the search on the FTS5 trigram
  // index. The LIKE clause still runs as a refinement.
  const isPlain = /^[\p{L}\p{N}_]{3,}$/u.test(args.query) && !args.query.includes('*');
  const rows = q.searchByNameFiltered(pattern, {
    kind: args.kind,
    language: args.language,
    fileGlob: args.file_glob,
    limit,
    ftsTerm: isPlain ? args.query : null,
  });
  if (rows.length === 0) {
    // When the user wrote "auth*" (trailing wildcard only), the SQL pattern is
    // "auth%" — a prefix match that won't find "checkAuth". Offer actionable hint.
    if (args.query.includes('*') && !args.query.startsWith('*')) {
      const bare = args.query.replace(/\*/g, '');
      return {
        symbols: [],
        total: 0,
        hint: `No symbol starts with "${bare}". The * wildcard anchors to that position — use "*${bare}*" for a contains-anywhere search, or just "${bare}" (no wildcard) for the default substring match.`,
      };
    }
    // Phase 15.7 — "did you mean?" fuzzy fallback using Levenshtein.
    const suggestions = fuzzySuggest(db, args.query, 5);
    if (suggestions.length > 0) {
      return {
        symbols: [],
        total: 0,
        hint: `No symbol matches "${args.query}". Did you mean: ${suggestions.join(', ')}?`,
      };
    }
  }
  return { symbols: rows.map((r) => toHit(r, args.rootDir)), total: rows.length };
}

/**
 * List every symbol defined in a single file. Accepts either an absolute path
 * or a path relative to `rootDir`.
 */
export function listSymbolsInFile(
  db: DB,
  args: { file: string; rootDir?: string },
): FileSymbolsResult {
  const q = new Queries(db);
  const candidates = candidatePaths(args.file, args.rootDir);
  let fileRow: ReturnType<typeof q.fileByPath> | undefined;
  for (const c of candidates) {
    fileRow = q.fileByPath(c);
    if (fileRow) break;
  }
  if (!fileRow) {
    return {
      file: args.file,
      found: false,
      symbols: [],
      hint: `File "${args.file}" is not in the index. It may not have been discovered, or has an unsupported language.`,
    };
  }
  const rows = q.symbolsInFileWithPath(fileRow.id);
  return {
    file: fmtPath(fileRow.path, args.rootDir),
    found: true,
    language: fileRow.language,
    symbols: rows.map((r) => toHit(r, args.rootDir)),
  };
}

/** Outgoing edges (calls, imports, extends, references) from a symbol. */
export function outgoingCalls(
  db: DB,
  args: { name: string; inFile?: string; limit?: number; rootDir?: string },
): { results: OutgoingCallsResult[] } {
  const q = new Queries(db);
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  let symbols = q.searchByName(args.name, 25);
  if (args.inFile) {
    const needle = args.inFile;
    symbols = symbols.filter((s) => s.file_path.includes(needle));
  }
  const results: OutgoingCallsResult[] = symbols.map((sym) => {
    const edges = q.outgoingEdges(sym.id);
    const truncated = edges.length > limit;
    return {
      symbol: toHit(sym, args.rootDir),
      outgoing: edges.slice(0, limit).map((e) => toOutgoing(e, args.rootDir)),
      truncated,
    };
  });
  return { results };
}

/** Repo-wide statistics (file/symbol/edge counts, breakdowns, DB size). */
export function getStats(db: DB): DbStats {
  return collectStats(db);
}

function toOutgoing(e: OutgoingEdge, rootDir?: string): OutgoingCall {
  return {
    kind: e.kind,
    line: e.line,
    col: e.col,
    to_name: e.target_name ?? e.target_resolved_name ?? null,
    resolved:
      e.target_id && e.target_resolved_name && e.target_file_path
        ? {
            name: e.target_resolved_name,
            kind: e.target_kind ?? 'unknown',
            file: fmtPath(e.target_file_path, rootDir),
            line: e.target_line ?? 0,
          }
        : null,
  };
}

/**
 * Phase 10: files.path is repo-relative with forward slashes. Convert
 * whatever the user provides (absolute, backslash, etc.) into the canonical form.
 */
function candidatePaths(input: string, rootDir?: string): string[] {
  const out: string[] = [];
  // Normalize to forward slashes first
  const fwd = input.replace(/\\/g, '/');
  if (isAbsolute(input) && rootDir) {
    // Strip rootDir prefix to get relative
    const rel = relative(rootDir, input).replace(/\\/g, '/');
    out.push(rel);
  }
  out.push(fwd);
  // If input looks like a relative path already, add as-is
  if (!isAbsolute(input)) out.push(fwd);
  return Array.from(new Set(out));
}

// ===========================================================================
// Phase 15 — Missing tools & MCP resources
// ===========================================================================

// ---------- 15.7: fuzzy suggestions (Levenshtein) --------------------------

/**
 * Cheap Damerau-style Levenshtein (bounded). Used by the `did you mean?` hint.
 * Iterative DP with two rolling rows — small enough for the ≤ 256 candidate
 * names we sample per query.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  let prev = new Array<number>(bl.length + 1);
  let curr = new Array<number>(bl.length + 1);
  for (let j = 0; j <= bl.length; j++) prev[j] = j;
  for (let i = 1; i <= al.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl.length; j++) {
      const cost = al.charCodeAt(i - 1) === bl.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl.length]!;
}

/**
 * Return up to `limit` symbol names ranked by edit distance to `query`.
 * Samples the symbol table (LIMIT 2000) to keep this O(N·M) for tiny M.
 */
function fuzzySuggest(db: DB, query: string, limit: number): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT name FROM symbols LIMIT 2000`)
    .all() as { name: string }[];
  const maxDist = Math.max(2, Math.floor(query.length / 3));
  const scored = rows
    .map((r) => ({ name: r.name, d: levenshtein(query, r.name) }))
    .filter((s) => s.d <= maxDist)
    .sort((a, b) => a.d - b.d || a.name.length - b.name.length)
    .slice(0, limit);
  // Deduplicate while preserving rank.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scored) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      out.push(s.name);
    }
  }
  return out;
}

// ---------- 15.1: get_source ----------------------------------------------

export interface SourceLine {
  number: number;
  text: string;
}

export interface GetSourceResult {
  found: boolean;
  file?: string;
  start_line?: number;
  end_line?: number;
  context_before?: number;
  context_after?: number;
  lines?: SourceLine[];
  hint?: string;
}

/**
 * Read a slice of source from disk — given file + line range + optional
 * context. Files are resolved relative to `rootDir` (or absolute). The
 * MCP server is sandboxed to `rootDir`: paths that escape via `..` are
 * rejected to avoid arbitrary file reads.
 */
export function getSource(
  _db: DB,
  args: {
    file: string;
    start_line: number;
    end_line?: number;
    context?: number;
    rootDir?: string;
  },
): GetSourceResult {
  const start = Math.max(1, Math.floor(args.start_line));
  const end = Math.max(start, Math.floor(args.end_line ?? start));
  const context = Math.max(0, Math.min(20, Math.floor(args.context ?? 2)));

  const candidates: string[] = [];
  const fwd = args.file.replace(/\\/g, '/');
  if (isAbsolute(args.file)) candidates.push(args.file);
  if (args.rootDir) candidates.push(pathResolve(args.rootDir, fwd));
  candidates.push(pathResolve(fwd));

  let abs: string | null = null;
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      abs = c;
      break;
    }
  }
  if (!abs) {
    return { found: false, hint: `File not found on disk: ${args.file}` };
  }
  const guardDir = args.rootDir ?? process.cwd();
  const rel = relative(guardDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { found: false, hint: 'Path escapes project root; refusing to read.' };
  }

  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    return { found: false, hint: `Read error: ${(err as Error).message}` };
  }
  const all = text.split(/\r?\n/);
  const from = Math.max(1, start - context);
  const to = Math.min(all.length, end + context);
  const lines: SourceLine[] = [];
  for (let i = from; i <= to; i++) {
    lines.push({ number: i, text: all[i - 1] ?? '' });
  }
  return {
    found: true,
    file: fmtPath(abs.replace(/\\/g, '/'), args.rootDir),
    start_line: start,
    end_line: end,
    context_before: start - from,
    context_after: to - end,
    lines,
  };
}

// ---------- 15.2: call_hierarchy ------------------------------------------

export type CallDirection = 'incoming' | 'outgoing';

export interface CallHierarchyNode {
  symbol: SymbolHit;
  depth: number;
  edge_kind?: string;
  edge_line?: number;
  children: CallHierarchyNode[];
  truncated?: boolean;
}

export interface CallHierarchyResult {
  query: string;
  direction: CallDirection;
  max_depth: number;
  roots: CallHierarchyNode[];
  /** True when any node in the tree was cut off by the depth or fanout limit. */
  truncated?: boolean;
  hint?: string;
}

/**
 * BFS over the edges table, starting from every symbol whose name matches.
 * Cycles are guarded by a visited-set keyed on symbol id. Per-level fan-out
 * is capped so a hot symbol can't blow up the tree.
 */
export function callHierarchy(
  db: DB,
  args: {
    name: string;
    direction?: CallDirection;
    depth?: number;
    rootDir?: string;
    fanout?: number;
  },
): CallHierarchyResult {
  const q = new Queries(db);
  const direction: CallDirection = args.direction ?? 'outgoing';
  const maxDepth = Math.min(Math.max(args.depth ?? 3, 1), 6);
  const fanout = Math.min(Math.max(args.fanout ?? 20, 1), 100);
  const roots = q.searchByName(args.name, 10);
  if (roots.length === 0) {
    return {
      query: args.name,
      direction,
      max_depth: maxDepth,
      roots: [],
      hint: `No symbol named "${args.name}" found.`,
    };
  }
  const visited = new Set<number>();
  const build = (symId: number, sym: SymbolRow & { file_path: string }, depth: number, edgeKind?: string, edgeLine?: number): CallHierarchyNode => {
    const node: CallHierarchyNode = {
      symbol: toHit(sym, args.rootDir),
      depth,
      ...(edgeKind ? { edge_kind: edgeKind } : {}),
      ...(edgeLine !== undefined ? { edge_line: edgeLine } : {}),
      children: [],
    };
    if (depth >= maxDepth) {
      node.truncated = true;
      return node;
    }
    if (visited.has(symId)) {
      node.truncated = true;
      return node;
    }
    visited.add(symId);
    if (direction === 'outgoing') {
      const edges = q.outgoingEdges(symId);
      if (edges.length > fanout) node.truncated = true;
      for (const e of edges.slice(0, fanout)) {
        if (e.target_id && e.target_resolved_name && e.target_file_path) {
          // Resolved edge — recurse into the target symbol.
          const childSym = {
            id: e.target_id, name: e.target_resolved_name, kind: e.target_kind ?? 'function',
            file_path: e.target_file_path, start_line: e.target_line ?? 0,
            end_line: e.target_end_line ?? e.target_line ?? 0,
            signature: e.target_signature ?? null,
          } as SymbolRow & { file_path: string };
          node.children.push(build(e.target_id, childSym, depth + 1, e.kind, e.line));
        } else if (e.target_name) {
          // Unresolved edge — show as a leaf stub so callers still see what is called.
          node.children.push({
            symbol: {
              name: e.target_name,
              kind: 'unknown',
              file: '(unresolved)',
              line: e.line ?? 0,
              end_line: e.line ?? 0,
              signature: null,
            },
            depth: depth + 1,
            edge_kind: e.kind,
            ...(e.line !== undefined ? { edge_line: e.line } : {}),
            children: [],
          });
        }
      }
    } else {
      const edges = q.incomingEdges(symId).filter((e) => e.source_id != null);
      if (edges.length > fanout) node.truncated = true;
      for (const e of edges.slice(0, fanout)) {
        // Phase 24: incomingEdges now includes source file/line/signature — no extra searchByName.
        if (!e.source_id || !e.source_name || !e.source_file_path) continue;
        const childSym = {
          id: e.source_id, name: e.source_name, kind: e.source_kind ?? 'function',
          file_path: e.source_file_path, start_line: e.source_line ?? 0,
          end_line: e.source_end_line ?? e.source_line ?? 0,
          signature: e.source_signature ?? null,
        } as SymbolRow & { file_path: string };
        node.children.push(build(e.source_id, childSym, depth + 1, e.kind, e.line));
      }
    }
    return node;
  };
  const trees = roots.map((r) => build(r.id, r, 0));
  const hasTruncation = (node: CallHierarchyNode): boolean =>
    !!node.truncated || node.children.some(hasTruncation);
  const anyTruncated = trees.some(hasTruncation);
  return {
    query: args.name,
    direction,
    max_depth: maxDepth,
    roots: trees,
    ...(anyTruncated ? { truncated: true as const } : {}),
  };
}

// ---------- 15.3: find_imports --------------------------------------------

export interface ImportSite {
  file: string;
  local_name: string;
  imported_name: string;
  import_kind: 'value' | 'type';
  line: number;
  col: number;
}

export interface FindImportsResult {
  module: string;
  importers: ImportSite[];
  total: number;
  hint?: string;
}

/**
 * Every file that has `import … from "<module>"` (or equivalent).
 * Matches by the literal module specifier as recorded by the indexer.
 */
export function findImports(
  db: DB,
  args: { module: string; limit?: number; rootDir?: string },
): FindImportsResult {
  if (!args.module || args.module.length < 1) {
    return { module: args.module, importers: [], total: 0, hint: 'module is required' };
  }
  const q = new Queries(db);
  const rows = q.fileImportsByModule(args.module, Math.min(Math.max(args.limit ?? 100, 1), 500));
  return {
    module: args.module,
    importers: rows.map((r) => ({
      file: fmtPath(r.file_path, args.rootDir),
      local_name: r.local_name,
      imported_name: r.imported_name,
      import_kind: r.import_kind,
      line: r.line,
      col: r.col,
    })),
    total: rows.length,
    ...(rows.length === 0
      ? { hint: `No file in the index imports "${args.module}". Tip: try a partial path or run reindex_file if the import was added recently.` }
      : {}),
  };
}

// ---------- 15.4: index_status --------------------------------------------

export interface IndexStatusResult {
  schema_version: number | null;
  repo_root: string | null;
  file_count: number;
  symbol_count: number;
  last_indexed_at: number | null;
  last_indexed_iso: string | null;
  git_head: string | null;
  drift: { stale_files: number; hint: string } | null;
  /**
   * True while a background reindex is running (set by indexRepo and auto-sync).
   * When true, query results may be partial — the AI should note this caveat.
   */
  indexing: boolean;
  /** ISO timestamp of when the current reindex started, or null. */
  indexing_since: string | null;
  /**
   * Phase 22.4 — breakdown of indexed files by analysis tier.
   *   tier1 = deep premium adapter (TS/TSX/JS, Python, Go) — full symbol +
   *           cross-file module resolution.
   *   tier2 = generic AST adapter (Java, Rust, C++, …) — symbols + calls,
   *           no cross-file resolution.
   *   tier3 = text-only registration (Markdown, JSON, YAML, …) — file is
   *           searchable but has no extracted AST symbols.
   */
  tiers: {
    tier1: number;
    tier2: number;
    tier3: number;
    by_language: Record<string, { tier: IndexTier; files: number }>;
  };
}

/**
 * Summary of the index — schema version, file/symbol counts, last index
 * time, current git HEAD (best-effort), and a coarse "drift" check that
 * counts indexed files whose mtime on disk is newer than indexed_at.
 */
export function indexStatus(
  db: DB,
  args: { rootDir?: string } = {},
): IndexStatusResult {
  const q = new Queries(db);
  const { lastIndexedAt, fileCount, symbolCount } = q.indexStatus();
  const schemaVersion = Number(getManifestValue(db, 'schema_version') ?? 0) || null;
  const repoRoot = getManifestValue(db, 'repo_root');
  let gitHead: string | null = null;
  if (args.rootDir && existsSync(args.rootDir)) {
    try {
      // timeout prevents hanging on slow/network mounts; existsSync guard stops
      // git from traversing parent directories when rootDir has no .git itself.
      gitHead = execSync('git rev-parse HEAD', {
        cwd: args.rootDir,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).toString().trim() || null;
    } catch {
      gitHead = null;
    }
  }
  let drift: IndexStatusResult['drift'] = null;
  if (args.rootDir) {
    let stale = 0;
    const rows = q.allFiles();
    for (const f of rows) {
      try {
        const abs = pathResolve(args.rootDir, f.path);
        const st = statSync(abs);
        if (st.mtimeMs > f.indexed_at + 1000) stale++;
      } catch {
        stale++;
      }
    }
    drift = {
      stale_files: stale,
      hint:
        stale === 0
          ? 'Index is up to date.'
          : `${stale} file(s) appear newer on disk than in the index. Consider running reindex_file or re-running indexRepo.`,
    };
  }
  const indexing = getManifestValue(db, 'indexing') === 'true';
  const indexingSince = indexing ? (getManifestValue(db, 'indexing_since') ?? null) : null;

  return {
    schema_version: schemaVersion,
    repo_root: repoRoot,
    file_count: fileCount,
    symbol_count: symbolCount,
    last_indexed_at: lastIndexedAt,
    last_indexed_iso: lastIndexedAt ? new Date(lastIndexedAt).toISOString() : null,
    git_head: gitHead,
    drift: indexing
      ? { stale_files: 0, hint: '⚠ Index is currently being refreshed — results may be partial.' }
      : drift,
    indexing,
    indexing_since: indexingSince,
    tiers: computeTierBreakdown(db),
  };
}

/**
 * Phase 22.4 — group indexed files by language, then by analysis tier.
 *
 * Reads the `files` table directly so the breakdown reflects what's
 * actually in the DB (covers files indexed by older versions before the
 * adapter for their extension was registered).
 */
function computeTierBreakdown(db: DB): IndexStatusResult['tiers'] {
  const rows = db
    .prepare(`SELECT language, COUNT(*) AS n FROM files GROUP BY language`)
    .all() as { language: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.language] = r.n;
  const { tier1, tier2, tier3, byTier } = groupByTier(counts);
  const byLanguage: Record<string, { tier: IndexTier; files: number }> = {};
  for (const [tierKey, langs] of Object.entries(byTier) as Array<[
    string,
    Record<string, number>,
  ]>) {
    const tier = Number(tierKey) as IndexTier;
    for (const [lang, n] of Object.entries(langs)) {
      byLanguage[lang] = { tier, files: n };
    }
  }
  return { tier1, tier2, tier3, by_language: byLanguage };
}

// ---------- 15.5: reindex_file --------------------------------------------

export interface ReindexFileResult {
  ok: boolean;
  file?: string;
  language?: string;
  symbol_count?: number;
  edge_count?: number;
  hint?: string;
}

/**
 * Re-parse a single file and atomically rewrite its symbols/edges.
 *
 * The MCP server normally opens the DB read-only; the caller must pass a
 * writable handle (the server bin manages this by opening a separate
 * read-write connection when this tool is invoked).
 */
export async function reindexFile(
  writableDb: DB,
  args: { file: string; rootDir?: string; resolve?: boolean },
): Promise<ReindexFileResult> {
  if (writableDb.readonly) {
    return { ok: false, hint: 'reindex_file requires a writable database connection.' };
  }
  const fwd = args.file.replace(/\\/g, '/');
  const abs = isAbsolute(args.file)
    ? args.file
    : args.rootDir
      ? pathResolve(args.rootDir, fwd)
      : pathResolve(fwd);
  if (!existsSync(abs)) {
    return { ok: false, hint: `File not found on disk: ${abs}` };
  }
  const reindexGuardDir = args.rootDir ?? process.cwd();
  const reindexRel = relative(reindexGuardDir, abs);
  if (reindexRel.startsWith('..') || isAbsolute(reindexRel)) {
    return { ok: false, hint: 'Path escapes project root; refusing to reindex.' };
  }
  try {
    const r = await indexFile(writableDb, abs, { repoRoot: args.rootDir });
    if (args.resolve !== false && args.rootDir) {
      resolveReferences(writableDb, { root: args.rootDir });
    }
    return {
      ok: true,
      file: fmtPath(abs.replace(/\\/g, '/'), args.rootDir),
      language: r.language,
      symbol_count: r.symbolCount,
      edge_count: r.edgeCount,
    };
  } catch (err) {
    return { ok: false, hint: `Reindex failed: ${(err as Error).message}` };
  }
}

// ---------- helpers re-exported for resources -----------------------------

/** List of indexed files — used by the `synapse://files` resource. */
export function listFiles(db: DB, rootDir?: string): { files: string[] } {
  const q = new Queries(db);
  return { files: q.allFiles().map((f) => fmtPath(f.path, rootDir)) };
}

// ---------- Phase 18.2: semantic_search -----------------------------------

import {
  semanticSearch as coreSemanticSearch,
  hybridSearch as coreHybridSearch,
  hasEmbeddingsTable,
  type EmbeddingProvider,
  type SemanticHit,
  type HybridHit,
} from '@synapse/core';

export interface SemanticSearchResult {
  hits: Array<SemanticHit & { file: string }>;
  totalEmbedded: number;
  available: boolean;
  hint?: string;
}

export async function semanticSearchHandler(
  db: DB,
  provider: EmbeddingProvider | null,
  args: { query: string; k?: number; kind?: string; rootDir?: string },
): Promise<SemanticSearchResult> {
  if (!provider || !hasEmbeddingsTable(db)) {
    return {
      hits: [],
      totalEmbedded: 0,
      available: false,
      hint: "Semantic search is not set up yet. Run `synapse embed` from the CLI to enable it. This downloads a ~23 MB local model (Transformers.js / all-MiniLM-L6-v2) — no API key or external server needed. Re-index first if you haven't: `synapse index`.",
    };
  }
  const result = await coreSemanticSearch(db, provider, {
    query: args.query,
    k: args.k,
    kind: args.kind,
  });
  return {
    hits: result.hits.map((h) => ({
      ...h,
      file: fmtPath(h.file, args.rootDir),
    })),
    totalEmbedded: result.totalEmbedded,
    available: true,
  };
}

export interface HybridSearchResult {
  hits: Array<HybridHit & { file: string }>;
  stages: Record<string, number>;
  hint?: string;
}

export async function hybridSearchHandler(
  db: DB,
  provider: EmbeddingProvider | null,
  args: { query: string; k?: number; kind?: string; language?: string; file_glob?: string; rootDir?: string },
): Promise<HybridSearchResult> {
  const result = await coreHybridSearch(db, provider, {
    query: args.query,
    k: args.k,
    kind: args.kind,
    language: args.language,
    fileGlob: args.file_glob,
  });
  const hits = result.hits.map((h) => ({ ...h, file: fmtPath(h.file, args.rootDir) }));
  let hint: string | undefined;
  if (hits.length === 0) {
    if (!provider) {
      hint =
        "No results. Without embeddings, hybrid_search only matches symbol *names* — natural-language queries won't match code content. Run `synapse embed` once to enable semantic matching (free, local ~23 MB model). Then try again.";
    } else {
      hint =
        "No results across all stages. Try a shorter query, a different keyword, or use `grep_code` for raw text pattern search.";
    }
  }
  return { hits, stages: result.stages, hint };
}

// avoid unused-import warnings when handlers compile in stricter modes
void dirname;
void join;

// ─── Phase 23.1: explore_symbol (drill-down API) ─────────────────────────────

export interface ExploreSymbolResult {
  found: boolean;
  symbol?: SymbolHit & { doc: string | null; language: string | null };
  source?: string;
  callers: Array<{ name: string; kind: string; file: string; line: number }>;
  callees: Array<{ name: string; kind: string; file: string; line: number }>;
  related_imports: Array<{ module: string; local_name: string; file: string; line: number }>;
  hint?: string;
}

/**
 * Phase 23.1 — Single round-trip drill-down into a symbol.
 *
 * Combines get_definition + source snippet + callers + callees + imports so an
 * LLM gets full context in one call instead of chaining 4-5 tools.
 */
export function exploreSymbol(
  db: DB,
  args: { name: string; file?: string; max_callers?: number; max_callees?: number; rootDir?: string },
): ExploreSymbolResult {
  const q = new Queries(db);
  const maxCallers = Math.min(Math.max(args.max_callers ?? 15, 1), 50);
  const maxCallees = Math.min(Math.max(args.max_callees ?? 15, 1), 50);

  let symbols = q.searchByName(args.name, 10);
  if (args.file) {
    const needle = args.file;
    symbols = symbols.filter((s) => s.file_path.includes(needle));
  }
  if (symbols.length === 0) {
    const fuzzy = q.searchByNameLike(`%${escapeLike(args.name)}%`, 5);
    return {
      found: false,
      callers: [],
      callees: [],
      related_imports: [],
      hint: fuzzy.length > 0
        ? `No match for "${args.name}". Did you mean: ${fuzzy.map((r) => r.name).join(', ')}?`
        : `No symbol named "${args.name}" in the index.`,
    };
  }

  const sym = symbols[0]!;
  const hit: ExploreSymbolResult['symbol'] = {
    ...toHit(sym, args.rootDir),
    doc: sym.doc ?? null,
    language: sym.language ?? null,
  };

  // Source snippet (up to 60 lines around the symbol).
  let source: string | undefined;
  try {
    const filePath = args.rootDir
      ? pathResolve(args.rootDir, sym.file_path)
      : sym.file_path;
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf8');
      const lines = raw.split('\n');
      const startIdx = Math.max(0, sym.start_line - 1);
      const endIdx = Math.min(lines.length, sym.end_line + 5); // include a few lines after
      const slice = lines.slice(startIdx, Math.min(endIdx, startIdx + 60));
      source = slice.join('\n');
    }
  } catch { /* best effort */ }

  // Callers (incoming edges)
  const callers: ExploreSymbolResult['callers'] = [];
  const incoming = q.incomingEdges(sym.id);
  for (const e of incoming.slice(0, maxCallers)) {
    if (e.source_name) {
      callers.push({
        name: e.source_name,
        kind: e.source_kind ?? 'unknown',
        file: fmtPath(e.file_path, args.rootDir),
        line: e.line,
      });
    }
  }

  // Callees (outgoing edges)
  const callees: ExploreSymbolResult['callees'] = [];
  const outgoing = q.outgoingEdges(sym.id);
  for (const e of outgoing.slice(0, maxCallees)) {
    const name = e.target_resolved_name ?? e.target_name;
    if (name) {
      callees.push({
        name,
        kind: e.target_kind ?? 'unknown',
        file: fmtPath(e.target_file_path ?? e.file_path, args.rootDir),
        line: e.target_line ?? e.line,
      });
    }
  }

  // Related imports (imports from the file this symbol lives in)
  const related_imports: ExploreSymbolResult['related_imports'] = [];
  const fileRow = q.fileByPath(sym.file_path);
  if (fileRow) {
    const imports = q.fileImports(fileRow.id);
    for (const imp of imports.slice(0, 20)) {
      related_imports.push({
        module: imp.module_specifier,
        local_name: imp.local_name,
        file: fmtPath(sym.file_path, args.rootDir),
        line: imp.line,
      });
    }
  }

  return { found: true, symbol: hit, source, callers, callees, related_imports };
}

// ─── Phase 23.3: result offloading ───────────────────────────────────────────

const OFFLOAD_DIR = join(tmpdir(), 'synapse-offload');

/** In-memory registry of offloaded tokens → file paths. */
const offloadRegistry = new Map<string, string>();

export interface OffloadedResult {
  offloaded: true;
  token: string;
  preview: string;
  size_bytes: number;
  hint: string;
}

/**
 * If `payload` exceeds `maxBytes` (default 8 KB), write to a temp file and
 * return a compact pointer + preview. Otherwise return null (caller uses raw).
 */
export function maybeOffload(
  payload: string,
  maxBytes = 8192,
): OffloadedResult | null {
  if (payload.length <= maxBytes) return null;
  mkdirSync(OFFLOAD_DIR, { recursive: true });
  const token = randomBytes(12).toString('hex');
  const filePath = join(OFFLOAD_DIR, `${token}.json`);
  writeFileSync(filePath, payload, 'utf8');
  offloadRegistry.set(token, filePath);
  return {
    offloaded: true,
    token,
    preview: payload.slice(0, 500) + `\n…(${payload.length} bytes total)`,
    size_bytes: payload.length,
    hint: 'Full result offloaded. Call read_offloaded(token) to retrieve.',
  };
}

export interface ReadOffloadedResult {
  found: boolean;
  content?: string;
  hint?: string;
}

/**
 * Retrieve an offloaded result by token.
 */
export function readOffloaded(args: { token: string }): ReadOffloadedResult {
  const filePath = offloadRegistry.get(args.token);
  if (!filePath || !existsSync(filePath)) {
    return { found: false, hint: `No offloaded result with token "${args.token}". It may have expired.` };
  }
  return { found: true, content: readFileSync(filePath, 'utf8') };
}

// ─── Phase 23.4: detect_cycles + top_symbols (graph analytics) ───────────────

export interface CycleResult {
  cycles: Array<{ path: string[]; files: string[] }>;
  total: number;
  hint?: string;
}

/**
 * Phase 23.4 — Detect import cycles in the codebase.
 *
 * Builds a directed graph from file_imports and finds strongly-connected
 * components larger than 1 (i.e., cycles). Returns up to `limit` cycles.
 */
export function detectCycles(
  db: DB,
  args: { limit?: number; rootDir?: string },
): CycleResult {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);

  // Build adjacency list from resolved file imports.
  const rows = db
    .prepare(
      `SELECT fi.file_id AS src, fi.resolved_file_id AS dst
       FROM file_imports fi
       WHERE fi.resolved_file_id IS NOT NULL`,
    )
    .all() as { src: number; dst: number }[];

  // Get file paths keyed by id.
  const fileRows = db
    .prepare(`SELECT id, path FROM files`)
    .all() as { id: number; path: string }[];
  const pathById = new Map<number, string>();
  for (const f of fileRows) pathById.set(f.id, f.path);

  // Build adjacency list.
  const adj = new Map<number, number[]>();
  const allNodes = new Set<number>();
  for (const { src, dst } of rows) {
    if (!adj.has(src)) adj.set(src, []);
    adj.get(src)!.push(dst);
    allNodes.add(src);
    allNodes.add(dst);
  }

  // Tarjan's SCC algorithm.
  let idx = 0;
  const stack: number[] = [];
  const onStack = new Set<number>();
  const index = new Map<number, number>();
  const lowlink = new Map<number, number>();
  const sccs: number[][] = [];

  function strongconnect(v: number): void {
    index.set(v, idx);
    lowlink.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  }

  for (const node of allNodes) {
    if (!index.has(node)) strongconnect(node);
  }

  // Sort by size descending so the worst cycles come first.
  sccs.sort((a, b) => b.length - a.length);

  const cycles = sccs.slice(0, limit).map((scc) => ({
    path: scc.map((id) => pathById.get(id) ?? `<unknown:${id}>`),
    files: scc.map((id) => fmtPath(pathById.get(id) ?? '', args.rootDir)),
  }));

  return {
    cycles,
    total: sccs.length,
    ...(sccs.length === 0
      ? { hint: 'No import cycles detected. The dependency graph is acyclic.' }
      : {}),
  };
}

export interface TopSymbolsResult {
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    fan_in: number;
    fan_out: number;
    score: number;
  }>;
  total_symbols: number;
}

/**
 * Phase 23.4 — "PageRank-lite": rank symbols by connectivity.
 *
 * Uses a combined fan_in + fan_out weighted score so the most-connected
 * symbols (architectural hubs) float to the top. This gives a quick
 * "what are the most important parts of this codebase?" answer.
 */
export function topSymbols(
  db: DB,
  args: { limit?: number; kind?: string; rootDir?: string },
): TopSymbolsResult {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const kindFilter = args.kind ? 'AND s.kind = ?' : '';
  const params: unknown[] = args.kind ? [args.kind, limit] : [limit];

  // Phase 24: replaced correlated subqueries (O(symbols × edges)) with
  // two aggregating CTEs that each scan edges once, then LEFT JOIN.
  // Total cost: O(edges) for the CTEs + O(symbols) for the main scan.
  const rows = db
    .prepare(
      `WITH
         fi AS (SELECT target_id AS id, COUNT(*) AS n
                FROM edges WHERE target_id IS NOT NULL GROUP BY target_id),
         fo AS (SELECT source_id AS id, COUNT(*) AS n
                FROM edges WHERE source_id IS NOT NULL GROUP BY source_id)
       SELECT s.id, s.name, s.kind, s.start_line, f.path AS file_path,
              COALESCE(fi.n, 0) AS fan_in,
              COALESCE(fo.n, 0) AS fan_out
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       LEFT JOIN fi ON fi.id = s.id
       LEFT JOIN fo ON fo.id = s.id
       WHERE 1=1 ${kindFilter}
       ORDER BY (COALESCE(fi.n, 0) * 2 + COALESCE(fo.n, 0)) DESC,
                COALESCE(fi.n, 0) DESC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: number;
    name: string;
    kind: string;
    start_line: number;
    file_path: string;
    fan_in: number;
    fan_out: number;
  }>;

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM symbols`)
    .get() as { c: number };

  return {
    symbols: rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      file: fmtPath(r.file_path, args.rootDir),
      line: r.start_line,
      fan_in: r.fan_in,
      fan_out: r.fan_out,
      score: r.fan_in * 2 + r.fan_out, // Weighted: being called is more significant.
    })),
    total_symbols: totalRow.c,
  };
}

// ─── Phase 23.6: verify_results (confidence scorer) ──────────────────────────

export interface VerifyResult {
  verified: boolean;
  confidence: number;
  checks: {
    symbol_exists: boolean;
    file_exists: boolean;
    signature_match: boolean | null;
    line_plausible: boolean;
  };
  hint?: string;
}

/**
 * Phase 23.6 — Verify a symbol claim against the graph.
 *
 * Takes a (name, file, line?, signature?) tuple and confirms whether the
 * index supports it. Returns a 0–1 confidence score. Use this to prevent
 * hallucinations in AI-generated references.
 */
export function verifySymbol(
  db: DB,
  args: { name: string; file?: string; line?: number; signature?: string; rootDir?: string },
): VerifyResult {
  const q = new Queries(db);
  let symbols = q.searchByName(args.name, 20);

  // Filter by file if provided.
  if (args.file) {
    const needle = args.file;
    symbols = symbols.filter((s) => s.file_path.includes(needle));
  }

  if (symbols.length === 0) {
    return {
      verified: false,
      confidence: 0,
      checks: { symbol_exists: false, file_exists: false, signature_match: null, line_plausible: false },
      hint: `Symbol "${args.name}" not found in the index.`,
    };
  }

  const sym = symbols[0]!;
  let score = 0;
  const checks = {
    symbol_exists: true,
    file_exists: true,
    signature_match: null as boolean | null,
    line_plausible: false,
  };
  score += 0.4; // Exists = 40%

  // Check file existence.
  if (args.file) {
    const fileMatch = symbols.some((s) => s.file_path.includes(args.file!));
    checks.file_exists = fileMatch;
    if (fileMatch) score += 0.2;
  } else {
    score += 0.2; // No file claim to invalidate.
  }

  // Check line plausibility.
  if (args.line !== undefined) {
    const lineDelta = Math.abs(args.line - sym.start_line);
    checks.line_plausible = lineDelta <= 5;
    if (checks.line_plausible) score += 0.2;
    else if (lineDelta <= 20) score += 0.1;
  } else {
    score += 0.15; // No line claim.
  }

  // Check signature match.
  if (args.signature && sym.signature) {
    // Normalize: strip whitespace differences for comparison.
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const claimed = normalize(args.signature);
    const actual = normalize(sym.signature);
    checks.signature_match = actual.includes(claimed) || claimed.includes(actual);
    if (checks.signature_match) score += 0.2;
  } else {
    score += 0.1; // No signature claim.
  }

  return {
    verified: score >= 0.6,
    confidence: Math.round(score * 100) / 100,
    checks,
  };
}

// ─── grep_code: text-pattern search across indexed files ─────────────────────

/** Convert a simple glob pattern (*, **) to a RegExp that matches a file path. */
function matchGlob(filePath: string, glob: string): boolean {
  const fwd = filePath.replace(/\\/g, '/');
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special chars except *
    .replace(/\*\*/g, '\x00')              // protect ** temporarily
    .replace(/\*/g, '[^/]*')               // * = one path segment
    .replace(/\x00/g, '.*');               // ** = any depth
  return new RegExp(`(^|/)${escaped}(/|$)`, 'i').test(fwd) ||
         new RegExp(`(^|/)${escaped}$`, 'i').test(fwd);
}

/** Find the innermost symbol whose line range contains `line` (1-based). */
function findEnclosingSymbol(
  symbols: SymbolRow[],
  line: number,
): { name: string; kind: string; start_line: number; end_line: number } | undefined {
  let best: SymbolRow | undefined;
  for (const sym of symbols) {
    if (sym.start_line <= line && sym.end_line >= line) {
      if (!best || sym.end_line - sym.start_line < best.end_line - best.start_line) {
        best = sym;
      }
    }
  }
  return best
    ? { name: best.name, kind: best.kind, start_line: best.start_line, end_line: best.end_line }
    : undefined;
}

export interface GrepMatch {
  file: string;
  line: number;
  col: number;
  match_text: string;
  context_before: string[];
  context_after: string[];
  enclosing_symbol?: { name: string; kind: string; start_line: number; end_line: number };
}

export interface GrepResult {
  pattern: string;
  file_glob?: string;
  matches: GrepMatch[];
  total_matches: number;
  truncated: boolean;
  searched_files: number;
  /** Which backend served the query: 'ripgrep' | 'fts5+db' | 'disk' */
  backend?: string;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Grep backends
// ---------------------------------------------------------------------------

let _rgBin: string | null | undefined;

function findRipgrep(): string | null {
  if (_rgBin !== undefined) return _rgBin;

  // 1. Try PATH first
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['rg'], {
      encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout.trim()) {
      _rgBin = r.stdout.trim().split('\n')[0]!.trim();
      return _rgBin;
    }
  } catch {}

  // 2. Check well-known Windows install locations
  if (process.platform === 'win32') {
    const home = process.env['USERPROFILE'] ?? 'C:\\Users\\Default';
    const local = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    const candidates = [
      join(local, 'Programs', 'Microsoft VS Code', 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
      join(home, 'scoop', 'shims', 'rg.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\rg.exe',
      'C:\\Program Files\\ripgrep\\rg.exe',
    ];
    for (const p of candidates) {
      try {
        if (existsSync(p)) { _rgBin = p; return p; }
      } catch {}
    }
  }

  _rgBin = null;
  return null;
}

type GrepArgs = {
  pattern: string;
  fixed_string?: boolean;
  case_sensitive?: boolean;
  file_glob?: string;
  context_lines?: number;
  max_matches?: number;
  rootDir?: string;
};

/**
 * Grep backend using ripgrep (rg) — streaming async implementation.
 *
 * Uses spawn() instead of spawnSync() so the event loop is never blocked
 * during the search. Output is consumed line-by-line via readline, so there
 * is no fixed memory buffer cap. The child process is killed early once we
 * have collected maxMatches * 5 events, capping work for very common patterns.
 *
 * Returns null if rg is not installed or rootDir is unset; the caller falls
 * through to the next backend.
 */
async function grepViaRipgrep(db: DB, args: GrepArgs, maxMatches: number, ctxLines: number): Promise<GrepResult | null> {
  const rgBin = findRipgrep();
  if (!rgBin || !args.rootDir) return null;

  const rgArgs: string[] = ['--json'];
  if (args.fixed_string) rgArgs.push('--fixed-strings');
  if (args.case_sensitive) rgArgs.push('--case-sensitive');
  else rgArgs.push('--ignore-case');
  if (args.file_glob) rgArgs.push('--glob', args.file_glob);
  rgArgs.push('-e', args.pattern, args.rootDir);

  return new Promise<GrepResult | null>((resolve) => {
    interface RgMatchEvent {
      absPath: string;
      lineNum: number;
      lineText: string;
      col: number;
    }
    const byFile = new Map<string, RgMatchEvent[]>();
    const fileOrder: string[] = [];
    let totalMatches = 0;
    let truncated = false;

    const child = spawn(rgBin, rgArgs, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', () => resolve(null));

    const rl = createInterface({ input: child.stdout });

    rl.on('line', (raw) => {
      if (!raw.trim()) return;
      try {
        const msg = JSON.parse(raw) as {
          type: string;
          data: {
            path?: { text: string };
            lines?: { text: string };
            line_number?: number;
            submatches?: { match: { text: string }; start: number }[];
          };
        };
        if (msg.type !== 'match' || !msg.data.path?.text || !msg.data.line_number) return;
        const ap = msg.data.path.text;
        if (!byFile.has(ap)) { byFile.set(ap, []); fileOrder.push(ap); }
        byFile.get(ap)!.push({
          absPath: ap,
          lineNum: msg.data.line_number,
          lineText: (msg.data.lines?.text ?? '').replace(/\n$/, ''),
          col: (msg.data.submatches?.[0]?.start ?? 0) + 1,
        });
        totalMatches++;
        // Kill rg early once we are well past the return limit — avoids
        // processing an unbounded stream for very common patterns.
        if (totalMatches >= maxMatches * 5) {
          truncated = true;
          rl.close();
          child.kill();
        }
      } catch { /* skip malformed NDJSON lines */ }
    });

    child.on('close', (code) => {
      // code===2 with nothing collected = rg fatal error; fall through to next backend.
      if (code === 2 && byFile.size === 0) { resolve(null); return; }

      const q = new Queries(db);

      const contentCache = new Map<string, string[]>();
      const getLines = (absPath: string, relPath: string): string[] => {
        const cached = contentCache.get(absPath);
        if (cached) return cached;
        const fileRow = q.fileByPath(relPath);
        let lines: string[] = [];
        if (fileRow) {
          const content = q.getFileContent(fileRow.id);
          if (content) lines = content.split(/\r?\n/);
        }
        if (!lines.length) {
          try { lines = readFileSync(absPath, 'utf8').split(/\r?\n/); } catch {}
        }
        contentCache.set(absPath, lines);
        return lines;
      };

      const matches: GrepMatch[] = [];
      let reported = 0;

      for (const absPath of fileOrder) {
        const fileMatches = byFile.get(absPath)!;
        const relPath = relative(args.rootDir!, absPath).replace(/\\/g, '/');
        const fileRow = q.fileByPath(relPath);
        const fileSymbols = fileRow ? q.symbolsInFile(fileRow.id) : [];
        const lines = ctxLines > 0 ? getLines(absPath, relPath) : [];

        for (const ev of fileMatches) {
          if (reported >= maxMatches) { truncated = true; continue; }
          reported++;
          const i = ev.lineNum - 1;
          matches.push({
            file: fmtPath(relPath, undefined),
            line: ev.lineNum,
            col: ev.col,
            match_text: ev.lineText.trimEnd(),
            context_before: lines.slice(Math.max(0, i - ctxLines), i),
            context_after: lines.slice(i + 1, i + 1 + ctxLines),
            ...((findEnclosingSymbol(fileSymbols, ev.lineNum) ?? undefined) !== undefined
              ? { enclosing_symbol: findEnclosingSymbol(fileSymbols, ev.lineNum)! }
              : {}),
          });
        }
      }

      resolve({
        pattern: args.pattern,
        ...(args.file_glob ? { file_glob: args.file_glob } : {}),
        matches,
        total_matches: totalMatches,
        truncated,
        searched_files: byFile.size,
        backend: 'ripgrep',
        ...(truncated
          ? { hint: `Showing first ${maxMatches} of ${totalMatches}+ matches. Narrow with file_glob or a tighter pattern, or increase max_matches (max 200).` }
          : {}),
      });
    });
  });
}

/**
 * Grep backend using the DB content table (FTS5 prefilter + line scan).
 * Returns null if no file content is stored (before first reindex).
 */
function grepViaDbContent(db: DB, args: GrepArgs, regex: RegExp, maxMatches: number, ctxLines: number): GrepResult | null {
  const q = new Queries(db);

  // Determine candidate files: FTS5 prefilter (fastest) or all files with content.
  let candidateIds: Set<number> | null = null;
  const literal = extractFtsLiteral(args.pattern, args.fixed_string);
  if (literal && q.hasContentFts()) {
    const ids = q.searchContentFts(literal, 2000);
    if (ids.length === 0 && !args.file_glob) {
      // FTS returned nothing — pattern truly not present
      return {
        pattern: args.pattern,
        ...(args.file_glob ? { file_glob: args.file_glob } : {}),
        matches: [],
        total_matches: 0,
        truncated: false,
        searched_files: 0,
        backend: 'fts5+db',
      };
    }
    candidateIds = new Set(ids);
  }

  const allWithContent = q.filesWithContent();
  if (allWithContent.length === 0) return null; // no content stored yet

  const matches: GrepMatch[] = [];
  let totalMatches = 0;
  let searchedFiles = 0;
  let truncated = false;

  for (const { file_id, path } of allWithContent) {
    if (args.file_glob && !matchGlob(path, args.file_glob)) continue;
    if (candidateIds && !candidateIds.has(file_id)) continue;

    const content = q.getFileContent(file_id);
    if (!content) continue;
    searchedFiles++;

    const lines = content.split(/\r?\n/);
    let fileSymbols: SymbolRow[] | null = null;

    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;
      totalMatches++;
      if (matches.length >= maxMatches) { truncated = true; continue; }

      if (fileSymbols === null) {
        const fileRow = q.fileByPath(path);
        fileSymbols = fileRow ? q.symbolsInFile(fileRow.id) : [];
      }

      const lineNum = i + 1;
      const enclosing = findEnclosingSymbol(fileSymbols, lineNum);
      matches.push({
        file: path,
        line: lineNum,
        col: (lines[i]!.search(regex)) + 1,
        match_text: lines[i]!.trimEnd(),
        context_before: lines.slice(Math.max(0, i - ctxLines), i),
        context_after: lines.slice(i + 1, i + 1 + ctxLines),
        ...(enclosing ? { enclosing_symbol: enclosing } : {}),
      });
    }
  }

  return {
    pattern: args.pattern,
    ...(args.file_glob ? { file_glob: args.file_glob } : {}),
    matches,
    total_matches: totalMatches,
    truncated,
    searched_files: searchedFiles,
    backend: 'fts5+db',
    ...(truncated
      ? { hint: `Showing first ${maxMatches} of ${totalMatches} matches. Narrow with file_glob or a tighter pattern, or increase max_matches (max 200).` }
      : {}),
  };
}

/**
 * Extract a simple literal term (3+ chars, no regex metacharacters) from
 * a pattern so we can use it as an FTS5 MATCH query to pre-filter candidate
 * files. Returns null when the pattern is too short or too complex.
 */
function extractFtsLiteral(pattern: string, fixedString?: boolean): string | null {
  if (fixedString) return pattern.length >= 3 ? pattern : null;
  // Remove regex metacharacters and look for a 3+ char run of safe chars.
  const safe = pattern.replace(/[.*+?^${}()|[\]\\]/g, ' ');
  const parts = safe.split(/\s+/).filter((p) => p.length >= 3);
  return parts.length > 0 ? parts.sort((a, b) => b.length - a.length)[0]! : null;
}

/**
 * Text-pattern search across every indexed file.
 *
 * Tries three backends in priority order:
 * 1. ripgrep (rg) — fastest, native parallel I/O (requires rg in PATH)
 * 2. SQLite FTS5 + content table — fast DB scan, no disk reads (requires reindex)
 * 3. Disk scan — always works, reads every file from disk sequentially
 *
 * Each match is enriched with the enclosing DB symbol so the caller can
 * immediately drill into `explore_symbol` or `call_hierarchy`.
 */
export async function grepCode(
  db: DB,
  args: {
    pattern: string;
    fixed_string?: boolean;
    case_sensitive?: boolean;
    file_glob?: string;
    context_lines?: number;
    max_matches?: number;
    rootDir?: string;
  },
): Promise<GrepResult> {
  const maxMatches = Math.min(Math.max(args.max_matches ?? 50, 1), 200);
  const ctxLines = Math.min(Math.max(args.context_lines ?? 2, 0), 10);

  let regex: RegExp;
  try {
    const src = args.fixed_string
      ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : args.pattern;
    regex = new RegExp(src, args.case_sensitive ? '' : 'i');
  } catch {
    return {
      pattern: args.pattern,
      matches: [],
      total_matches: 0,
      truncated: false,
      searched_files: 0,
      hint: `Invalid regex: "${args.pattern}". Set fixed_string:true for a literal search.`,
    };
  }

  // Backend 1: ripgrep (streaming, non-blocking)
  const rgResult = await grepViaRipgrep(db, args, maxMatches, ctxLines);
  if (rgResult !== null) return rgResult;

  // Backend 2: FTS5 + DB content table
  const dbResult = grepViaDbContent(db, args, regex, maxMatches, ctxLines);
  if (dbResult !== null) return dbResult;

  // Backend 3: disk scan (original implementation)
  const q = new Queries(db);
  const files = q.allFiles();
  const matches: GrepMatch[] = [];
  let totalMatches = 0;
  let searchedFiles = 0;
  let truncated = false;

  for (const f of files) {
    if (args.file_glob && !matchGlob(f.path, args.file_glob)) continue;

    const abs = args.rootDir ? pathResolve(args.rootDir, f.path) : pathResolve(f.path);
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    searchedFiles++;

    const lines = content.split(/\r?\n/);
    let fileSymbols: SymbolRow[] | null = null;

    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;

      totalMatches++;
      if (matches.length >= maxMatches) { truncated = true; continue; }

      if (fileSymbols === null) {
        const fileRow = q.fileByPath(f.path);
        fileSymbols = fileRow ? q.symbolsInFile(fileRow.id) : [];
      }

      const lineNum = i + 1;
      const enclosing = findEnclosingSymbol(fileSymbols, lineNum);

      matches.push({
        file: fmtPath(abs.replace(/\\/g, '/'), args.rootDir),
        line: lineNum,
        col: (lines[i]!.search(regex)) + 1,
        match_text: lines[i]!.trimEnd(),
        context_before: lines.slice(Math.max(0, i - ctxLines), i),
        context_after: lines.slice(i + 1, i + 1 + ctxLines),
        ...(enclosing ? { enclosing_symbol: enclosing } : {}),
      });
    }
  }

  return {
    pattern: args.pattern,
    ...(args.file_glob ? { file_glob: args.file_glob } : {}),
    matches,
    total_matches: totalMatches,
    truncated,
    searched_files: searchedFiles,
    ...(truncated
      ? { hint: `Showing first ${maxMatches} of ${totalMatches} matches. Narrow with file_glob or a tighter pattern, or increase max_matches (max 200).` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Structural search (ast-grep)
// ---------------------------------------------------------------------------

export interface StructuralMatch {
  file: string;
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  match_text: string;
  /** Captured metavariables, e.g. { "$ARGS": "x, y" } */
  vars?: Record<string, string>;
  enclosing_symbol?: { name: string; kind: string; start_line: number; end_line: number };
}

export interface StructuralSearchResult {
  pattern: string;
  language: string;
  matches: StructuralMatch[];
  total_matches: number;
  truncated: boolean;
  searched_files: number;
  error?: string;
}

const AST_GREP_LANG_MAP: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust',
  java: 'Java', c: 'C', h: 'C', cpp: 'Cpp', cc: 'Cpp', hpp: 'Cpp',
};

export async function structuralSearch(
  db: DB,
  args: {
    pattern: string;
    language: string;
    file_glob?: string;
    max_matches?: number;
    rootDir?: string;
  },
): Promise<StructuralSearchResult> {
  // Dynamic import — @ast-grep/napi is an optional native module
  let sgParse: typeof SgParse;
  let Lang: typeof SgLang;
  try {
    const mod = await import('@ast-grep/napi') as { parse: typeof SgParse; Lang: typeof SgLang };
    sgParse = mod.parse;
    Lang = mod.Lang;
  } catch {
    return {
      pattern: args.pattern,
      language: args.language,
      matches: [],
      total_matches: 0,
      truncated: false,
      searched_files: 0,
      error:
        'ast-grep is not installed. Add it with:\n  pnpm add @ast-grep/napi\nthen rebuild the MCP server.',
    };
  }

  const maxMatches = Math.min(Math.max(args.max_matches ?? 50, 1), 200);
  const langKey = args.language.toLowerCase().replace(/^typescript$/, 'ts')
    .replace(/^javascript$/, 'js');
  const langName = AST_GREP_LANG_MAP[langKey] ?? args.language;
  const sgLang = Lang[langName as keyof typeof Lang];
  if (sgLang === undefined) {
    return {
      pattern: args.pattern,
      language: args.language,
      matches: [],
      total_matches: 0,
      truncated: false,
      searched_files: 0,
      error: `Unsupported language: "${args.language}". Supported: ${Object.keys(AST_GREP_LANG_MAP).join(', ')}`,
    };
  }

  const q = new Queries(db);
  const allFiles = q.allFiles();
  const matches: StructuralMatch[] = [];
  let totalMatches = 0;
  let truncated = false;
  let searchedFiles = 0;

  // Derive expected extension from language for implicit glob
  const langExts = Object.entries(AST_GREP_LANG_MAP)
    .filter(([, v]) => v === (AST_GREP_LANG_MAP[langKey] ?? ''))
    .map(([k]) => k);

  for (const f of allFiles) {
    const ext = f.path.split('.').pop()?.toLowerCase() ?? '';
    if (!langExts.includes(ext)) continue;
    if (args.file_glob && !matchGlob(f.path, args.file_glob)) continue;

    const fileRow = q.fileByPath(f.path);
    let source: string | null = null;
    if (fileRow) source = q.getFileContent(fileRow.id);
    if (!source && args.rootDir) {
      try { source = readFileSync(pathResolve(args.rootDir, f.path), 'utf8'); } catch {}
    }
    if (!source) continue;
    searchedFiles++;

    try {
      const tree = sgParse(sgLang, source);
      // SgNode has .text(), .range(), .getMatch(metavar) directly on it
      type SgNode = {
        text(): string;
        range(): { start: { line: number; column: number }; end: { line: number; column: number } };
        getMatch(metavar: string): SgNode | null;
        getMultipleMatches(metavar: string): SgNode[];
      };
      const hits = tree.root().findAll({ rule: { pattern: args.pattern } }) as unknown as SgNode[];

      const fileSymbols = fileRow ? q.symbolsInFile(fileRow.id) : [];

      for (const hit of hits) {
        totalMatches++;
        if (matches.length >= maxMatches) { truncated = true; continue; }

        const range = hit.range();
        const text = hit.text();

        // Extract named metavariables from the pattern (e.g. $ARGS, $NAME)
        const metavars = [...(args.pattern.matchAll(/\$+([A-Z_][A-Z0-9_]*)/g))].map((m) => m[0]!);
        const vars: Record<string, string> = {};
        for (const mv of metavars) {
          if (mv.startsWith('$$$')) {
            const nodes = hit.getMultipleMatches(mv);
            if (nodes.length) vars[mv] = nodes.map((n) => n.text()).join(', ');
          } else {
            const node = hit.getMatch(mv);
            if (node) vars[mv] = node.text();
          }
        }

        const lineNum = range.start.line + 1;
        const enclosing = findEnclosingSymbol(fileSymbols, lineNum);
        matches.push({
          file: f.path,
          line: lineNum,
          col: range.start.column + 1,
          end_line: range.end.line + 1,
          end_col: range.end.column + 1,
          match_text: text.split('\n')[0]!.trimEnd() + (text.includes('\n') ? ' …' : ''),
          ...(Object.keys(vars).length ? { vars } : {}),
          ...(enclosing ? { enclosing_symbol: enclosing } : {}),
        });
      }
    } catch { continue; }
  }

  return {
    pattern: args.pattern,
    language: args.language,
    matches,
    total_matches: totalMatches,
    truncated,
    searched_files: searchedFiles,
  };
}

// ---------------------------------------------------------------------------
// Security scan (semgrep)
// ---------------------------------------------------------------------------

export interface SecurityFinding {
  rule_id: string;
  file: string;
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  severity: string;
  message: string;
}

export interface SecurityScanResult {
  config: string;
  findings: SecurityFinding[];
  total_findings: number;
  truncated: boolean;
  scanned_files: number;
  errors: string[];
  installed: boolean;
  error?: string;
}

export function scanSecurity(
  db: DB,
  args: {
    config?: string;
    file_glob?: string;
    max_findings?: number;
    rootDir?: string;
  },
): SecurityScanResult {
  const config = args.config ?? 'auto';
  const maxFindings = Math.min(Math.max(args.max_findings ?? 100, 1), 500);

  // Check if semgrep is installed
  const versionCheck = spawnSync('semgrep', ['--version'], { encoding: 'utf8' });
  if (versionCheck.error) {
    return {
      config,
      findings: [],
      total_findings: 0,
      truncated: false,
      scanned_files: 0,
      errors: [],
      installed: false,
      error:
        'semgrep is not installed. Install it with:\n  pip install semgrep\nor visit https://semgrep.dev/docs/getting-started/',
    };
  }

  const scanArgs = ['scan', '--json', `--config=${config}`, '--no-git-ignore'];
  if (args.file_glob) scanArgs.push('--include', args.file_glob);
  const target = args.rootDir ?? '.';
  scanArgs.push(target);

  const r = spawnSync('semgrep', scanArgs, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  });

  let parsed: {
    results?: Array<{
      check_id: string;
      path: string;
      start: { line: number; col: number };
      end: { line: number; col: number };
      extra: { message: string; severity: string };
    }>;
    errors?: Array<{ type: string; message: string }>;
    stats?: { total_time?: number; total_bytes?: number };
    paths?: { scanned?: string[] };
  };

  try {
    parsed = JSON.parse(r.stdout ?? '{}');
  } catch {
    return {
      config,
      findings: [],
      total_findings: 0,
      truncated: false,
      scanned_files: 0,
      errors: [r.stderr?.trim() ?? 'Failed to parse semgrep output'],
      installed: true,
      error: 'semgrep returned non-JSON output. Check the config name and try again.',
    };
  }

  const allFindings = parsed.results ?? [];
  const truncated = allFindings.length > maxFindings;
  const findings: SecurityFinding[] = allFindings.slice(0, maxFindings).map((r) => ({
    rule_id: r.check_id,
    file: fmtPath(r.path.replace(/\\/g, '/'), args.rootDir),
    line: r.start.line,
    col: r.start.col,
    end_line: r.end.line,
    end_col: r.end.col,
    severity: r.extra.severity,
    message: r.extra.message,
  }));

  return {
    config,
    findings,
    total_findings: allFindings.length,
    truncated,
    scanned_files: parsed.paths?.scanned?.length ?? 0,
    errors: (parsed.errors ?? []).map((e) => `${e.type}: ${e.message}`),
    installed: true,
  };
}

// ---------------------------------------------------------------------------
// Git integration — git_log, git_blame
// ---------------------------------------------------------------------------

export interface GitCommit {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  date: string;
  timestamp: number;
  message: string;
}

export interface GitLogResult {
  file: string;
  commits: GitCommit[];
  total: number;
  is_git_repo: boolean;
  error?: string;
}

export function gitLog(
  db: DB,
  args: { file: string; max_commits?: number; rootDir?: string },
): GitLogResult {
  const maxCommits = Math.min(Math.max(args.max_commits ?? 20, 1), 100);
  const cwd = args.rootDir ?? process.cwd();
  const absFile = isAbsolute(args.file) ? args.file : pathResolve(cwd, args.file);

  const r = spawnSync(
    'git',
    ['log', '--format=%H|%an|%ae|%at|%s', `-n${maxCommits}`, '--', absFile],
    { encoding: 'utf8', cwd, timeout: 15_000 },
  );

  if (r.error) {
    return { file: args.file, commits: [], total: 0, is_git_repo: false, error: 'git not found in PATH' };
  }
  if (r.status !== 0) {
    const msg = r.stderr?.trim() ?? '';
    const isNotRepo = msg.includes('not a git repository');
    return { file: args.file, commits: [], total: 0, is_git_repo: !isNotRepo, error: msg || 'git log failed' };
  }

  const commits: GitCommit[] = (r.stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const pipeIdx = line.indexOf('|');
      const hash = line.slice(0, pipeIdx);
      const rest = line.slice(pipeIdx + 1);
      const parts = rest.split('|');
      const author = parts[0] ?? '';
      const email = parts[1] ?? '';
      const ts = parseInt(parts[2] ?? '0', 10);
      const message = parts.slice(3).join('|');
      return {
        hash,
        short_hash: hash.slice(0, 7),
        author,
        email,
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        timestamp: ts,
        message,
      };
    });

  return { file: args.file, commits, total: commits.length, is_git_repo: true };
}

export interface GitBlameLine {
  line: number;
  content: string;
  commit_hash: string;
  author: string;
  date: string;
  summary: string;
}

export interface GitBlameResult {
  file: string;
  start_line: number;
  end_line: number;
  lines: GitBlameLine[];
  is_git_repo: boolean;
  error?: string;
}

export function gitBlame(
  db: DB,
  args: { file: string; start_line?: number; end_line?: number; rootDir?: string },
): GitBlameResult {
  const cwd = args.rootDir ?? process.cwd();
  const absFile = isAbsolute(args.file) ? args.file : pathResolve(cwd, args.file);
  const startLine = args.start_line ?? 1;
  const endLine = args.end_line ?? 0;
  const base = { file: args.file, start_line: startLine, end_line: endLine, is_git_repo: true, lines: [] };

  const gitArgs = ['blame', '--porcelain'];
  if (endLine > 0) gitArgs.push(`-L${startLine},${endLine}`);
  gitArgs.push('--', absFile);

  const r = spawnSync('git', gitArgs, { encoding: 'utf8', cwd, maxBuffer: 10 * 1024 * 1024, timeout: 20_000 });

  if (r.error) return { ...base, is_git_repo: false, error: 'git not found in PATH' };
  if (r.status !== 0) {
    const msg = r.stderr?.trim() ?? '';
    return { ...base, is_git_repo: !msg.includes('not a git repository'), error: msg || 'git blame failed' };
  }

  // Parse porcelain format: each commit block starts with "<hash> <orig> <final> [<count>]"
  const rawLines = (r.stdout ?? '').split('\n');
  const commitMeta: Record<string, { author: string; date: string; summary: string }> = {};
  const result: GitBlameLine[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const header = rawLines[i]!;
    if (!/^[0-9a-f]{40} /.test(header)) { i++; continue; }

    const hash = header.slice(0, 40);
    const finalLineNum = parseInt(header.split(' ')[2] ?? '0', 10);
    i++;

    // Collect metadata lines until tab-prefixed content line
    let author = commitMeta[hash]?.author ?? '';
    let date = commitMeta[hash]?.date ?? '';
    let summary = commitMeta[hash]?.summary ?? '';

    while (i < rawLines.length && !rawLines[i]!.startsWith('\t')) {
      const meta = rawLines[i]!;
      if (meta.startsWith('author ') && !meta.startsWith('author-')) author = meta.slice(7);
      else if (meta.startsWith('author-time ')) {
        const ts = parseInt(meta.slice(12), 10);
        date = new Date(ts * 1000).toISOString().slice(0, 10);
      } else if (meta.startsWith('summary ')) summary = meta.slice(8);
      i++;
    }

    const content = rawLines[i]?.slice(1) ?? '';
    i++;

    if (!commitMeta[hash]) commitMeta[hash] = { author, date, summary };
    const m = commitMeta[hash]!;

    result.push({
      line: finalLineNum,
      content,
      commit_hash: hash.slice(0, 7),
      author: m.author || author,
      date: m.date || date,
      summary: m.summary || summary,
    });
  }

  const lastLine = result[result.length - 1]?.line ?? endLine;
  return { file: args.file, start_line: startLine, end_line: lastLine, lines: result, is_git_repo: true };
}

// ---------------------------------------------------------------------------
// Dead code detection — symbols with no callers
// ---------------------------------------------------------------------------

export interface DeadCodeResult {
  symbols: SymbolHit[];
  total: number;
  kinds: string[];
  hint?: string;
}

export function findDeadCode(
  db: DB,
  args: { kinds?: string[]; file_glob?: string; limit?: number; rootDir?: string },
): DeadCodeResult {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const kinds = (args.kinds ?? ['function', 'method', 'class']).filter(Boolean);
  if (kinds.length === 0) return { symbols: [], total: 0, kinds };

  const kindPlaceholders = kinds.map(() => '?').join(', ');

  const rows = db
    .prepare(
      `SELECT s.*, f.path AS file_path
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE s.kind IN (${kindPlaceholders})
         AND s.name != 'default'
         AND NOT EXISTS (
           SELECT 1 FROM edges e WHERE e.target_id = s.id
         )
       ORDER BY f.path, s.start_line`,
    )
    .all(...kinds) as (SymbolRow & { file_path: string })[];

  // JS-side glob filter (avoids need to bring globToLike into scope here)
  const filtered = args.file_glob
    ? rows.filter((r) => matchGlob(r.file_path, args.file_glob!))
    : rows;

  const truncated = filtered.length > limit;
  const symbols = filtered.slice(0, limit).map((r) => toHit(r, args.rootDir));

  return {
    symbols,
    total: filtered.length,
    kinds,
    ...(truncated
      ? { hint: `Showing first ${limit} of ${filtered.length} unreferenced symbols. Use file_glob or kinds to narrow.` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Code metrics — per-file complexity summary from the graph
// ---------------------------------------------------------------------------

export interface FileMetrics {
  file: string;
  functions: number;
  classes: number;
  avg_fn_lines: number;
  max_fn_lines: number;
  callers_median: number;
  total_edges_in: number;
}

export interface CodeMetricsResult {
  files: FileMetrics[];
  total_files: number;
  truncated: boolean;
}

export function codeMetrics(
  db: DB,
  args: { file_glob?: string; top_n?: number; sort_by?: string; rootDir?: string },
): CodeMetricsResult {
  const topN = Math.min(Math.max(args.top_n ?? 20, 1), 100);
  const sortBy = args.sort_by ?? 'max_fn_lines';

  type FileRow = { id: number; path: string };
  const allFiles = db.prepare(`SELECT id, path FROM files ORDER BY path`).all() as FileRow[];
  const filtered = args.file_glob
    ? allFiles.filter((f) => matchGlob(f.path, args.file_glob!))
    : allFiles;

  const metrics: FileMetrics[] = [];

  for (const f of filtered) {
    type SymRow = { kind: string; start_line: number; end_line: number };
    const syms = db
      .prepare(`SELECT kind, start_line, end_line FROM symbols WHERE file_id = ? AND kind != 'import'`)
      .all(f.id) as SymRow[];

    const fns = syms.filter((s) => s.kind === 'function' || s.kind === 'method');
    const classes = syms.filter((s) => s.kind === 'class').length;
    const fnLengths = fns.map((s) => s.end_line - s.start_line + 1);
    const avgFnLines = fnLengths.length
      ? Math.round(fnLengths.reduce((a, b) => a + b, 0) / fnLengths.length)
      : 0;
    const maxFnLines = fnLengths.length ? Math.max(...fnLengths) : 0;

    const edgesIn = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e
           JOIN symbols s ON e.target_id = s.id
           WHERE s.file_id = ?`,
        )
        .get(f.id) as { c: number }
    ).c;

    metrics.push({
      file: fmtPath(f.path, args.rootDir),
      functions: fns.length,
      classes,
      avg_fn_lines: avgFnLines,
      max_fn_lines: maxFnLines,
      callers_median: 0,
      total_edges_in: edgesIn,
    });
  }

  // Sort
  const sorters: Record<string, (a: FileMetrics, b: FileMetrics) => number> = {
    max_fn_lines: (a, b) => b.max_fn_lines - a.max_fn_lines,
    functions: (a, b) => b.functions - a.functions,
    total_edges_in: (a, b) => b.total_edges_in - a.total_edges_in,
    avg_fn_lines: (a, b) => b.avg_fn_lines - a.avg_fn_lines,
  };
  metrics.sort(sorters[sortBy] ?? sorters['max_fn_lines']!);

  return {
    files: metrics.slice(0, topN),
    total_files: metrics.length,
    truncated: metrics.length > topN,
  };
}
