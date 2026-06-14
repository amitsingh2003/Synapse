import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/open.js';
import { Queries } from '../db/queries.js';
import { watchRepo } from './watcher.js';

let dir: string | null = null;

function tempRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'cg-watch-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  dir = d;
  return d;
}

afterEach(() => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    dir = null;
  }
});

const DEBOUNCE = 60;

describe('watchRepo', () => {
  it('indexes a newly added file', async () => {
    const root = tempRepo();
    const db = openDatabase({ path: join(root, '.synapse', 'graph.db') });
    const handle = await watchRepo(db, { root, debounceMs: DEBOUNCE });
    try {
      writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
      await handle.flush();

      const q = new Queries(db);
      const hits = q.searchByName('alpha');
      expect(hits.length).toBe(1);
      expect(hits[0]!.kind).toBe('function');
    } finally {
      await handle.close();
      db.close();
    }
  });

  it('updates symbols when a file changes and removes them on delete', async () => {
    const root = tempRepo();
    const file = join(root, 'src', 'b.ts');
    writeFileSync(file, 'export function beta() {}\n');
    const db = openDatabase({ path: join(root, '.synapse', 'graph.db') });

    const handle = await watchRepo(db, { root, debounceMs: DEBOUNCE });
    try {
      writeFileSync(file, 'export function gamma() {}\n');
      await handle.flush();
      const q = new Queries(db);
      expect(q.searchByName('gamma').length).toBe(1);
      expect(q.searchByName('beta').length).toBe(0);

      unlinkSync(file);
      await handle.flush();
      expect(q.searchByName('gamma').length).toBe(0);
      expect(q.fileByPath(file)).toBeUndefined();
    } finally {
      await handle.close();
      db.close();
    }
  });
});
