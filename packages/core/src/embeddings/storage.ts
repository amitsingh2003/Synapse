/**
 * Phase 18.1 — Embedding storage: schema migration + CRUD queries.
 *
 * Stores dense vectors as raw Float32Array BLOBs (4 bytes × dimensions).
 * Table `symbol_embeddings`:
 *   symbol_id   — FK to symbols.id (1:1, CASCADE delete)
 *   vector      — BLOB, raw little-endian IEEE-754 float32
 *   model       — model identifier string (to invalidate on model change)
 *   embedded_at — unix ms when this embedding was written
 *
 * Storage is deliberately simple — no ANN index. At 50k symbols × 768 dims
 * that's ~150 MB of BLOBs; we load only when semantic_search is invoked and
 * stream results with a threshold cutoff.
 */

import type { Database as DB } from 'better-sqlite3';

// ─── Schema ───────────────────────────────────────────────────────────────

export const M_007_EMBEDDINGS = `
CREATE TABLE IF NOT EXISTS symbol_embeddings (
  symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  vector      BLOB    NOT NULL,
  model       TEXT    NOT NULL,
  embedded_at INTEGER NOT NULL
);
UPDATE manifest SET value = '7' WHERE key = 'schema_version';
`;

// ─── Helpers ──────────────────────────────────────────────────────────────

export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToVector(buf: Buffer): Float32Array {
  // Ensure alignment by copying into a new ArrayBuffer.
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  view.set(buf);
  return new Float32Array(ab);
}

// ─── Queries ──────────────────────────────────────────────────────────────

export interface EmbeddingRow {
  symbol_id: number;
  vector: Buffer;
  model: string;
  embedded_at: number;
}

/**
 * Upsert a batch of embeddings. Uses a single transaction for efficiency.
 */
export function upsertEmbeddings(
  db: DB,
  rows: { symbolId: number; vector: Float32Array; model: string }[],
): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO symbol_embeddings (symbol_id, vector, model, embedded_at)
    VALUES (?, ?, ?, ?)
  `);
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.symbolId, vectorToBlob(r.vector), r.model, now);
    }
  });
  tx();
}

/**
 * Count symbols that have no embedding (or a stale model).
 */
export function countUnembedded(db: DB, model: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM symbols s
       WHERE s.kind IN ('function','class','method','type','interface')
         AND NOT EXISTS (
           SELECT 1 FROM symbol_embeddings e
           WHERE e.symbol_id = s.id AND e.model = ?
         )`,
    )
    .get(model) as { c: number };
  return row.c;
}

/**
 * Fetch the next batch of symbols needing embedding.
 * Returns [symbolId, textToEmbed] pairs.
 */
export function fetchUnembeddedBatch(
  db: DB,
  model: string,
  limit: number,
): { id: number; text: string }[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.signature, s.doc
       FROM symbols s
       WHERE s.kind IN ('function','class','method','type','interface')
         AND NOT EXISTS (
           SELECT 1 FROM symbol_embeddings e
           WHERE e.symbol_id = s.id AND e.model = ?
         )
       LIMIT ?`,
    )
    .all(model, limit) as { id: number; name: string; kind: string; signature: string | null; doc: string | null }[];

  return rows.map((r) => ({
    id: r.id,
    text: buildEmbeddingText(r.name, r.kind, r.signature, r.doc),
  }));
}

/**
 * Build the text string that gets embedded for a symbol.
 * Combines name, kind, signature, and doc into a compact representation.
 *
 * Phase 23.5: Optionally includes a source body chunk (AST-aware). When
 * `sourceChunk` is provided, the embedding captures semantics of the
 * implementation, not just the signature line.
 */
export function buildEmbeddingText(
  name: string,
  kind: string,
  signature: string | null,
  doc: string | null,
  sourceChunk?: string | null,
): string {
  let text = `${kind}: ${name}`;
  if (signature) text += `\n${signature}`;
  if (doc) text += `\n${doc.slice(0, 500)}`; // Cap doc to avoid huge inputs.
  if (sourceChunk) {
    // Phase 23.5: append first 800 chars of the symbol body to capture semantics.
    text += `\n---\n${sourceChunk.slice(0, 800)}`;
  }
  return text;
}

/**
 * Phase 23.5 — AST-aware semantic chunking.
 *
 * Given a source file and pre-extracted symbol spans, produces one chunk per
 * symbol at its natural AST boundaries. This keeps entire functions/classes
 * intact in a single embedding unit, dramatically improving RAG recall vs
 * fixed-window chunking.
 *
 * Returns an array of { symbolId, text } ready for embedding.
 */
export function buildChunksFromSymbols(
  db: DB,
  fileId: number,
  source: string,
  model: string,
): { id: number; text: string }[] {
  const lines = source.split('\n');
  const symbols = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.signature, s.doc, s.start_line, s.end_line
       FROM symbols s
       WHERE s.file_id = ?
         AND s.kind IN ('function','class','method','type','interface')
         AND NOT EXISTS (
           SELECT 1 FROM symbol_embeddings e
           WHERE e.symbol_id = s.id AND e.model = ?
         )
       ORDER BY s.start_line`,
    )
    .all(fileId, model) as Array<{
    id: number;
    name: string;
    kind: string;
    signature: string | null;
    doc: string | null;
    start_line: number;
    end_line: number;
  }>;

  return symbols.map((s) => {
    const startIdx = Math.max(0, s.start_line - 1);
    const endIdx = Math.min(lines.length, s.end_line);
    const body = lines.slice(startIdx, endIdx).join('\n');
    return {
      id: s.id,
      text: buildEmbeddingText(s.name, s.kind, s.signature, s.doc, body),
    };
  });
}

/**
 * Load all embeddings for a given model (for brute-force search).
 * Returns a Map: symbol_id → Float32Array (unit-normalised on write).
 */
export function loadAllEmbeddings(
  db: DB,
  model: string,
): Map<number, Float32Array> {
  const rows = db
    .prepare('SELECT symbol_id, vector FROM symbol_embeddings WHERE model = ?')
    .all(model) as { symbol_id: number; vector: Buffer }[];
  const map = new Map<number, Float32Array>();
  for (const r of rows) {
    map.set(r.symbol_id, blobToVector(r.vector));
  }
  return map;
}

/**
 * Check if the `symbol_embeddings` table exists.
 */
export function hasEmbeddingsTable(db: DB): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_embeddings'")
    .get() as { name: string } | undefined;
  return !!row;
}

/**
 * Delete all embeddings for a specific model.
 */
export function clearEmbeddings(db: DB, model: string): number {
  const info = db.prepare('DELETE FROM symbol_embeddings WHERE model = ?').run(model);
  return info.changes;
}
