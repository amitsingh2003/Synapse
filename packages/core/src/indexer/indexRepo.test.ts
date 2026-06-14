import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../db/open.js';
import { collectStats } from '../db/stats.js';
import { indexRepo } from './indexRepo.js';

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

describe('indexRepo (fixture)', () => {
  it('indexes the sample shopping app end-to-end', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-indexrepo-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    const summary = await indexRepo(db, { root: FIXTURE, concurrency: 2 });

    expect(summary.filesDiscovered).toBeGreaterThanOrEqual(4);
    expect(summary.filesIndexed).toBe(summary.filesDiscovered);
    expect(summary.symbolCount).toBeGreaterThan(0);

    const stats = collectStats(db);
    expect(stats.files).toBe(summary.filesIndexed);
    expect(stats.symbols).toBe(summary.symbolCount);
    expect(stats.edges).toBe(summary.edgeCount);

    // The Cart class + its methods + the CartService + addProduct must exist.
    const names = (
      db
        .prepare('SELECT name FROM symbols')
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const n of ['Cart', 'addItem', 'CartService', 'addProduct']) {
      expect(names).toContain(n);
    }

    db.close();
  });

  it('skips unchanged files on a second pass', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-indexrepo-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    const first = await indexRepo(db, { root: FIXTURE });
    const second = await indexRepo(db, { root: FIXTURE, skipUnchanged: true });

    expect(second.filesDiscovered).toBe(first.filesDiscovered);
    expect(second.filesSkipped).toBe(first.filesIndexed);
    expect(second.filesIndexed).toBe(0);

    db.close();
  });
});
