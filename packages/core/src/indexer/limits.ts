/**
 * Phase 22.3 — Production safety limits.
 *
 * These caps prevent pathological inputs (generated 50k-line files, vendored
 * minified bundles that slipped past ignore rules, etc.) from blowing up
 * memory or DB write time.
 *
 * Tuning notes:
 *  - 2000 symbols/file covers >99% of real-world source files. Files that
 *    exceed it are nearly always generated artefacts.
 *  - 5000 edges/file is conservative; the largest legitimate hand-written
 *    files we've seen produce ~3000 CALLS edges.
 *
 * When a cap fires, the parser keeps the file in the index (it still appears
 * in `list_files`, `get_source`, full-text search) but truncates the symbol /
 * edge arrays. This is a quiet truncation — users can find affected files by
 * looking at `symbolCount` vs file size in `index_status`.
 */
export const MAX_SYMBOLS_PER_FILE = 2000;
export const MAX_EDGES_PER_FILE = 5000;

export interface CapResult {
  symbolsCapped: boolean;
  edgesCapped: boolean;
  originalSymbolCount: number;
  originalEdgeCount: number;
}

/**
 * Apply per-file caps to a `ParseResult`-shaped object. Returns whether
 * either cap fired so callers can log a warning. Mutates `parsed` in place.
 *
 * Edges whose `sourceLocalIndex` points past the truncated symbol range are
 * dropped so we never insert a dangling reference.
 */
export function applyParseCaps(parsed: {
  symbols: Array<{ localIndex: number; parentLocalIndex: number | null }>;
  edges: Array<{ sourceLocalIndex: number | null }>;
}): CapResult {
  const originalSymbolCount = parsed.symbols.length;
  const originalEdgeCount = parsed.edges.length;

  const symbolsCapped = originalSymbolCount > MAX_SYMBOLS_PER_FILE;
  if (symbolsCapped) {
    parsed.symbols.length = MAX_SYMBOLS_PER_FILE;
    // Drop any edge whose source symbol was truncated away.
    parsed.edges = parsed.edges.filter(
      (e) => e.sourceLocalIndex === null || e.sourceLocalIndex < MAX_SYMBOLS_PER_FILE,
    );
  }

  const edgesCapped = parsed.edges.length > MAX_EDGES_PER_FILE;
  if (edgesCapped) {
    parsed.edges.length = MAX_EDGES_PER_FILE;
  }

  return {
    symbolsCapped,
    edgesCapped,
    originalSymbolCount,
    originalEdgeCount,
  };
}
