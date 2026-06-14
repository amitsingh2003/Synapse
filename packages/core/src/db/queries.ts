import type { Database as DB } from 'better-sqlite3';

/**
 * Phase 12: `SymbolKind` is a superset that covers every language an adapter
 * may emit. Existing TS/JS kinds remain; new kinds (`struct`, `module`,
 * `trait`, `macro`, `package`, `constant`, `field`, `namespace`) are
 * additive so old DBs and old code keep working.
 */
export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'import'
  | 'export'
  | 'jsx_component'
  | 'struct'
  | 'module'
  | 'trait'
  | 'macro'
  | 'package'
  | 'constant'
  | 'field'
  | 'namespace';

export type EdgeKind = 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'REFERENCES';

export interface FileRow {
  id: number;
  path: string;
  language: string;
  xxhash: string | null;
  mtime_ms: number | null;
  indexed_at: number;
}

export interface SymbolRow {
  id: number;
  scip_id: string | null;
  name: string;
  kind: SymbolKind;
  language: string | null;
  parent_id: number | null;
  file_id: number;
  start_line: number;
  end_line: number;
  start_col: number;
  end_col: number;
  signature: string | null;
  doc: string | null;
}

export interface EdgeRow {
  id: number;
  source_id: number | null;
  target_id: number | null;
  target_name: string | null;
  kind: EdgeKind;
  file_id: number;
  line: number;
  col: number;
}

export interface NewSymbol {
  name: string;
  kind: SymbolKind;
  /** Adapter id (e.g. 'typescript'). Optional — left NULL for legacy rows. */
  language?: string | null;
  parent_id?: number | null;
  scip_id?: string | null;
  start_line: number;
  end_line: number;
  start_col: number;
  end_col: number;
  signature?: string | null;
  doc?: string | null;
}

export interface NewEdge {
  source_id?: number | null;
  target_id?: number | null;
  target_name?: string | null;
  kind: EdgeKind;
  line: number;
  col: number;
}

export interface NewFileImport {
  local_name: string;
  imported_name: string;
  module_specifier: string;
  /** Phase 14: 'type' for `import type` / `export type` rows, else 'value'. */
  import_kind?: 'value' | 'type';
  line: number;
  col: number;
}

export interface FileImportRow {
  id: number;
  file_id: number;
  local_name: string;
  imported_name: string;
  module_specifier: string;
  resolved_file_id: number | null;
  import_kind: 'value' | 'type';
  line: number;
  col: number;
}

/** Reusable prepared-statement bundle, scoped to one open DB. */
export class Queries {
  private readonly upsertFile;
  private readonly deleteSymbolsForFile;
  private readonly deleteEdgesForFile;
  private readonly deleteFileImportsForFile;
  private readonly insertSymbolStmt;
  private readonly insertEdgeStmt;
  private readonly insertFileImportStmt;
  private readonly findSymbolByName;
  private readonly listSymbolsInFile;
  private readonly findFileByPath;
  private readonly listFileImports;
  private readonly setFileImportResolved;
  private readonly setEdgeTarget;
  private readonly nullifyIncomingEdgesForFile;
  private readonly upsertFileContentStmt;
  private readonly clearFileContentStmt;
  private readonly getFileContentStmt;

  constructor(private readonly db: DB) {
    this.upsertFile = db.prepare(`
      INSERT INTO files (path, language, xxhash, mtime_ms, indexed_at)
      VALUES (@path, @language, @xxhash, @mtime_ms, @indexed_at)
      ON CONFLICT(path) DO UPDATE SET
        language   = excluded.language,
        xxhash     = excluded.xxhash,
        mtime_ms   = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
      RETURNING id
    `);

    this.deleteSymbolsForFile = db.prepare(`DELETE FROM symbols WHERE file_id = ?`);
    this.deleteEdgesForFile = db.prepare(`DELETE FROM edges WHERE file_id = ?`);
    this.deleteFileImportsForFile = db.prepare(`DELETE FROM file_imports WHERE file_id = ?`);

    this.insertSymbolStmt = db.prepare(`
      INSERT INTO symbols (name, kind, language, parent_id, scip_id, file_id,
                           start_line, end_line, start_col, end_col,
                           signature, doc)
      VALUES (@name, @kind, @language, @parent_id, @scip_id, @file_id,
              @start_line, @end_line, @start_col, @end_col,
              @signature, @doc)
    `);

    this.insertEdgeStmt = db.prepare(`
      INSERT INTO edges (source_id, target_id, target_name, kind, file_id, line, col)
      VALUES (@source_id, @target_id, @target_name, @kind, @file_id, @line, @col)
    `);

    this.insertFileImportStmt = db.prepare(`
      INSERT INTO file_imports (file_id, local_name, imported_name, module_specifier,
                                resolved_file_id, import_kind, line, col)
      VALUES (@file_id, @local_name, @imported_name, @module_specifier, NULL, @import_kind, @line, @col)
    `);

    this.findSymbolByName = db.prepare(`
      SELECT s.*, f.path AS file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.name = ?
      ORDER BY s.kind, f.path, s.start_line
      LIMIT ?
    `);

    this.listSymbolsInFile = db.prepare(`
      SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line
    `);

    this.findFileByPath = db.prepare(`SELECT * FROM files WHERE path = ?`);

    this.listFileImports = db.prepare(`SELECT * FROM file_imports WHERE file_id = ?`);

    this.setFileImportResolved = db.prepare(
      `UPDATE file_imports SET resolved_file_id = ? WHERE id = ?`,
    );

    this.setEdgeTarget = db.prepare(`UPDATE edges SET target_id = ? WHERE id = ?`);

    // When a file is re-indexed, edges in OTHER files that point to its symbols
    // must have their target_id nulled out BEFORE the symbols are deleted.
    // Without this, the ON DELETE CASCADE on edges.target_id silently destroys
    // those cross-file edges and the resolver can never recover them.
    this.nullifyIncomingEdgesForFile = db.prepare(`
      UPDATE edges SET target_id = NULL
      WHERE file_id != ? AND target_id IN (SELECT id FROM symbols WHERE file_id = ?)
    `);

    this.upsertFileContentStmt = db.prepare(`
      INSERT INTO file_content(file_id, content) VALUES(?, ?)
      ON CONFLICT(file_id) DO UPDATE SET content = excluded.content
    `);
    this.clearFileContentStmt = db.prepare(`DELETE FROM file_content WHERE file_id = ?`);
    this.getFileContentStmt = db.prepare(`SELECT content FROM file_content WHERE file_id = ?`);
  }
  /** Insert-or-update the file row and return its id. */
  upsertFileRow(input: {
    path: string;
    language: string;
    xxhash?: string | null;
    mtime_ms?: number | null;
  }): number {
    const row = this.upsertFile.get({
      path: input.path,
      language: input.language,
      xxhash: input.xxhash ?? null,
      mtime_ms: input.mtime_ms ?? null,
      indexed_at: Date.now(),
    }) as { id: number };
    return row.id;
  }

  insertSymbol(fileId: number, sym: NewSymbol): number {
    const info = this.insertSymbolStmt.run({
      name: sym.name,
      kind: sym.kind,
      language: sym.language ?? null,
      parent_id: sym.parent_id ?? null,
      scip_id: sym.scip_id ?? null,
      file_id: fileId,
      start_line: sym.start_line,
      end_line: sym.end_line,
      start_col: sym.start_col,
      end_col: sym.end_col,
      signature: sym.signature ?? null,
      doc: sym.doc ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  insertEdge(fileId: number, edge: NewEdge): number {
    const info = this.insertEdgeStmt.run({
      source_id: edge.source_id ?? null,
      target_id: edge.target_id ?? null,
      target_name: edge.target_name ?? null,
      kind: edge.kind,
      file_id: fileId,
      line: edge.line,
      col: edge.col,
    });
    return Number(info.lastInsertRowid);
  }

  insertFileImport(fileId: number, imp: NewFileImport): number {
    const info = this.insertFileImportStmt.run({
      file_id: fileId,
      local_name: imp.local_name,
      imported_name: imp.imported_name,
      module_specifier: imp.module_specifier,
      import_kind: imp.import_kind ?? 'value',
      line: imp.line,
      col: imp.col,
    });
    return Number(info.lastInsertRowid);
  }

  /** Wipe all symbols + edges + import bindings belonging to a file. */
  clearFile(fileId: number): void {
    // Null out target_id on edges from OTHER files that point into this file's symbols.
    // Must run before deleteSymbolsForFile so the ON DELETE CASCADE doesn't destroy them.
    this.nullifyIncomingEdgesForFile.run(fileId, fileId);
    this.deleteEdgesForFile.run(fileId);
    this.deleteFileImportsForFile.run(fileId);
    this.deleteSymbolsForFile.run(fileId);
  }

  searchByName(name: string, limit = 50): (SymbolRow & { file_path: string })[] {
    return this.findSymbolByName.all(name, limit) as (SymbolRow & { file_path: string })[];
  }

  symbolsInFile(fileId: number): SymbolRow[] {
    return this.listSymbolsInFile.all(fileId) as SymbolRow[];
  }

  fileByPath(path: string): FileRow | undefined {
    return this.findFileByPath.get(path) as FileRow | undefined;
  }

  fileImports(fileId: number): FileImportRow[] {
    return this.listFileImports.all(fileId) as FileImportRow[];
  }

  setImportResolved(importId: number, resolvedFileId: number | null): void {
    this.setFileImportResolved.run(resolvedFileId, importId);
  }

  setEdgeTargetId(edgeId: number, targetId: number | null): void {
    this.setEdgeTarget.run(targetId, edgeId);
  }

  /**
   * All edges that point AT this symbol (incoming). Joins back to the source
   * symbol + source file so callers can render a nice "X is used in Y:Z" list.
   */
  incomingEdges(targetId: number): IncomingEdge[] {
    return this.db
      .prepare(
        `SELECT
           e.id, e.kind, e.line, e.col,
           e.source_id, e.file_id,
           src.name     AS source_name,
           src.kind     AS source_kind,
           sf.path      AS source_file_path,
           src.start_line AS source_line,
           src.end_line   AS source_end_line,
           src.signature  AS source_signature,
           f.path AS file_path
         FROM edges e
         JOIN files f ON e.file_id = f.id
         LEFT JOIN symbols src ON e.source_id = src.id
         LEFT JOIN files   sf  ON src.file_id  = sf.id
         WHERE e.target_id = ?
         ORDER BY f.path, e.line`,
      )
      .all(targetId) as IncomingEdge[];
  }

  /**
   * All edges that emanate FROM this symbol (outgoing). Joins to the target
   * symbol when resolved, otherwise returns the raw target_name string.
   */
  outgoingEdges(sourceId: number): OutgoingEdge[] {
    return this.db
      .prepare(
        `SELECT
           e.id, e.kind, e.line, e.col,
           e.target_id, e.target_name, e.file_id,
           tgt.name       AS target_resolved_name,
           tgt.kind       AS target_kind,
           tf.path        AS target_file_path,
           tgt.start_line AS target_line,
           tgt.end_line   AS target_end_line,
           tgt.signature  AS target_signature,
           f.path AS file_path
         FROM edges e
         JOIN files f ON e.file_id = f.id
         LEFT JOIN symbols tgt ON e.target_id = tgt.id
         LEFT JOIN files   tf  ON tgt.file_id  = tf.id
         WHERE e.source_id = ?
         ORDER BY e.line, e.col`,
      )
      .all(sourceId) as OutgoingEdge[];
  }

  /** Substring search over symbol names (case-insensitive). */
  searchByNameLike(
    pattern: string,
    limit = 50,
  ): (SymbolRow & { file_path: string })[] {
    return this.db
      .prepare(
        `SELECT s.*, f.path AS file_path
         FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE s.name LIKE ? ESCAPE '\\' COLLATE NOCASE
         ORDER BY length(s.name), s.name, f.path, s.start_line
         LIMIT ?`,
      )
      .all(pattern, limit) as (SymbolRow & { file_path: string })[];
  }

  /** Symbols defined in a file with the file's own path joined in. */
  symbolsInFileWithPath(
    fileId: number,
  ): (SymbolRow & { file_path: string })[] {
    return this.db
      .prepare(
        `SELECT s.*, f.path AS file_path
         FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE s.file_id = ?
         ORDER BY s.start_line`,
      )
      .all(fileId) as (SymbolRow & { file_path: string })[];
  }

  /**
   * Phase 15.3 — every file that imports a given module specifier (exact
   * match). Returned rows include the importing file path, the local name
   * bound, the imported name, and whether it was a type-only import.
   */
  fileImportsByModule(
    moduleSpecifier: string,
    limit = 200,
  ): {
    file_path: string;
    local_name: string;
    imported_name: string;
    import_kind: 'value' | 'type';
    line: number;
    col: number;
  }[] {
    return this.db
      .prepare(
        `SELECT f.path AS file_path,
                fi.local_name, fi.imported_name, fi.import_kind,
                fi.line, fi.col
         FROM file_imports fi
         JOIN files f ON fi.file_id = f.id
         WHERE fi.module_specifier = ?
         ORDER BY f.path, fi.line
         LIMIT ?`,
      )
      .all(moduleSpecifier, limit) as {
      file_path: string;
      local_name: string;
      imported_name: string;
      import_kind: 'value' | 'type';
      line: number;
      col: number;
    }[];
  }

  /**
   * Phase 15.6 — flexible symbol search with optional `kind`, `language`,
   * and `file_glob` filters. The glob is converted to a SQL LIKE pattern
   * (only `*` wildcards supported; other chars are escaped).
   *
   * Phase 16.1 — when `ftsTerm` is supplied (a plain alphanumeric substring
   * of length ≥ 3 with no wildcards) the lookup is anchored on the
   * `symbols_fts` MATCH instead of a full-table LIKE scan. The LIKE
   * pattern is still applied as a refinement so trigram false-positives
   * are filtered out.
   */
  searchByNameFiltered(
    pattern: string,
    opts: {
      kind?: string | null;
      language?: string | null;
      fileGlob?: string | null;
      limit?: number;
      ftsTerm?: string | null;
    },
  ): (SymbolRow & { file_path: string })[] {
    const useFts = opts.ftsTerm && this.hasFts();
    const where: string[] = [`s.name LIKE ? ESCAPE '\\' COLLATE NOCASE`];
    const params: unknown[] = [pattern];
    if (opts.kind) {
      where.push(`s.kind = ?`);
      params.push(opts.kind);
    }
    if (opts.language) {
      where.push(`(s.language = ? OR f.language = ?)`);
      params.push(opts.language, opts.language);
    }
    if (opts.fileGlob) {
      where.push(`f.path LIKE ? ESCAPE '\\'`);
      params.push(globToLike(opts.fileGlob));
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    if (useFts) {
      // FTS MATCH first, then refine with the same LIKE pattern (and
      // optional filters) via a join on rowid → symbols.id.
      const ftsParams: unknown[] = [`"${opts.ftsTerm!.replace(/"/g, '""')}"`, ...params, limit];
      return this.db
        .prepare(
          `SELECT s.*, f.path AS file_path
           FROM symbols_fts AS fts
           JOIN symbols s ON s.id = fts.rowid
           JOIN files f ON s.file_id = f.id
           WHERE symbols_fts MATCH ?
             AND ${where.join(' AND ')}
           ORDER BY length(s.name), s.name, f.path, s.start_line
           LIMIT ?`,
        )
        .all(...ftsParams) as (SymbolRow & { file_path: string })[];
    }
    params.push(limit);
    return this.db
      .prepare(
        `SELECT s.*, f.path AS file_path
         FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE ${where.join(' AND ')}
         ORDER BY length(s.name), s.name, f.path, s.start_line
         LIMIT ?`,
      )
      .all(...params) as (SymbolRow & { file_path: string })[];
  }

  /**
   * Phase 15.4 — last index time (from `manifest.last_indexed_at` if present,
   * else max(files.indexed_at)) and total file count.
   */
  indexStatus(): { lastIndexedAt: number | null; fileCount: number; symbolCount: number } {
    const fileCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM files`).get() as { c: number }).c;
    const symbolCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM symbols`).get() as { c: number }).c;
    const maxRow = this.db.prepare(`SELECT MAX(indexed_at) AS m FROM files`).get() as {
      m: number | null;
    };
    return { lastIndexedAt: maxRow.m ?? null, fileCount, symbolCount };
  }

  /** Every file path + last-indexed-at timestamp (for drift comparison). */
  allFiles(): { path: string; xxhash: string | null; indexed_at: number }[] {
    return this.db
      .prepare(`SELECT path, xxhash, indexed_at FROM files ORDER BY path`)
      .all() as { path: string; xxhash: string | null; indexed_at: number }[];
  }

  // Phase 16.1 — cached "does this DB have the symbols_fts virtual table?"
  // Memoised on the prototype-less object so each Queries instance pays the
  // sqlite_master check at most once.
  private _hasFtsCache: boolean | null = null;
  hasFts(): boolean {
    if (this._hasFtsCache !== null) return this._hasFtsCache;
    try {
      const row = this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbols_fts'`)
        .get();
      this._hasFtsCache = !!row;
    } catch {
      this._hasFtsCache = false;
    }
    return this._hasFtsCache;
  }

  // Phase 25 — file content table methods.

  upsertFileContent(fileId: number, content: string): void {
    this.upsertFileContentStmt.run(fileId, content);
  }

  clearFileContent(fileId: number): void {
    this.clearFileContentStmt.run(fileId);
  }

  getFileContent(fileId: number): string | null {
    const row = this.getFileContentStmt.get(fileId) as { content: string } | undefined;
    return row?.content ?? null;
  }

  /** Returns file_ids whose stored content matches the FTS5 trigram index. */
  searchContentFts(literal: string, limit: number): number[] {
    if (!this.hasContentFts()) return [];
    try {
      return (
        this.db
          .prepare(`SELECT rowid FROM file_content_fts WHERE file_content_fts MATCH ? LIMIT ?`)
          .all(`"${literal.replace(/"/g, '""')}"`, limit) as { rowid: number }[]
      ).map((r) => r.rowid);
    } catch {
      return [];
    }
  }

  /** All files that have stored content (path + file_id). */
  filesWithContent(): { file_id: number; path: string }[] {
    return this.db
      .prepare(
        `SELECT fc.file_id, f.path FROM file_content fc JOIN files f ON f.id = fc.file_id ORDER BY f.path`,
      )
      .all() as { file_id: number; path: string }[];
  }

  private _hasContentFtsCache: boolean | null = null;
  hasContentFts(): boolean {
    if (this._hasContentFtsCache !== null) return this._hasContentFtsCache;
    try {
      const row = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_content_fts'`,
        )
        .get();
      this._hasContentFtsCache = !!row;
    } catch {
      this._hasContentFtsCache = false;
    }
    return this._hasContentFtsCache;
  }
}

/** Convert a `*`-only glob into a SQL LIKE pattern (escapes %, _, \). */
function globToLike(glob: string): string {
  return glob
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\*/g, '%');
}

export interface OutgoingEdge {
  id: number;
  kind: EdgeKind;
  line: number;
  col: number;
  target_id: number | null;
  target_name: string | null;
  target_resolved_name: string | null;
  target_kind: SymbolKind | null;
  target_file_path: string | null;
  target_line: number | null;
  target_end_line: number | null;
  target_signature: string | null;
  file_id: number;
  file_path: string;
}

export interface IncomingEdge {
  id: number;
  kind: EdgeKind;
  line: number;
  col: number;
  source_id: number | null;
  file_id: number;
  source_name: string | null;
  source_kind: SymbolKind | null;
  source_file_path: string | null;
  source_line: number | null;
  source_end_line: number | null;
  source_signature: string | null;
  file_path: string;
}
