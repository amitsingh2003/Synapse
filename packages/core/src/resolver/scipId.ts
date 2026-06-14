/**
 * Stable, deterministic symbol identifiers for cross-file resolution.
 *
 * Format (loosely inspired by sourcegraph/scip):
 *
 *     local <relPath>#<symbol-path>
 *
 * `symbol-path` is the chain of parent symbol names joined by `.`, e.g.
 * `Cart.addItem` for a method on a class. Top-level symbols have a single
 * segment, like `CartService`. The path is stable across runs as long as the
 * relative file path and parent chain don't change — perfect for the cheap
 * lookup tables we use in the resolver.
 */

/** Build a SCIP-style id for a symbol. */
export function buildScipId(relPath: string, symbolPath: readonly string[]): string {
  const tail = symbolPath.join('.');
  return `local ${normalizeRel(relPath)}#${tail}`;
}

/** Normalize a relative path to forward slashes (Windows safe). */
export function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}
