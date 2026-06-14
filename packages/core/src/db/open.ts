import Database, { type Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations.js';

export interface OpenDbOptions {
  /** Absolute path to the SQLite file. Parent directories are created. */
  path: string;
  /** Open in read-only mode. Default false. */
  readonly?: boolean;
}

/**
 * Open (and migrate) a synapse SQLite database.
 *
 * Tuned with the pragmas from the Phase-0 plan: WAL, 64 MB cache, 256 MB mmap,
 * synchronous=NORMAL — safe for crash-recovery on local files, much faster than
 * the SQLite defaults for our write-burst-then-read pattern.
 */
export function openDatabase(opts: OpenDbOptions): DB {
  mkdirSync(dirname(opts.path), { recursive: true });
  const db = new Database(opts.path, { readonly: opts.readonly ?? false });

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -131072');      // 128 MB page cache (was 64 MB)
  db.pragma('mmap_size = 536870912');     // 512 MB mmap (was 256 MB)
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');
  // Phase 8: tolerate concurrent readers/writers (CLI + watcher + MCP).
  db.pragma('busy_timeout = 5000');
  // Phase 24: checkpoint WAL every 2000 pages instead of the default 1000.
  // Larger checkpoints reduce stall frequency during bursty writes (init/reindex)
  // at the cost of slightly larger WAL files between checkpoints.
  db.pragma('wal_autocheckpoint = 2000');

  if (!opts.readonly) {
    runMigrations(db);
  }

  // Phase 10: reject DBs from a newer synapse version
  checkSchemaVersion(db);

  return db;
}

/** Apply any pending migrations from `migrations.ts` in declared order. */
export function runMigrations(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );

  const insert = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    try {
      db.transaction(() => {
        db.exec(m.sql);
        insert.run(m.name, Date.now());
      })();
    } catch (err) {
      // Phase 16.1 — optional fallback (e.g. FTS5 trigram unavailable).
      if (!m.fallbackSql) throw err;
      db.transaction(() => {
        db.exec(m.fallbackSql!);
        insert.run(m.name, Date.now());
      })();
    }
  }
}

/**
 * Phase 10: Reject databases created by a newer version of synapse.
 * If the manifest table doesn't exist yet (pre-Phase-10 DB), we skip gracefully.
 */
function checkSchemaVersion(db: DB): void {
  try {
    const row = db.prepare(
      `SELECT value FROM manifest WHERE key = 'schema_version'`,
    ).get() as { value: string } | undefined;
    if (!row) return; // pre-Phase-10 DB, migration hasn't run yet — fine
    const version = Number(row.value);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `This database was created by a newer version of synapse (schema v${version}). ` +
        `This binary only supports up to v${SCHEMA_VERSION}. Please upgrade synapse.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('no such table: manifest')) {
      return; // DB is pre-001_init (impossible in practice)
    }
    throw err;
  }
}

/** Read a value from the manifest table. */
export function getManifestValue(db: DB, key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM manifest WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Write a value to the manifest table. */
export function setManifestValue(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)`,
  ).run(key, value);
}

/**
 * Phase 16.4 — reclaim free pages and refresh the SQLite planner stats.
 * Safe to call any time on a non-readonly handle. Wraps each command in
 * try/catch so a missing optimizer (or busy DB) doesn't kill the caller.
 *
 * `VACUUM` rewrites the file into a fresh tightly-packed copy and can be
 * slow on multi-GB DBs — callers (init/reindex tail, `synapse compact`)
 * should prefer running it sparingly.
 */
export function compactDatabase(db: DB): { vacuumed: boolean; analyzed: boolean } {
  let vacuumed = false;
  let analyzed = false;
  try {
    db.exec('VACUUM');
    vacuumed = true;
  } catch {
    /* leave vacuumed=false; usually means another connection holds a txn */
  }
  try {
    db.exec('ANALYZE');
    analyzed = true;
  } catch {
    /* ignore */
  }
  // `PRAGMA optimize` is the cheap incremental flavour — always safe.
  try {
    db.pragma('optimize');
  } catch {
    /* ignore */
  }
  return { vacuumed, analyzed };
}
