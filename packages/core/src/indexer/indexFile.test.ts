import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase, Queries, indexFile } from '../index.js';

const SAMPLE = `
export class Cart {
  addItem(item: { id: string }): void {
    this.set(item);
  }
  private set(x: unknown): void {}
}
`;

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'synapse-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('indexFile', () => {
  it('parses a file and writes symbols + edges atomically', async () => {
    const { dir, cleanup } = tmp();
    try {
      const src = resolve(dir, 'cart.ts');
      writeFileSync(src, SAMPLE);

      const dbPath = resolve(dir, 'graph.db');
      const db = openDatabase({ path: dbPath });

      const r1 = await indexFile(db, src);
      expect(r1.language).toBe('typescript');
      expect(r1.symbolCount).toBeGreaterThan(0);

      const q = new Queries(db);
      const found = q.searchByName('addItem');
      expect(found.length).toBe(1);
      expect(found[0]!.kind).toBe('method');
      // Phase 10: file_path is repo-relative. indexFile defaults repoRoot to
      // dirname(src), so the relative path is just the file basename.
      expect(found[0]!.file_path).toBe('cart.ts');

      // Re-indexing the same file should not duplicate rows (clearFile path).
      const r2 = await indexFile(db, src);
      const found2 = q.searchByName('addItem');
      expect(found2.length).toBe(1);
      expect(r2.symbolCount).toBe(r1.symbolCount);

      db.close();
    } finally {
      cleanup();
    }
  });
});
