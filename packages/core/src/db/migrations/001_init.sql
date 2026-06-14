-- 001_init.sql
-- Phase 1 schema: minimal nodes + edges for single-file Tree-sitter indexing.
-- Cross-file SCIP linking comes in Phase 3 (will add scip_id columns + indices).

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
  scip_id     TEXT    UNIQUE,                       -- populated in Phase 3
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,                     -- function, method, class, interface, import, ...
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
  target_name TEXT,                                 -- fallback when target not yet resolved
  kind        TEXT    NOT NULL,                     -- CALLS, IMPORTS, EXTENDS, IMPLEMENTS, REFERENCES
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
