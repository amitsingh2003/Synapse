import { relative, sep } from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import { Queries } from '../db/queries.js';
import type { ParseResult } from '../parser/extract.js';
import { getAdapterForFile } from '../languages/registry.js';
import { buildScipId } from '../resolver/scipId.js';

export interface WriteFileInput {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Repo root — used to compute the stored relative path. Required. */
  repoRoot: string;
  language: string;
  xxhash?: string | null;
  mtimeMs?: number | null;
  parsed: ParseResult;
  /** Raw source text — stored in file_content for FTS5 grep pre-filtering. */
  content?: string;
}

export interface WriteFileResult {
  fileId: number;
  symbolCount: number;
  edgeCount: number;
  importCount: number;
}

/**
 * Compute the repo-relative path used as the canonical key in `files.path`.
 * Always forward slashes regardless of platform.
 */
export function toRelPath(absolutePath: string, repoRoot: string): string {
  return relative(repoRoot, absolutePath).split(sep).join('/');
}

/**
 * Atomically (re)write all rows associated with a single source file.
 *
 * Phase 10: stores the repo-relative path (fwd slashes) in `files.path`
 * instead of the absolute path. This makes the DB portable across machines.
 */
export function writeFileToGraph(db: DB, q: Queries, input: WriteFileInput): WriteFileResult {
  const relPath = toRelPath(input.absolutePath, input.repoRoot);
  // Phase 12: per-symbol `language` is the adapter id (e.g. 'typescript'),
  // not the per-file sub-grammar tag stored on `files.language`.
  const symbolLanguage =
    getAdapterForFile(input.absolutePath)?.id ?? input.language;

  const fileId = q.upsertFileRow({
    path: relPath,
    language: input.language,
    xxhash: input.xxhash ?? null,
    mtime_ms: input.mtimeMs ?? null,
  });
  q.clearFile(fileId);
  if (input.content !== undefined) {
    q.upsertFileContent(fileId, input.content);
  }

  // Build a parent-chain name list per local index so we can mint a stable
  // scip id like `local src/cart.ts#Cart.addItem` on the fly.
  const nameChain: string[][] = [];
  const idMap = new Map<number, number>();
  // Track scip_ids already used in this file — duplicate names in the same scope
  // (e.g. two `const shutdown = () => {}` inside one function) get @line appended.
  const usedScipIds = new Set<string>();

  for (const sym of input.parsed.symbols) {
    const parentChain =
      sym.parentLocalIndex !== null && nameChain[sym.parentLocalIndex]
        ? nameChain[sym.parentLocalIndex]!
        : [];
    let chain = [...parentChain, sym.name];

    // Imports are file-scoped synthetic rows; don't pollute the scip namespace.
    let scipId = sym.kind === 'import' ? null : buildScipId(relPath, chain);

    if (scipId !== null && usedScipIds.has(scipId)) {
      const disambigName = `${sym.name}@${sym.start_line}`;
      chain = [...parentChain, disambigName];
      scipId = buildScipId(relPath, chain);
    }
    if (scipId !== null) usedScipIds.add(scipId);

    // Store the (possibly disambiguated) chain so children inherit it.
    nameChain[sym.localIndex] = chain;

    const parentId =
      sym.parentLocalIndex !== null ? (idMap.get(sym.parentLocalIndex) ?? null) : null;
    const realId = q.insertSymbol(fileId, {
      name: sym.name,
      kind: sym.kind,
      language: symbolLanguage,
      parent_id: parentId,
      scip_id: scipId,
      start_line: sym.start_line,
      end_line: sym.end_line,
      start_col: sym.start_col,
      end_col: sym.end_col,
      signature: sym.signature,
      doc: sym.doc,
    });
    idMap.set(sym.localIndex, realId);
  }

  for (const edge of input.parsed.edges) {
    const sourceId =
      edge.sourceLocalIndex !== null ? (idMap.get(edge.sourceLocalIndex) ?? null) : null;
    q.insertEdge(fileId, {
      source_id: sourceId,
      target_id: null,
      target_name: edge.target_name ?? null,
      kind: edge.kind,
      line: edge.line,
      col: edge.col,
    });
  }

  let extraEdges = 0;
  for (const imp of input.parsed.imports) {
    q.insertFileImport(fileId, {
      local_name: imp.localName,
      imported_name: imp.importedName,
      module_specifier: imp.moduleSpecifier,
      import_kind: imp.kind ?? 'value',
      line: imp.line,
      col: imp.col,
    });
    // Also emit a REFERENCES edge so "where is X used?" picks up the import
    // site itself. Default + namespace imports are skipped — they don't name
    // a concrete export we could match.
    if (imp.importedName !== 'default' && imp.importedName !== '*') {
      q.insertEdge(fileId, {
        source_id: null,
        target_id: null,
        target_name: imp.importedName,
        kind: 'REFERENCES',
        line: imp.line,
        col: imp.col,
      });
      extraEdges++;
    }
  }

  return {
    fileId,
    symbolCount: input.parsed.symbols.length,
    edgeCount: input.parsed.edges.length + extraEdges,
    importCount: input.parsed.imports.length,
  };
}
