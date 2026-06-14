/**
 * Phase 25 — FTS5 content table tests.
 *
 * Verifies that:
 *  - The file_content and file_content_fts tables are created by migration 009.
 *  - upsertFileContent / getFileContent / clearFileContent round-trip correctly.
 *  - FTS5 triggers keep file_content_fts in sync on insert / update / delete.
 *  - searchContentFts returns the right file IDs for a literal substring.
 *  - filesWithContent returns files that have content stored.
 *  - hasContentFts returns true when the FTS5 table exists.
 *  - indexRepo stores file content so that searchContentFts works after indexing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, getManifestValue } from './open.js';
import { Queries } from './queries.js';
import { indexRepo } from '../indexer/indexRepo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', '..', 'fixtures', 'sample-shopping-app');

let dbDir: string | null = null;
afterEach(() => {
  if (dbDir) {
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
    dbDir = null;
  }
});

describe('Phase 25 — file_content migration', () => {
  it('creates file_content and file_content_fts tables', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-schema-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    expect(getManifestValue(db, 'schema_version')).toBe('9');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','shadow') AND name LIKE 'file_content%' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((r) => r.name);
    expect(names).toContain('file_content');

    const fts = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_content_fts'")
      .get() as { name: string } | undefined;
    expect(fts?.name).toBe('file_content_fts');

    db.close();
  });

  it('hasContentFts returns true', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-hasfts-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });
    const q = new Queries(db);
    expect(q.hasContentFts()).toBe(true);
    db.close();
  });
});

describe('Phase 25 — upsert / get / clear round-trip', () => {
  it('stores and retrieves content', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-roundtrip-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    // Insert a dummy files row so we can reference it.
    db.prepare(
      `INSERT INTO files (path, language, xxhash, indexed_at) VALUES ('test.ts', 'typescript', 'abc', ${Date.now()})`,
    ).run();
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get('test.ts') as { id: number }).id;

    const q = new Queries(db);
    q.upsertFileContent(fileId, 'hello world from phase 25');
    expect(q.getFileContent(fileId)).toBe('hello world from phase 25');

    db.close();
  });

  it('upsert overwrites on conflict', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-upsert-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });
    db.prepare(
      `INSERT INTO files (path, language, xxhash, indexed_at) VALUES ('test.ts', 'typescript', 'abc', ${Date.now()})`,
    ).run();
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get('test.ts') as { id: number }).id;

    const q = new Queries(db);
    q.upsertFileContent(fileId, 'first content');
    q.upsertFileContent(fileId, 'updated content');
    expect(q.getFileContent(fileId)).toBe('updated content');

    db.close();
  });

  it('clearFileContent removes content and returns null', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-clear-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });
    db.prepare(
      `INSERT INTO files (path, language, xxhash, indexed_at) VALUES ('test.ts', 'typescript', 'abc', ${Date.now()})`,
    ).run();
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get('test.ts') as { id: number }).id;

    const q = new Queries(db);
    q.upsertFileContent(fileId, 'some content');
    q.clearFileContent(fileId);
    expect(q.getFileContent(fileId)).toBeNull();

    db.close();
  });
});

describe('Phase 25 — FTS5 trigger sync', () => {
  it('FTS5 row count matches file_content row count after inserts', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-trigger-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO files (path, language, xxhash, indexed_at) VALUES (?, 'typescript', ?, ?)`,
      ).run(`file${i}.ts`, `hash${i}`, Date.now());
      const fileId = (
        db.prepare('SELECT id FROM files WHERE path = ?').get(`file${i}.ts`) as { id: number }
      ).id;
      const q = new Queries(db);
      q.upsertFileContent(fileId, `content for file${i} with unique term uq${i}abc`);
    }

    const fcCount = (db.prepare('SELECT COUNT(*) as c FROM file_content').get() as { c: number }).c;
    const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM file_content_fts').get() as { c: number }).c;
    expect(ftsCount).toBe(fcCount);
    expect(ftsCount).toBe(3);

    db.close();
  });

  it('FTS5 row is removed when file_content row is deleted', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-trigdel-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });
    db.prepare(
      `INSERT INTO files (path, language, xxhash, indexed_at) VALUES ('x.ts', 'typescript', 'h1', ${Date.now()})`,
    ).run();
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get('x.ts') as { id: number }).id;
    const q = new Queries(db);
    q.upsertFileContent(fileId, 'temporary content for delete test');

    expect((db.prepare('SELECT COUNT(*) as c FROM file_content_fts').get() as { c: number }).c).toBe(1);
    q.clearFileContent(fileId);
    expect((db.prepare('SELECT COUNT(*) as c FROM file_content_fts').get() as { c: number }).c).toBe(0);

    db.close();
  });
});

describe('Phase 25 — searchContentFts', () => {
  it('returns file IDs matching a 3+ char literal', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-fts-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    const insertFile = (path: string, content: string): number => {
      db.prepare(
        `INSERT INTO files (path, language, xxhash, indexed_at) VALUES (?, 'typescript', ?, ?)`,
      ).run(path, path, Date.now());
      const id = (db.prepare('SELECT id FROM files WHERE path = ?').get(path) as { id: number }).id;
      new Queries(db).upsertFileContent(id, content);
      return id;
    };

    const id1 = insertFile('alpha.ts', 'export function findCart() {}');
    const id2 = insertFile('beta.ts', 'export function removeItem() {}');
    insertFile('gamma.ts', 'export const PI = 3.14;');

    const q = new Queries(db);
    const results = q.searchContentFts('findCart', 100);
    expect(results).toContain(id1);
    expect(results).not.toContain(id2);

    db.close();
  });

  it('returns empty array for a pattern shorter than 3 chars', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-fts-short-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });
    const q = new Queries(db);
    expect(q.searchContentFts('ab', 100)).toEqual([]);
    db.close();
  });
});

describe('Phase 25 — filesWithContent', () => {
  it('returns only files that have content stored', () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-withcontent-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    db.prepare(
      `INSERT INTO files (path, language, xxhash, indexed_at) VALUES ('a.ts', 'typescript', 'h1', ${Date.now()}), ('b.ts', 'typescript', 'h2', ${Date.now()})`,
    ).run();
    const aId = (db.prepare("SELECT id FROM files WHERE path='a.ts'").get() as { id: number }).id;

    const q = new Queries(db);
    q.upsertFileContent(aId, 'only a has content');

    const withContent = q.filesWithContent();
    expect(withContent.map((r) => r.path)).toContain('a.ts');
    expect(withContent.map((r) => r.path)).not.toContain('b.ts');

    db.close();
  });
});

describe('Phase 25 — indexRepo stores file content', () => {
  it('populates file_content table after indexing', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-index-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });
    await indexRepo(db, { root: FIXTURE });

    const fcCount = (db.prepare('SELECT COUNT(*) as c FROM file_content').get() as { c: number }).c;
    const totalFiles = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;

    expect(fcCount).toBeGreaterThan(0);
    // Every indexed file should have its content stored
    expect(fcCount).toBe(totalFiles);

    // FTS5 should mirror the content table
    const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM file_content_fts').get() as { c: number }).c;
    expect(ftsCount).toBe(fcCount);

    db.close();
  });

  it('searchContentFts finds actual source terms after indexing', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-p25-ftsafter-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });
    await indexRepo(db, { root: FIXTURE });

    const q = new Queries(db);
    // "addItem" is a function name in the sample fixture (cart.ts)
    const results = q.searchContentFts('addItem', 100);
    expect(results.length).toBeGreaterThan(0);

    db.close();
  });
});
