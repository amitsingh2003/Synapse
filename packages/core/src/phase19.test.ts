/**
 * Phase 19 tests — SCIP import, diff, retriever.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  indexRepo,
  importScipIndex,
  SynapseRetriever,
  type ScipIndex,
} from '@synapse/core';
import type { Database as DB } from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'fixtures', 'sample-shopping-app');

let dbDir: string;
let db: DB;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'cg-phase19-'));
  db = openDatabase({ path: join(dbDir, 'graph.db') });
  await indexRepo(db, { root: FIXTURE, concurrency: 2 });
});

afterAll(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

// ─── 19.1 SCIP Import ─────────────────────────────────────────────────────

describe('Phase 19.1 — SCIP import', () => {
  it('imports symbols from a SCIP JSON index', () => {
    const scipData: ScipIndex = {
      metadata: { version: 1, toolInfo: { name: 'test' } },
      documents: [
        {
          relativePath: 'src/auth.ts',
          language: 'typescript',
          occurrences: [
            { range: [5, 0, 5, 20], symbol: 'scip-ts npm test 1.0.0 src/auth.ts/authenticate.', symbolRoles: 1 },
            { range: [15, 0, 15, 15], symbol: 'scip-ts npm test 1.0.0 src/auth.ts/User#validate.', symbolRoles: 1 },
            { range: [20, 4, 20, 16], symbol: 'scip-ts npm test 1.0.0 src/auth.ts/authenticate.', symbolRoles: 0 },
          ],
          symbols: [
            {
              symbol: 'scip-ts npm test 1.0.0 src/auth.ts/authenticate.',
              documentation: ['Authenticate a user with credentials.'],
              kind: 2, // function
              signatureDocumentation: { text: '(user: string, pass: string) => Promise<boolean>' },
            },
            {
              symbol: 'scip-ts npm test 1.0.0 src/auth.ts/User#validate.',
              documentation: ['Validate user token.'],
              kind: 5, // method
              signatureDocumentation: { text: '(token: string) => boolean' },
            },
          ],
        },
      ],
    };

    const result = importScipIndex(db, { data: scipData });

    expect(result.filesImported).toBe(1);
    expect(result.symbolsImported).toBe(2);
    expect(result.edgesCreated).toBeGreaterThanOrEqual(1);

    // Verify symbols are in the DB.
    const rows = db.prepare("SELECT name, kind FROM symbols WHERE file_id = (SELECT id FROM files WHERE path = 'src/auth.ts')").all() as { name: string; kind: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain('authenticate');
    expect(names).toContain('validate');
  });

  it('respects skipExisting option', () => {
    const scipData: ScipIndex = {
      documents: [
        {
          relativePath: 'src/auth.ts',
          occurrences: [
            { range: [1, 0, 1, 10], symbol: 'test#newSymbol.', symbolRoles: 1 },
          ],
          symbols: [{ symbol: 'test#newSymbol.', kind: 2 }],
        },
      ],
    };

    const result = importScipIndex(db, { data: scipData, skipExisting: true });
    expect(result.skipped).toBe(1);
    expect(result.filesImported).toBe(0);
  });
});

// ─── 19.3 SynapseRetriever ───────────────────────────────────────────────

describe('Phase 19.3 — SynapseRetriever', () => {
  it('classifies exact symbol names', () => {
    const retriever = new SynapseRetriever(db);
    expect(retriever.classifyIntent('Cart')).toBe('exact');
    expect(retriever.classifyIntent('addItem')).toBe('exact');
  });

  it('classifies semantic queries', () => {
    const retriever = new SynapseRetriever(db);
    expect(retriever.classifyIntent('find the function that authenticates users')).toBe('semantic');
  });

  it('classifies definition lookups', () => {
    const retriever = new SynapseRetriever(db);
    expect(retriever.classifyIntent('where is Cart defined')).toBe('definition');
  });

  it('classifies reference lookups', () => {
    const retriever = new SynapseRetriever(db);
    expect(retriever.classifyIntent('who calls addItem')).toBe('references');
  });

  it('retrieve() returns results for exact symbol name', async () => {
    const retriever = new SynapseRetriever(db);
    const docs = await retriever.retrieve('Cart');
    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]!.name).toBe('Cart');
    expect(docs[0]!.score).toBe(1.0);
  });

  it('retrieve() with hybrid falls back gracefully without embeddings', async () => {
    const retriever = new SynapseRetriever(db);
    const docs = await retriever.retrieve('shopping cart functionality and price calculation');
    // Should still return something via fuzzy/FTS stages.
    expect(docs).toBeDefined();
  });
});
