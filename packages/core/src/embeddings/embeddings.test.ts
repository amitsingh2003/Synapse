/**
 * Phase 18 tests — embeddings module, semantic search, hybrid search.
 *
 * These tests use a **mock** EmbeddingProvider so they don't depend on
 * Ollama being available locally. The mock maps each text to a random-but-
 * deterministic Float32Array using a simple hash → seed → uniform-fill.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  indexRepo,
  normalizeL2,
  cosineSimilarity,
  vectorToBlob,
  blobToVector,
  upsertEmbeddings,
  hasEmbeddingsTable,
  loadAllEmbeddings,
  semanticSearch,
  runEmbedJob,
  hybridSearch,
  getManifestValue,
  type EmbeddingProvider,
} from '@synapse/core';
import type { Database as DB } from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', '..', 'fixtures', 'sample-shopping-app');

const DIMS = 8; // tiny embedding dimension for test speed

/**
 * Deterministic mock embedding provider. Uses a simple hash of the input
 * text to seed a repeatable pseudo-random vector.
 */
class MockProvider implements EmbeddingProvider {
  readonly modelId = 'mock-8d';
  readonly dimensions = DIMS;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(DIMS);
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
      for (let i = 0; i < DIMS; i++) {
        h = (h * 1103515245 + 12345) | 0;
        v[i] = (h & 0x7fffffff) / 0x7fffffff;
      }
      return normalizeL2(v);
    });
  }
}

let dbDir: string;
let db: DB;
const provider = new MockProvider();

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'cg-phase18-'));
  db = openDatabase({ path: join(dbDir, 'graph.db') });
  await indexRepo(db, { root: FIXTURE, concurrency: 2 });
});

afterAll(() => {
  db.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('Phase 18.1 — Embedding storage', () => {
  it('creates symbol_embeddings table at schema_version 7', () => {
    expect(Number(getManifestValue(db, 'schema_version'))).toBeGreaterThanOrEqual(8);
    expect(hasEmbeddingsTable(db)).toBe(true);
  });

  it('vectorToBlob/blobToVector round-trips', () => {
    const v = new Float32Array([1.5, -0.3, 0.0, 2.7]);
    const blob = vectorToBlob(v);
    const back = blobToVector(blob);
    expect(back.length).toBe(v.length);
    for (let i = 0; i < v.length; i++) {
      expect(back[i]).toBeCloseTo(v[i]!, 6);
    }
  });

  it('upsertEmbeddings stores and loadAllEmbeddings retrieves', () => {
    // Get a real symbol ID from the DB.
    const row = db.prepare('SELECT id FROM symbols LIMIT 1').get() as { id: number };
    const symId = row.id;
    const v1 = normalizeL2(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
    upsertEmbeddings(db, [{ symbolId: symId, vector: v1, model: 'test-model' }]);
    const loaded = loadAllEmbeddings(db, 'test-model');
    expect(loaded.size).toBe(1);
    expect(loaded.get(symId)![0]).toBeCloseTo(1.0);
    // Cleanup.
    db.prepare("DELETE FROM symbol_embeddings WHERE model = 'test-model'").run();
  });
});

describe('Phase 18.2 — normalizeL2 / cosineSimilarity', () => {
  it('normalizes to unit length', () => {
    const v = normalizeL2(new Float32Array([3, 4]));
    const len = Math.sqrt(v[0]! ** 2 + v[1]! ** 2);
    expect(len).toBeCloseTo(1.0, 5);
  });

  it('identical vectors have similarity 1', () => {
    const v = normalizeL2(new Float32Array([1, 2, 3, 4]));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('orthogonal vectors have similarity 0', () => {
    const a = normalizeL2(new Float32Array([1, 0]));
    const b = normalizeL2(new Float32Array([0, 1]));
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });
});

describe('Phase 18.3 — runEmbedJob (runs first to populate embeddings)', () => {
  it('embeds all qualifying symbols', async () => {
    const result = await runEmbedJob(db, provider, { batchSize: 10 });
    expect(result.embedded).toBeGreaterThan(0);
    expect(result.remaining).toBe(0);
    expect(result.model).toBe('mock-8d');

    const loaded = loadAllEmbeddings(db, 'mock-8d');
    expect(loaded.size).toBe(result.embedded);
  });

  it('second run is a no-op', async () => {
    const result = await runEmbedJob(db, provider);
    expect(result.embedded).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

describe('Phase 18.2 — semanticSearch', () => {
  // Ensure embeddings exist before testing search.
  beforeAll(async () => {
    await runEmbedJob(db, provider, { batchSize: 10 });
  });

  it('returns hits sorted by cosine similarity', async () => {
    const result = await semanticSearch(db, provider, {
      query: 'shopping cart add item',
      k: 5,
      threshold: 0.0, // accept anything for mock vectors
    });
    expect(result.totalEmbedded).toBeGreaterThan(0);
    expect(result.hits.length).toBeGreaterThan(0);
    // Scores should be descending.
    for (let i = 1; i < result.hits.length; i++) {
      expect(result.hits[i]!.score).toBeLessThanOrEqual(result.hits[i - 1]!.score);
    }
  });

  it('filters by kind', async () => {
    const result = await semanticSearch(db, provider, {
      query: 'cart',
      k: 50,
      kind: 'class',
      threshold: 0.0,
    });
    for (const h of result.hits) {
      expect(h.kind).toBe('class');
    }
  });
});

describe('Phase 18.4 — hybridSearch', () => {
  // Embeddings already populated by earlier describe block's beforeAll.
  it('returns results from multiple stages', async () => {
    const result = await hybridSearch(db, provider, {
      query: 'Cart',
      k: 20,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    // Must include at least an exact match (name='Cart').
    const exactHit = result.hits.find((h) => h.source === 'exact');
    expect(exactHit).toBeDefined();
    expect(exactHit!.name).toBe('Cart');
    // Stages should report counts.
    expect(result.stages.exact).toBeGreaterThan(0);
  });

  it('works without an embedding provider (first 3 stages only)', async () => {
    const result = await hybridSearch(db, null, { query: 'Cart', k: 10 });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.stages.semantic).toBe(0);
  });
});
