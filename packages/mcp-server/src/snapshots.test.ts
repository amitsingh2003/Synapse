/**
 * Phase 20.1 — Snapshot tests for every MCP tool's JSON output shape.
 *
 * These tests ensure the JSON contract doesn't accidentally change.
 * Each tool's output shape is captured as a Vitest inline snapshot.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  indexRepo,
  resolveReferences,
} from '@synapse/core';
import type { Database as DB } from 'better-sqlite3';
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
} from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'fixtures', 'sample-shopping-app');

let dbDir: string;
let dbPath: string;
let db: DB;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'cg-snap-'));
  dbPath = join(dbDir, 'graph.db');
  db = openDatabase({ path: dbPath });
  await indexRepo(db, { root: FIXTURE, concurrency: 2 });
  resolveReferences(db, { root: FIXTURE });
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dbDir, { recursive: true, force: true });
});


describe('Phase 20.1 — MCP Tool JSON Shape Snapshots', () => {
  it('find_symbol shape', () => {
    const result = findSymbol(db, { name: 'Cart', rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "symbols",
        "total",
      ]
    `);
    expect(result.symbols.length).toBeGreaterThan(0);
    const sym = result.symbols[0]!;
    expect(Object.keys(sym).sort()).toMatchInlineSnapshot(`
      [
        "end_line",
        "file",
        "kind",
        "line",
        "name",
        "signature",
      ]
    `);
  });

  it('find_references shape', () => {
    const result = findReferences(db, { name: 'addItem', rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "results",
      ]
    `);
    expect(result.results.length).toBeGreaterThan(0);
    const first = result.results[0]!;
    expect(Object.keys(first).sort()).toMatchInlineSnapshot(`
      [
        "references",
        "symbol",
        "truncated",
      ]
    `);
    if (first.references.length > 0) {
      const ref = first.references[0]!;
      expect(Object.keys(ref).sort()).toMatchInlineSnapshot(`
        [
          "col",
          "file",
          "from",
          "kind",
          "line",
        ]
      `);
    }
  });

  it('get_definition shape', () => {
    const result = getDefinition(db, { name: 'Cart', rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "alternatives",
        "found",
        "symbol",
      ]
    `);
    expect(Object.keys(result.symbol!).sort()).toMatchInlineSnapshot(`
      [
        "doc",
        "end_line",
        "file",
        "kind",
        "line",
        "name",
        "signature",
      ]
    `);
  });

  it('search_symbols shape', () => {
    const result = searchSymbols(db, { query: 'cart', rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "symbols",
        "total",
      ]
    `);
  });

  it('list_symbols_in_file shape', () => {
    const result = listSymbolsInFile(db, { file: 'src/cart.ts', rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "file",
        "found",
        "language",
        "symbols",
      ]
    `);
  });

  it('outgoing_calls shape', () => {
    const result = outgoingCalls(db, { name: 'CartService', rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "results",
      ]
    `);
    if (result.results.length > 0 && result.results[0]!.outgoing.length > 0) {
      const call = result.results[0]!.outgoing[0]!;
      expect(Object.keys(call).sort()).toMatchInlineSnapshot(`
        [
          "col",
          "kind",
          "line",
          "resolved",
          "to_name",
        ]
      `);
    }
  });

  it('get_stats shape', () => {
    const result = getStats(db);
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "dbSizeBytes",
        "edges",
        "edgesByKind",
        "files",
        "symbols",
        "symbolsByKind",
      ]
    `);
  });

  it('get_source shape', () => {
    const result = getSource(db, { file: 'src/cart.ts', start_line: 1, rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "context_after",
        "context_before",
        "end_line",
        "file",
        "found",
        "lines",
        "start_line",
      ]
    `);
    if (result.lines && result.lines.length > 0) {
      expect(Object.keys(result.lines[0]!).sort()).toMatchInlineSnapshot(`
        [
          "number",
          "text",
        ]
      `);
    }
  });

  it('call_hierarchy shape', () => {
    const result = callHierarchy(db, { name: 'Cart', direction: 'outgoing', rootDir: FIXTURE });
    const keys = Object.keys(result).sort().filter((k) => k !== 'truncated');
    expect(keys).toMatchInlineSnapshot(`
      [
        "direction",
        "max_depth",
        "query",
        "roots",
      ]
    `);
    if (result.roots.length > 0) {
      expect(Object.keys(result.roots[0]!).sort()).toMatchInlineSnapshot(`
        [
          "children",
          "depth",
          "symbol",
        ]
      `);
    }
  });

  it('find_imports shape', () => {
    const result = findImports(db, { module: './cart.js', rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "importers",
        "module",
        "total",
      ]
    `);
    if (result.importers.length > 0) {
      expect(Object.keys(result.importers[0]!).sort()).toMatchInlineSnapshot(`
        [
          "col",
          "file",
          "import_kind",
          "imported_name",
          "line",
          "local_name",
        ]
      `);
    }
  });

  it('index_status shape', () => {
    const result = indexStatus(db, { rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "drift",
        "file_count",
        "git_head",
        "indexing",
        "indexing_since",
        "last_indexed_at",
        "last_indexed_iso",
        "repo_root",
        "schema_version",
        "symbol_count",
        "tiers",
      ]
    `);
    expect(Object.keys(result.tiers).sort()).toMatchInlineSnapshot(`
      [
        "by_language",
        "tier1",
        "tier2",
        "tier3",
      ]
    `);
  });

  it('reindex_file shape', async () => {
    const writeDb = openDatabase({ path: dbPath });
    try {
      const result = await reindexFile(writeDb, { file: 'src/cart.ts', rootDir: FIXTURE });
      expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
        [
          "edge_count",
          "file",
          "language",
          "ok",
          "symbol_count",
        ]
      `);
    } finally {
      writeDb.close();
    }
  });

  it('list_files shape', () => {
    const result = listFiles(db, FIXTURE);
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "files",
      ]
    `);
    expect(result.files.length).toBeGreaterThan(0);
    expect(typeof result.files[0]).toBe('string');
  });

  it('semantic_search shape (no provider)', async () => {
    const result = await semanticSearchHandler(db, null, { query: 'cart', rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "available",
        "hint",
        "hits",
        "totalEmbedded",
      ]
    `);
  });

  it('hybrid_search shape (no provider)', async () => {
    const result = await hybridSearchHandler(db, null, { query: 'Cart', rootDir: FIXTURE });
    expect(Object.keys(result).sort()).toMatchInlineSnapshot(`
      [
        "hint",
        "hits",
        "stages",
      ]
    `);
  });
});
