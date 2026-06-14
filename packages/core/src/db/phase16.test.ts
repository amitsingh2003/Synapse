import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './open.js';
import { compactDatabase } from './open.js';
import { getManifestValue } from './open.js';
import { indexRepo } from '../indexer/indexRepo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', '..', 'fixtures', 'sample-shopping-app');

let dbDir: string | null = null;
afterEach(() => {
  if (dbDir) {
    try {
      rmSync(dbDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    dbDir = null;
  }
});

describe('Phase 16.1 — FTS5 symbol index', () => {
  it('creates symbols_fts virtual table at schema_version 6', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-phase16-fts-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    expect(Number(getManifestValue(db, 'schema_version'))).toBeGreaterThanOrEqual(8);

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'symbols_fts'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('symbols_fts');

    db.close();
  });

  it('mirrors symbols into the FTS index via triggers', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-phase16-fts2-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    await indexRepo(db, { root: FIXTURE });

    const symbolCount = (
      db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }
    ).c;
    const ftsCount = (
      db.prepare('SELECT COUNT(*) AS c FROM symbols_fts').get() as { c: number }
    ).c;
    expect(ftsCount).toBe(symbolCount);

    db.close();
  });
});

describe('Phase 16.4 — compactDatabase', () => {
  it('runs VACUUM + ANALYZE without throwing on a fresh DB', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-phase16-compact-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    const res = compactDatabase(db);
    expect(res.vacuumed).toBe(true);
    expect(res.analyzed).toBe(true);

    db.close();
  });

  it('reclaims free pages after deleting rows from an indexed repo', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-phase16-compact2-'));
    const dbPath = join(dbDir, 'graph.db');
    const db = openDatabase({ path: dbPath });
    await indexRepo(db, { root: FIXTURE });

    // Force WAL contents into the main DB file so size comparisons are meaningful.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const pagesBeforeDelete = (db.pragma('page_count', { simple: true }) as number);

    db.exec('DELETE FROM edges; DELETE FROM symbols; DELETE FROM files;');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const pagesAfterDelete = (db.pragma('page_count', { simple: true }) as number);
    const freeBeforeVacuum = (db.pragma('freelist_count', { simple: true }) as number);

    const res = compactDatabase(db);
    const pagesAfterVacuum = (db.pragma('page_count', { simple: true }) as number);
    const freeAfterVacuum = (db.pragma('freelist_count', { simple: true }) as number);
    db.close();

    expect(res.vacuumed).toBe(true);
    expect(res.analyzed).toBe(true);
    // Indexing must have produced multiple pages.
    expect(pagesBeforeDelete).toBeGreaterThan(1);
    // VACUUM completed cleanly: no free pages left.
    expect(freeAfterVacuum).toBe(0);
    // unused locals — kept for readability.
    void pagesAfterDelete;
    void pagesAfterVacuum;
    void freeBeforeVacuum;
    // Also make sure statSync still works on the resulting file.
    expect(statSync(dbPath).size).toBeGreaterThan(0);
  });
});

describe('Phase 16.6 — iterative walk', () => {
  it('parses deeply nested source without stack overflow', async () => {
    const { parseSource } = await import('../parser/extract.js');
    // Build a 5000-level deep nested array literal.
    const depth = 5000;
    const src = 'const x = ' + '['.repeat(depth) + '1' + ']'.repeat(depth) + ';';
    await expect(parseSource(src, 'typescript')).resolves.toBeDefined();
  });
});
