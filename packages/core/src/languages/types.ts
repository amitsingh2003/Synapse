import type Parser from 'web-tree-sitter';
import type { ParseResult } from '../parser/extract.js';

/**
 * Context passed to `LanguageAdapter.resolveModule` for cross-file lookups.
 * Phase 13: the resolver delegates per-language module resolution to the
 * adapter so non-TS languages can implement their own rules (Python dotted
 * paths, Go module paths, etc.).
 */
export interface ResolveCtx {
  /** Absolute repo root on disk. */
  root: string;
  /** Map of repo-relative path (fwd slashes) → file id. */
  filesByPath: ReadonlyMap<string, number>;
}

/**
 * Phase 12: a `LanguageAdapter` packages everything synapse needs to know
 * about one programming language into a single object:
 *
 *  - Which file extensions belong to it (`extensions`).
 *  - How to load the tree-sitter grammar (`loadGrammar`).
 *  - How to walk a parse tree and emit symbols/edges/imports (`parse`).
 *  - How to resolve a relative module specifier to a file id
 *    (`resolveModule` — optional; resolver falls back to TS-style when absent).
 *  - Which directories should be hard-skipped during discovery (`vendorDirs`).
 *
 * Phase 13 adds adapters for Python and Go alongside TypeScript.
 */
export interface LanguageAdapter {
  /** Stable, lowercase id. Stored in `symbols.language`. */
  readonly id: string;
  /** File extensions this adapter claims (lowercase, leading dot). */
  readonly extensions: readonly string[];
  /** Per-language "never descend" directory names (additive to global skip policy). */
  readonly vendorDirs: readonly string[];
  /** Extensions module resolution tries when joining a relative specifier. */
  readonly resolveExts: readonly string[];
  /** "Implicit index" filenames tried when a specifier resolves to a directory. */
  readonly indexFiles: readonly string[];
  /** Load (and cache) the tree-sitter grammar appropriate for `filePath`. */
  loadGrammar(filePath: string): Promise<Parser.Language>;
  /** Parse a source string and return symbols/edges/imports. */
  parse(source: string, filePath: string): Promise<ParseResult>;
  /**
   * Resolve a module specifier to a `files.path` key (repo-relative,
   * forward slashes). Return `null` when the specifier can't be matched to
   * an indexed file. `fromDir` is the repo-relative directory of the
   * importing file. When omitted, the resolver uses a TS-compatible default.
   */
  resolveModule?(spec: string, fromDir: string, ctx: ResolveCtx): string | null;
}
