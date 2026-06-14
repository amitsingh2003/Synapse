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
  MCP_SERVER_VERSION,
  createSynapseServer,
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
  exploreSymbol,
  detectCycles,
  topSymbols,
  verifySymbol,
  readOffloaded,
  maybeOffload,
} from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'fixtures', 'sample-shopping-app');

let dbDir: string;
let dbPath: string;
let db: DB;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'cg-mcp-'));
  dbPath = join(dbDir, 'graph.db');
  db = openDatabase({ path: dbPath });
  await indexRepo(db, { root: FIXTURE, concurrency: 2 });
  resolveReferences(db, { root: FIXTURE });
  db.close();
  db = openDatabase({ path: dbPath, readonly: true });
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dbDir, { recursive: true, force: true });
});

describe('@synapse/mcp-server', () => {
  it('exposes a semver version string', () => {
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('find_symbol returns matching definitions', () => {
    const { symbols } = findSymbol(db, { name: 'Cart', rootDir: FIXTURE });
    const cart = symbols.find((s) => s.kind === 'class' && s.name === 'Cart');
    expect(cart).toBeDefined();
    expect(cart!.file).not.toMatch(/^[A-Z]:/); // path is relative to FIXTURE
  });

  it('find_references returns incoming edges resolved by Phase 3', () => {
    const { results } = findReferences(db, { name: 'addItem', rootDir: FIXTURE });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const total = results.reduce((n, r) => n + r.references.length, 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('get_definition returns the primary definition', () => {
    const def = getDefinition(db, { name: 'CartService', rootDir: FIXTURE });
    expect(def.found).toBe(true);
    expect(def.symbol!.kind).toBe('class');
    expect(def.symbol!.name).toBe('CartService');
  });

  it('get_definition returns found=false for unknown names', () => {
    const def = getDefinition(db, { name: '__nope_no_such_symbol__' });
    expect(def.found).toBe(false);
  });

  it('createSynapseServer registers the three tools', () => {
    const handle = createSynapseServer({ dbPath, rootDir: FIXTURE });
    try {
      // The McpServer keeps tools on an internal map; just assert the
      // public `server` object is wired and connect() exists.
      expect(typeof handle.server.connect).toBe('function');
      expect(typeof handle.close).toBe('function');
    } finally {
      handle.close();
    }
  });

  // ----- Phase 7 tools ------------------------------------------------------

  it('search_symbols finds by substring (case-insensitive)', () => {
    const { symbols } = searchSymbols(db, { query: 'cart', rootDir: FIXTURE });
    const names = symbols.map((s) => s.name);
    expect(names).toContain('Cart');
    expect(names).toContain('CartService');
  });

  it('search_symbols supports * wildcards', () => {
    const { symbols } = searchSymbols(db, { query: 'add*', rootDir: FIXTURE });
    expect(symbols.some((s) => s.name === 'addItem')).toBe(true);
    expect(symbols.some((s) => s.name === 'addProduct')).toBe(true);
  });

  it('list_symbols_in_file returns every symbol in a file (relative path)', () => {
    const result = listSymbolsInFile(db, { file: 'src/cart.ts', rootDir: FIXTURE });
    expect(result.found).toBe(true);
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('Cart');
    expect(names).toContain('addItem');
  });

  it('list_symbols_in_file returns found=false for unknown files', () => {
    const result = listSymbolsInFile(db, { file: 'src/nope.ts', rootDir: FIXTURE });
    expect(result.found).toBe(false);
    expect(result.symbols).toEqual([]);
  });

  it('outgoing_calls returns resolved callees for addProduct', () => {
    // Edges are attributed to method symbols, not the containing class.
    // addProduct() calls cart.addItem() — check at the method level.
    const { results } = outgoingCalls(db, { name: 'addProduct', rootDir: FIXTURE });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const allEdges = results.flatMap((r) => r.outgoing);
    expect(allEdges.some((e) => e.to_name === 'addItem')).toBe(true);
  });

  it('get_stats returns sane aggregate counts', () => {
    const s = getStats(db);
    expect(s.files).toBeGreaterThanOrEqual(4);
    expect(s.symbols).toBeGreaterThan(0);
    expect(s.edges).toBeGreaterThan(0);
    expect(s.dbSizeBytes).toBeGreaterThan(0);
    expect(Object.keys(s.symbolsByKind).length).toBeGreaterThan(0);
  });

  it('tool errors come back as isError instead of crashing (Phase 8)', async () => {
    const errors: { tool: string; msg: string }[] = [];
    const handle = createSynapseServer({
      dbPath,
      rootDir: FIXTURE,
      onError: (tool, err) => errors.push({ tool, msg: err.message }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registered: any = (handle.server as any)._registeredTools;
    const tool = registered['find_symbol'];
    expect(tool).toBeDefined();
    expect(typeof tool.handler).toBe('function');

    // Close the DB first so any query throws — proves the wrapper turns the
    // throw into a graceful isError response instead of crashing.
    handle.close();

    const out = await tool.handler({ name: 'Cart' }, {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('[find_symbol]');
    expect(errors.length).toBe(1);
    expect(errors[0]!.tool).toBe('find_symbol');
  });

  // Phase 9 tests ---------------------------------------------------------

  it('search_symbols escapes LIKE wildcards (Phase 9)', async () => {
    const handle = createSynapseServer({ dbPath, rootDir: FIXTURE });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools: any = (handle.server as any)._registeredTools;
      const out = await tools['search_symbols'].handler({ query: '%_test' }, {});
      // Must not crash and must not return all symbols
      const parsed = JSON.parse(out.content[0].text);
      expect(parsed.total).toBe(0); // no symbol contains literal %_test
    } finally {
      handle.close();
    }
  });

  it('search_symbols rejects queries shorter than 2 chars (Phase 9)', async () => {
    const handle = createSynapseServer({ dbPath, rootDir: FIXTURE });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools: any = (handle.server as any)._registeredTools;
      const out = await tools['search_symbols'].handler({ query: 'a' }, {});
      const parsed = JSON.parse(out.content[0].text);
      expect(parsed.total).toBe(0);
      expect(parsed.hint).toContain('at least 2');
    } finally {
      handle.close();
    }
  });

  it('find_symbol returns a hint on empty result (Phase 9)', async () => {
    const handle = createSynapseServer({ dbPath, rootDir: FIXTURE });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools: any = (handle.server as any)._registeredTools;
      const out = await tools['find_symbol'].handler({ name: 'CartSerivce' }, {});
      const parsed = JSON.parse(out.content[0].text);
      expect(parsed.total).toBe(0);
      expect(parsed.hint).toBeDefined();
      expect(typeof parsed.hint).toBe('string');
    } finally {
      handle.close();
    }
  });

  // ----- Phase 15 tools -----------------------------------------------------

  it('get_source reads a file slice with surrounding context (15.1)', () => {
    const res = getSource(db, {
      file: 'src/cart.ts',
      start_line: 3,
      end_line: 3,
      context: 1,
      rootDir: FIXTURE,
    });
    expect(res.found).toBe(true);
    expect(res.file).toBe('src/cart.ts');
    expect(res.lines && res.lines.length).toBeGreaterThanOrEqual(2);
    // Line 3 should be the CartLine interface declaration in the fixture
    const line3 = res.lines!.find((l) => l.number === 3);
    expect(line3?.text).toContain('CartLine');
  });

  it('get_source returns found=false for missing files', () => {
    const res = getSource(db, { file: 'src/does-not-exist.ts', start_line: 1, rootDir: FIXTURE });
    expect(res.found).toBe(false);
    expect(res.hint).toContain('not found');
  });

  it('get_source rejects paths that escape rootDir', () => {
    const res = getSource(db, { file: '../../../../../etc/hosts', start_line: 1, rootDir: FIXTURE });
    // Either path doesn't resolve to file, or sandbox blocks it — both are "not found".
    expect(res.found).toBe(false);
  });

  it('call_hierarchy(outgoing) returns a tree rooted at the named symbol (15.2)', () => {
    const res = callHierarchy(db, { name: 'CartService', direction: 'outgoing', depth: 2, rootDir: FIXTURE });
    expect(res.roots.length).toBeGreaterThan(0);
    expect(res.direction).toBe('outgoing');
    expect(res.max_depth).toBe(2);
    expect(res.roots[0]!.symbol.name).toBe('CartService');
  });

  it('call_hierarchy(incoming) finds callers transitively', () => {
    const res = callHierarchy(db, { name: 'Cart', direction: 'incoming', depth: 2, rootDir: FIXTURE });
    expect(res.direction).toBe('incoming');
    expect(res.roots.length).toBeGreaterThan(0);
  });

  it('call_hierarchy returns hint for unknown names', () => {
    const res = callHierarchy(db, { name: 'NoSuchSymbol_xyzzy', rootDir: FIXTURE });
    expect(res.roots.length).toBe(0);
    expect(res.hint).toBeDefined();
  });

  it('find_imports lists files importing a module specifier (15.3)', () => {
    const res = findImports(db, { module: './cart.js', rootDir: FIXTURE });
    expect(res.total).toBeGreaterThan(0);
    expect(res.importers.some((i) => i.file.includes('cartService.ts'))).toBe(true);
    expect(res.importers[0]!.import_kind).toMatch(/value|type/);
  });

  it('find_imports returns hint when module is not imported anywhere', () => {
    const res = findImports(db, { module: 'nonexistent-package-xyzzy', rootDir: FIXTURE });
    expect(res.total).toBe(0);
    expect(res.hint).toBeDefined();
  });

  it('index_status reports schema version + file/symbol counts (15.4)', () => {
    const res = indexStatus(db, { rootDir: FIXTURE });
    expect(res.schema_version).toBeGreaterThanOrEqual(5);
    expect(res.file_count).toBeGreaterThan(0);
    expect(res.symbol_count).toBeGreaterThan(0);
    expect(res.last_indexed_at).toBeGreaterThan(0);
    expect(res.drift).not.toBeNull();
  });

  it('index_status reports tier breakdown (22.4)', () => {
    const res = indexStatus(db, { rootDir: FIXTURE });
    expect(res.tiers).toBeDefined();
    expect(typeof res.tiers.tier1).toBe('number');
    expect(typeof res.tiers.tier2).toBe('number');
    expect(typeof res.tiers.tier3).toBe('number');
    // Fixture is TypeScript → tier 1 must be the dominant bucket.
    expect(res.tiers.tier1 + res.tiers.tier2 + res.tiers.tier3).toBe(res.file_count);
    expect(res.tiers.tier1).toBeGreaterThan(0);
    // by_language entries report tier per language.
    for (const [lang, info] of Object.entries(res.tiers.by_language)) {
      expect([1, 2, 3]).toContain(info.tier);
      expect(info.files).toBeGreaterThan(0);
      expect(typeof lang).toBe('string');
    }
  });

  it('reindex_file refuses on a readonly DB connection (15.5)', async () => {
    const res = await reindexFile(db, { file: 'src/cart.ts', rootDir: FIXTURE });
    expect(res.ok).toBe(false);
    expect(res.hint).toContain('writable');
  });

  it('reindex_file works against a writable handle (15.5)', async () => {
    const wdb = openDatabase({ path: dbPath });
    try {
      // Use product.ts — it has no incoming cross-file call edges, so reindexing
      // it without resolve:true won't invalidate edges tested later in this suite.
      const res = await reindexFile(wdb, { file: 'src/product.ts', rootDir: FIXTURE, resolve: false });
      expect(res.ok).toBe(true);
      expect(res.file).toBe('src/product.ts');
      expect(res.symbol_count).toBeGreaterThan(0);
    } finally {
      wdb.close();
    }
  });

  it('search_symbols filters by kind (15.6)', () => {
    const res = searchSymbols(db, { query: 'Cart', kind: 'class', rootDir: FIXTURE });
    expect(res.symbols.length).toBeGreaterThan(0);
    expect(res.symbols.every((s) => s.kind === 'class')).toBe(true);
  });

  it('search_symbols filters by file_glob (15.6)', () => {
    const res = searchSymbols(db, { query: 'Cart', file_glob: '*cartService*', rootDir: FIXTURE });
    expect(res.symbols.length).toBeGreaterThan(0);
    expect(res.symbols.every((s) => s.file.includes('cartService'))).toBe(true);
  });

  it('search_symbols suggests fuzzy alternatives when nothing matches (15.7)', () => {
    const res = searchSymbols(db, { query: 'CartSerivce', rootDir: FIXTURE });
    expect(res.total).toBe(0);
    expect(res.hint).toBeDefined();
    expect(res.hint!.toLowerCase()).toContain('did you mean');
  });

  it('createSynapseServer registers all Phase 15 tools', () => {
    const handle = createSynapseServer({ dbPath, rootDir: FIXTURE });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools: any = (handle.server as any)._registeredTools;
      for (const name of ['get_source', 'call_hierarchy', 'find_imports', 'index_status', 'reindex_file']) {
        expect(tools[name]).toBeDefined();
      }
    } finally {
      handle.close();
    }
  });

  it('exposes synapse:// resources (15.9)', async () => {
    const handle = createSynapseServer({ dbPath, rootDir: FIXTURE });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resources: any = (handle.server as any)._registeredResources;
      expect(resources['synapse://stats']).toBeDefined();
      expect(resources['synapse://files']).toBeDefined();
      expect(resources['synapse://status']).toBeDefined();
      // Drive the stats resource end-to-end:
      const out = await resources['synapse://stats'].readCallback(new URL('synapse://stats'), {});
      const json = JSON.parse(out.contents[0].text);
      expect(json.fileCount ?? json.files ?? json.file_count).toBeDefined();
    } finally {
      handle.close();
    }
  });

  it('listFiles returns indexed files for the resource (15.9)', () => {
    const res = listFiles(db, FIXTURE);
    expect(res.files.length).toBeGreaterThan(0);
    expect(res.files.some((f) => f.endsWith('cart.ts'))).toBe(true);
  });

  // ─── Phase 23 ─────────────────────────────────────────────────────────────

  it('explore_symbol returns source + callers + callees (23.1)', () => {
    // Use addItem which has a resolved caller (addProduct → addItem).
    const res = exploreSymbol(db, { name: 'addItem', rootDir: FIXTURE });
    expect(res.found).toBe(true);
    expect(res.symbol).toBeDefined();
    expect(res.symbol!.name).toBe('addItem');
    expect(res.source).toBeDefined();
    expect(res.source!.length).toBeGreaterThan(10);
    // addProduct calls addItem → addItem should have at least one caller
    expect(res.callers.length).toBeGreaterThan(0);
  });

  it('explore_symbol returns hint for unknown symbols (23.1)', () => {
    const res = exploreSymbol(db, { name: 'NonExistentFooBar', rootDir: FIXTURE });
    expect(res.found).toBe(false);
    expect(res.hint).toBeDefined();
  });

  it('detect_cycles reports import cycles or acyclic hint (23.4)', () => {
    const res = detectCycles(db, { rootDir: FIXTURE });
    // Fixture may or may not have cycles; check shape.
    expect(res.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.cycles)).toBe(true);
    if (res.total === 0) {
      expect(res.hint).toContain('acyclic');
    } else {
      expect(res.cycles[0]!.path.length).toBeGreaterThan(1);
    }
  });

  it('top_symbols returns most-connected symbols (23.4)', () => {
    const res = topSymbols(db, { limit: 5, rootDir: FIXTURE });
    expect(res.symbols.length).toBeGreaterThan(0);
    expect(res.symbols.length).toBeLessThanOrEqual(5);
    expect(res.total_symbols).toBeGreaterThan(0);
    // Sorted by score descending.
    for (let i = 1; i < res.symbols.length; i++) {
      expect(res.symbols[i - 1]!.score).toBeGreaterThanOrEqual(res.symbols[i]!.score);
    }
  });

  it('verify_symbol confirms known symbols (23.6)', () => {
    const res = verifySymbol(db, { name: 'Cart', rootDir: FIXTURE });
    expect(res.verified).toBe(true);
    expect(res.confidence).toBeGreaterThanOrEqual(0.6);
    expect(res.checks.symbol_exists).toBe(true);
  });

  it('verify_symbol rejects non-existent symbols (23.6)', () => {
    const res = verifySymbol(db, { name: 'CompletelyMadeUp', rootDir: FIXTURE });
    expect(res.verified).toBe(false);
    expect(res.confidence).toBe(0);
  });

  it('maybeOffload returns null for small payloads (23.3)', () => {
    expect(maybeOffload('hello')).toBeNull();
  });

  it('maybeOffload + readOffloaded round-trips (23.3)', () => {
    const bigPayload = 'x'.repeat(10000);
    const offloaded = maybeOffload(bigPayload);
    expect(offloaded).not.toBeNull();
    expect(offloaded!.offloaded).toBe(true);
    expect(offloaded!.size_bytes).toBe(10000);
    const readResult = readOffloaded({ token: offloaded!.token });
    expect(readResult.found).toBe(true);
    expect(readResult.content).toBe(bigPayload);
  });

  it('createSynapseServer registers Phase 23 tools', () => {
    const handle = createSynapseServer({ dbPath, rootDir: FIXTURE });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools: any = (handle.server as any)._registeredTools;
      for (const name of ['explore_symbol', 'detect_cycles', 'top_symbols', 'verify_symbol', 'read_offloaded']) {
        expect(tools[name], `tool "${name}" should be registered`).toBeDefined();
      }
    } finally {
      handle.close();
    }
  });
});
