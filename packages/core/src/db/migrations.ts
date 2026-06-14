/**
 * Migrations are embedded as strings so we don't have to ship .sql files
 * alongside the bundled JS (works identically under tsup, vitest, and
 * `node --import tsx`).
 *
 * Add new migrations by appending to the `MIGRATIONS` array. Order matters.
 */

const M_001_INIT = `
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY,
  path        TEXT    NOT NULL UNIQUE,
  language    TEXT    NOT NULL,
  xxhash      TEXT,
  mtime_ms    INTEGER,
  indexed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY,
  scip_id     TEXT    UNIQUE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  start_col   INTEGER NOT NULL,
  end_col     INTEGER NOT NULL,
  signature   TEXT,
  doc         TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_name   ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file   ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind   ON symbols(kind);

CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  target_id   INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  target_name TEXT,
  kind        TEXT    NOT NULL,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line        INTEGER NOT NULL,
  col         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_file   ON edges(file_id);

CREATE TABLE IF NOT EXISTS manifest (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface Migration {
  name: string;
  sql: string;
  /**
   * Phase 16.1 — if `sql` throws (e.g. SQLite build lacks a feature like the
   * FTS5 trigram tokenizer), retry once with this SQL. Recorded under the
   * same migration name so it doesn't replay on subsequent opens.
   */
  fallbackSql?: string;
}

const M_002_IMPORTS = `
-- One row per imported binding in a file. Populated during indexing, then
-- 'resolved_file_id' is filled in by the cross-reference resolver (Phase 3).
CREATE TABLE IF NOT EXISTS file_imports (
  id                INTEGER PRIMARY KEY,
  file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  local_name        TEXT    NOT NULL,
  imported_name     TEXT    NOT NULL,
  module_specifier  TEXT    NOT NULL,
  resolved_file_id  INTEGER REFERENCES files(id) ON DELETE SET NULL,
  line              INTEGER NOT NULL,
  col               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_imports_file  ON file_imports(file_id);
CREATE INDEX IF NOT EXISTS idx_file_imports_local ON file_imports(file_id, local_name);
CREATE INDEX IF NOT EXISTS idx_file_imports_resolved ON file_imports(resolved_file_id);
`;

/**
 * Phase 10: schema versioning + portable paths.
 * - Inserts `schema_version` into manifest.
 * - From this point, `files.path` stores repo-relative paths (fwd slashes).
 * - `repo_root` is written to manifest at index time (not migration time)
 *   since the root is unknown during a bare `open`.
 */
const M_003_SCHEMA_VERSION = `
INSERT OR IGNORE INTO manifest (key, value) VALUES ('schema_version', '3');
`;

/**
 * Phase 12: per-symbol language (adapter id). NULL for rows written by
 * pre-Phase-12 synapse; new inserts populate it.
 */
const M_004_SYMBOL_LANGUAGE = `
ALTER TABLE symbols ADD COLUMN language TEXT;
CREATE INDEX IF NOT EXISTS idx_symbols_language ON symbols(language);
UPDATE manifest SET value = '4' WHERE key = 'schema_version';
`;

/**
 * Phase 14: track whether an import is type-only (`import type {…}`,
 * `import { type X }`, `export type {…} from`). Defaults to 'value' for
 * rows written by pre-Phase-14 synapse.
 */
const M_005_IMPORT_KIND = `
ALTER TABLE file_imports ADD COLUMN import_kind TEXT NOT NULL DEFAULT 'value';
CREATE INDEX IF NOT EXISTS idx_file_imports_kind ON file_imports(import_kind);
UPDATE manifest SET value = '5' WHERE key = 'schema_version';
`;

/**
 * Phase 16.1 — FTS5 virtual table over symbol names with the trigram
 * tokenizer so substring queries (`%cart%`) become MATCH lookups instead
 * of full-table scans.
 *
 * - `symbols_fts` is a contentless FTS5 table whose rowid mirrors
 *   `symbols.id`. We sync it ourselves via triggers (insert/update/delete)
 *   rather than `content=` because we want the FTS rowid to stay aligned
 *   even when symbols are deleted/re-inserted (per-file atomic rewrites).
 * - If the SQLite build lacks the trigram tokenizer this migration falls
 *   back to the default (unicode61) tokenizer — substring queries will be
 *   less precise but the LIKE fallback in queries.ts still works.
 * - Populates rows from any pre-existing symbols.
 */
const M_006_FTS_SYMBOLS = `
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS symbols_ai_fts AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name) VALUES (new.id, new.name);
END;
CREATE TRIGGER IF NOT EXISTS symbols_ad_fts AFTER DELETE ON symbols BEGIN
  DELETE FROM symbols_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS symbols_au_fts AFTER UPDATE OF name ON symbols BEGIN
  DELETE FROM symbols_fts WHERE rowid = old.id;
  INSERT INTO symbols_fts(rowid, name) VALUES (new.id, new.name);
END;
INSERT INTO symbols_fts(rowid, name)
  SELECT s.id, s.name FROM symbols s
  WHERE NOT EXISTS (SELECT 1 FROM symbols_fts f WHERE f.rowid = s.id);
UPDATE manifest SET value = '6' WHERE key = 'schema_version';
`;

/**
 * Phase 16.1 fallback — if `M_006_FTS_SYMBOLS` failed because the SQLite
 * build lacks the trigram tokenizer, this migration retries with the
 * default `unicode61` tokenizer. Recorded as a separate migration name so
 * old DBs that already applied 006 successfully don't replay it.
 */
const M_006B_FTS_SYMBOLS_FALLBACK = `
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name);
CREATE TRIGGER IF NOT EXISTS symbols_ai_fts AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name) VALUES (new.id, new.name);
END;
CREATE TRIGGER IF NOT EXISTS symbols_ad_fts AFTER DELETE ON symbols BEGIN
  DELETE FROM symbols_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS symbols_au_fts AFTER UPDATE OF name ON symbols BEGIN
  DELETE FROM symbols_fts WHERE rowid = old.id;
  INSERT INTO symbols_fts(rowid, name) VALUES (new.id, new.name);
END;
INSERT INTO symbols_fts(rowid, name)
  SELECT s.id, s.name FROM symbols s
  WHERE NOT EXISTS (SELECT 1 FROM symbols_fts f WHERE f.rowid = s.id);
UPDATE manifest SET value = '6' WHERE key = 'schema_version';
`;

export const SCHEMA_VERSION = 9;

/**
 * Phase 18.1 — symbol_embeddings table for storing dense vectors produced
 * by an optional embedding provider (Ollama / fastembed).
 */
const M_007_EMBEDDINGS = `
CREATE TABLE IF NOT EXISTS symbol_embeddings (
  symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  vector      BLOB    NOT NULL,
  model       TEXT    NOT NULL,
  embedded_at INTEGER NOT NULL
);
UPDATE manifest SET value = '7' WHERE key = 'schema_version';
`;

/**
 * Phase 24 — performance indexes.
 *
 * - idx_file_imports_module: eliminates the full file_imports scan in
 *   `findImports` / `fileImportsByModule` (was O(imports), now O(log n)).
 * - idx_symbols_name_kind: composite covering index used by filtered
 *   `find_symbol` / `get_definition` when both name and kind are provided;
 *   also speeds up the resolver's per-name lookup.
 * - idx_edges_unresolved: partial index covering the resolver's
 *   "unresolved edges" query (WHERE target_id IS NULL AND target_name IS NOT NULL).
 *   Pre-existing idx_edges_source/target don't help that query at all.
 */
const M_008_PERF_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_file_imports_module
  ON file_imports(module_specifier);
CREATE INDEX IF NOT EXISTS idx_symbols_name_kind
  ON symbols(name, kind);
CREATE INDEX IF NOT EXISTS idx_edges_unresolved
  ON edges(file_id, target_name)
  WHERE target_id IS NULL AND target_name IS NOT NULL;
UPDATE manifest SET value = '8' WHERE key = 'schema_version';
`;

/**
 * Phase 25 — full-text content index for fast grep pre-filtering.
 *
 * - `file_content` stores the raw source text keyed by file_id.
 * - `file_content_fts` is a contentless FTS5 table with the trigram tokenizer,
 *   allowing substring MATCH queries to narrow grep to candidate files before
 *   the line-level regex scan. Mirrors the same pattern as `symbols_fts`.
 * - Fallback omits the FTS5 table if the SQLite build lacks the trigram
 *   tokenizer; grep still works by scanning `file_content` directly.
 */
const M_009_FTS5_CONTENT = `
CREATE TABLE IF NOT EXISTS file_content (
  file_id  INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  content  TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS file_content_fts USING fts5(
  content,
  tokenize = 'trigram'
);
CREATE TRIGGER IF NOT EXISTS fc_ai AFTER INSERT ON file_content BEGIN
  INSERT INTO file_content_fts(rowid, content) VALUES (new.file_id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS fc_ad AFTER DELETE ON file_content BEGIN
  DELETE FROM file_content_fts WHERE rowid = old.file_id;
END;
CREATE TRIGGER IF NOT EXISTS fc_au AFTER UPDATE OF content ON file_content BEGIN
  DELETE FROM file_content_fts WHERE rowid = old.file_id;
  INSERT INTO file_content_fts(rowid, content) VALUES (new.file_id, new.content);
END;
UPDATE manifest SET value = '9' WHERE key = 'schema_version';
`;

const M_009B_FTS5_CONTENT_FALLBACK = `
CREATE TABLE IF NOT EXISTS file_content (
  file_id  INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  content  TEXT NOT NULL
);
UPDATE manifest SET value = '9' WHERE key = 'schema_version';
`;

export const MIGRATIONS: readonly Migration[] = [
  { name: '001_init', sql: M_001_INIT },
  { name: '002_imports', sql: M_002_IMPORTS },
  { name: '003_schema_version', sql: M_003_SCHEMA_VERSION },
  { name: '004_symbol_language', sql: M_004_SYMBOL_LANGUAGE },
  { name: '005_import_kind', sql: M_005_IMPORT_KIND },
  { name: '006_fts_symbols', sql: M_006_FTS_SYMBOLS, fallbackSql: M_006B_FTS_SYMBOLS_FALLBACK },
  { name: '007_embeddings', sql: M_007_EMBEDDINGS },
  { name: '008_perf_indexes', sql: M_008_PERF_INDEXES },
  { name: '009_fts5_content', sql: M_009_FTS5_CONTENT, fallbackSql: M_009B_FTS5_CONTENT_FALLBACK },
];
