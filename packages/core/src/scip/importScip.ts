/**
 * Phase 19.1 — SCIP import path.
 *
 * Ingests a SCIP index (JSON format) directly into the synapse database,
 * bypassing the tree-sitter walker for that language. This allows leveraging
 * more precise type information from scip-typescript / scip-python / scip-go.
 *
 * Expected input: JSON file conforming to the Sourcegraph SCIP schema.
 * See: https://sourcegraph.com/github.com/sourcegraph/scip/-/blob/scip.proto
 *
 * The JSON format has:
 * {
 *   "metadata": { "version": 1, "toolInfo": {...}, "projectRoot": "..." },
 *   "documents": [
 *     {
 *       "relativePath": "src/foo.ts",
 *       "occurrences": [{ "range": [line, charStart, charEnd], "symbol": "...", "symbolRoles": 1 }],
 *       "symbols": [{ "symbol": "...", "documentation": ["..."], "signatureDocumentation": {...} }]
 *     }
 *   ]
 * }
 */

import type { Database as DB } from 'better-sqlite3';
import { normalizeRel } from '../resolver/scipId.js';

// ─── SCIP JSON Schema Types ───────────────────────────────────────────────

export interface ScipIndex {
  metadata?: ScipMetadata;
  documents: ScipDocument[];
  externalSymbols?: ScipSymbolInfo[];
}

export interface ScipMetadata {
  version?: number;
  toolInfo?: { name: string; version?: string; arguments?: string[] };
  projectRoot?: string;
  textDocumentEncoding?: number;
}

export interface ScipDocument {
  relativePath: string;
  language?: string;
  occurrences?: ScipOccurrence[];
  symbols?: ScipSymbolInfo[];
}

export interface ScipOccurrence {
  range: number[];
  symbol?: string;
  symbolRoles?: number;
  syntaxKind?: number;
  overrideDocumentation?: string[];
  diagnostics?: unknown[];
}

export interface ScipSymbolInfo {
  symbol: string;
  documentation?: string[];
  relationships?: ScipRelationship[];
  signatureDocumentation?: { language?: string; text?: string };
  kind?: number;
}

export interface ScipRelationship {
  symbol: string;
  isReference?: boolean;
  isImplementation?: boolean;
  isTypeDefinition?: boolean;
  isDefinition?: boolean;
}

// SCIP symbol roles (bitmask).
const SCIP_ROLE_DEFINITION = 0x1;

// Map SCIP symbol kinds to our internal kinds.
const SCIP_KIND_MAP: Record<number, string> = {
  2: 'function',
  3: 'class',
  5: 'method',
  6: 'property',
  7: 'interface',
  8: 'type',
  10: 'variable',
  13: 'enum',
  14: 'enum_member',
  17: 'constructor',
  19: 'namespace',
};

// ─── Import Result ────────────────────────────────────────────────────────

export interface ScipImportResult {
  filesImported: number;
  symbolsImported: number;
  edgesCreated: number;
  skipped: number;
  durationMs: number;
}

export interface ScipImportOptions {
  /** Parsed SCIP index JSON data. */
  data: ScipIndex;
  /** Override language (otherwise inferred from SCIP metadata or file extension). */
  language?: string;
  /** If true, skip files that already exist in the DB. Default: false (overwrite). */
  skipExisting?: boolean;
}

// ─── Implementation ────────────────────────────────────────────────────────

/**
 * Parse a SCIP symbol string into its components.
 * SCIP symbols look like: `scip-typescript npm package 1.0.0 src/file.ts/ClassName#methodName.`
 * We extract the name and parent from the suffix.
 */
function parseScipSymbol(symbol: string): { name: string; parent: string | null } {
  // Remove the scheme prefix (e.g. "scip-typescript npm ...")
  const parts = symbol.split(' ');
  // The descriptor is the last space-separated part
  const descriptor = parts[parts.length - 1] ?? symbol;

  // Split by `/` and then by `#` and `.` to find name segments
  const segments: string[] = [];
  let current = '';
  for (const ch of descriptor) {
    if (ch === '/' || ch === '#' || ch === '.') {
      if (current) segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) segments.push(current);

  if (segments.length === 0) return { name: symbol, parent: null };
  const name = segments[segments.length - 1]!;
  const parent = segments.length > 1 ? segments[segments.length - 2]! : null;
  return { name, parent };
}

/**
 * Infer language from file extension.
 */
function inferLanguage(filePath: string): string {
  if (/\.tsx?$/.test(filePath)) return 'typescript';
  if (/\.jsx?$/.test(filePath)) return 'javascript';
  if (/\.py$/.test(filePath)) return 'python';
  if (/\.go$/.test(filePath)) return 'go';
  if (/\.rs$/.test(filePath)) return 'rust';
  if (/\.java$/.test(filePath)) return 'java';
  if (/\.kt$/.test(filePath)) return 'kotlin';
  if (/\.cs$/.test(filePath)) return 'csharp';
  return 'unknown';
}

/**
 * Import a SCIP JSON index into the synapse database.
 *
 * This replaces the tree-sitter parse step for the given files, providing
 * richer type-level data that SCIP tools produce.
 */
export function importScipIndex(db: DB, opts: ScipImportOptions): ScipImportResult {
  const t0 = Date.now();
  let filesImported = 0;
  let symbolsImported = 0;
  let edgesCreated = 0;
  let skipped = 0;

  const insertFile = db.prepare(`
    INSERT OR REPLACE INTO files (path, language, xxhash, indexed_at)
    VALUES (?, ?, 'scip-import', ?)
  `);

  const insertSymbol = db.prepare(`
    INSERT INTO symbols (scip_id, name, kind, language, parent_id, file_id, start_line, end_line, start_col, end_col, signature, doc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEdge = db.prepare(`
    INSERT INTO edges (source_id, target_id, target_name, kind, file_id, line, col)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const findFile = db.prepare('SELECT id FROM files WHERE path = ?');
  const findSymbol = db.prepare('SELECT id FROM symbols WHERE scip_id = ?');
  const deleteFileSymbols = db.prepare('DELETE FROM symbols WHERE file_id = ?');
  const deleteFileEdges = db.prepare('DELETE FROM edges WHERE file_id = ?');

  const importAll = db.transaction(() => {
    for (const doc of opts.data.documents) {
      const relPath = normalizeRel(doc.relativePath);
      const lang = opts.language ?? doc.language ?? inferLanguage(relPath);

      // Check if file exists.
      const existing = findFile.get(relPath) as { id: number } | undefined;
      if (existing && opts.skipExisting) {
        skipped++;
        continue;
      }

      // Upsert file.
      insertFile.run(relPath, lang, Date.now());
      const fileRow = findFile.get(relPath) as { id: number };
      const fileId = fileRow.id;

      // Clear old data for this file.
      deleteFileEdges.run(fileId);
      deleteFileSymbols.run(fileId);

      // Build symbol info map.
      const symbolInfoMap = new Map<string, ScipSymbolInfo>();
      if (doc.symbols) {
        for (const si of doc.symbols) {
          symbolInfoMap.set(si.symbol, si);
        }
      }

      // First pass: insert definition occurrences as symbols.
      const symbolIdMap = new Map<string, number>(); // scip symbol → our DB id
      const parentCandidates = new Map<string, number>(); // name → symbol id (for parent linkage)

      if (doc.occurrences) {
        for (const occ of doc.occurrences) {
          if (!occ.symbol) continue;
          const isDefinition = (occ.symbolRoles ?? 0) & SCIP_ROLE_DEFINITION;
          if (!isDefinition) continue;

          const { name, parent } = parseScipSymbol(occ.symbol);
          const info = symbolInfoMap.get(occ.symbol);
          const kind = info?.kind ? (SCIP_KIND_MAP[info.kind] ?? 'variable') : 'variable';
          const doc_text = info?.documentation?.join('\n') ?? null;
          const sig = info?.signatureDocumentation?.text ?? null;

          const line = occ.range[0] ?? 0;
          const col = occ.range.length >= 4 ? occ.range[1]! : 0;
          const endLine = occ.range.length >= 4 ? occ.range[2]! : line;
          const endCol = occ.range.length >= 4 ? occ.range[3]! : (occ.range[2] ?? col);

          // Resolve parent.
          let parentId: number | null = null;
          if (parent) {
            parentId = parentCandidates.get(parent) ?? null;
          }

          const scipId = `scip ${relPath}#${name}`;

          try {
            const result = insertSymbol.run(
              scipId, name, kind, lang, parentId, fileId,
              line, endLine, col, endCol, sig, doc_text,
            );
            const symId = Number(result.lastInsertRowid);
            symbolIdMap.set(occ.symbol, symId);
            parentCandidates.set(name, symId);
            symbolsImported++;
          } catch {
            // Duplicate scip_id — skip.
            const existing = findSymbol.get(scipId) as { id: number } | undefined;
            if (existing) {
              symbolIdMap.set(occ.symbol, existing.id);
              parentCandidates.set(name, existing.id);
            }
          }
        }
      }

      // Second pass: insert reference occurrences as edges.
      if (doc.occurrences) {
        for (const occ of doc.occurrences) {
          if (!occ.symbol) continue;
          const isDefinition = (occ.symbolRoles ?? 0) & SCIP_ROLE_DEFINITION;
          if (isDefinition) continue;

          const targetId = symbolIdMap.get(occ.symbol) ?? null;
          const { name: targetName } = parseScipSymbol(occ.symbol);
          const line = occ.range[0] ?? 0;
          const col = occ.range.length >= 4 ? occ.range[1]! : 0;

          // Find the closest definition in this file as source.
          // Heuristic: find the definition with the closest preceding line.
          let sourceId: number | null = null;
          // For now, reference edges with null source are still useful.

          try {
            insertEdge.run(sourceId, targetId, targetName, 'REFERENCES', fileId, line, col);
            edgesCreated++;
          } catch {
            // Skip on constraint violations
          }
        }
      }

      // Process relationships (extends, implements).
      if (doc.symbols) {
        for (const si of doc.symbols) {
          const sourceDbId = symbolIdMap.get(si.symbol);
          if (!sourceDbId || !si.relationships) continue;
          for (const rel of si.relationships) {
            const targetDbId = symbolIdMap.get(rel.symbol) ?? null;
            const { name: targetName } = parseScipSymbol(rel.symbol);
            let kind = 'REFERENCES';
            if (rel.isImplementation) kind = 'IMPLEMENTS';
            else if (rel.isTypeDefinition) kind = 'EXTENDS';
            try {
              insertEdge.run(sourceDbId, targetDbId, targetName, kind, fileId, 0, 0);
              edgesCreated++;
            } catch {
              // Skip duplicates
            }
          }
        }
      }

      filesImported++;
    }
  });

  importAll();

  return {
    filesImported,
    symbolsImported,
    edgesCreated,
    skipped,
    durationMs: Date.now() - t0,
  };
}
