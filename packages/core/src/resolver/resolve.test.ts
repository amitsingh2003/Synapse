import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../db/open.js';
import { Queries } from '../db/queries.js';
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

describe('resolveReferences (fixture)', () => {
  it('resolves cross-file imports + edges and exposes Cart usage sites', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-resolve-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });

    const summary = await indexRepo(db, { root: FIXTURE });
    expect(summary.resolve).toBeDefined();

    // Most of the fixture's imports are relative and *should* resolve.
    expect(summary.resolve!.importsResolved).toBeGreaterThan(0);
    // We should have linked at least one cross-file CALLS edge (the main
    // file calls into CartService / Cart, and CartService calls Cart#addItem).
    expect(summary.resolve!.edgesResolved).toBeGreaterThan(0);

    const q = new Queries(db);

    // Cart class should have at least one incoming reference (CartService imports it).
    const carts = q.searchByName('Cart');
    expect(carts.length).toBeGreaterThan(0);
    const cart = carts.find((s) => s.kind === 'class')!;
    const cartIncoming = q.incomingEdges(cart.id);
    expect(cartIncoming.length).toBeGreaterThan(0);

    // addItem method must have at least one incoming CALLS edge from CartService.
    const addItem = q
      .searchByName('addItem')
      .find((s) => s.kind === 'method' && s.file_path.includes('cart'));
    expect(addItem).toBeDefined();
    const incoming = q.incomingEdges(addItem!.id);
    const callsFromService = incoming.filter(
      (e) => e.kind === 'CALLS' && e.file_path.includes('cartService'),
    );
    expect(callsFromService.length).toBeGreaterThan(0);

    db.close();
  });

  it('stores scip_ids for non-import symbols', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-resolve-'));
    const db = openDatabase({ path: join(dbDir, 'graph.db') });
    await indexRepo(db, { root: FIXTURE });

    const rows = db
      .prepare(`SELECT scip_id, kind FROM symbols WHERE kind != 'import'`)
      .all() as { scip_id: string | null; kind: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.scip_id).toMatch(/^local .+#.+/);
    }
    db.close();
  });
});
