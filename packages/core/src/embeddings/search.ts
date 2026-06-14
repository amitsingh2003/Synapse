/**
 * Phase 18.2 — Semantic search: embed a natural-language query, then rank
 * all indexed symbols by cosine similarity.
 *
 * Phase 18.3 — Background embedding job: iterate symbols in batches,
 * embed via the configured provider, and upsert into `symbol_embeddings`.
 */

import type { Database as DB } from 'better-sqlite3';
import { cosineSimilarity, normalizeL2, type EmbeddingProvider } from './provider.js';
import {
  loadAllEmbeddings,
  fetchUnembeddedBatch,
  upsertEmbeddings,
  countUnembedded,
  hasEmbeddingsTable,
  buildEmbeddingText,
} from './storage.js';

// ─── Semantic search ──────────────────────────────────────────────────────

export interface SemanticSearchOptions {
  /** Natural-language query text. */
  query: string;
  /** Max results (default 10). */
  k?: number;
  /** Minimum cosine similarity threshold (default 0.3). */
  threshold?: number;
  /** Restrict to a symbol kind (function, class, method, etc.). */
  kind?: string;
}

export interface SemanticHit {
  symbolId: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  signature: string | null;
  score: number;
}

/**
 * Embed the query and rank all stored embeddings by cosine similarity.
 * Falls back gracefully if no embeddings exist yet.
 */
export async function semanticSearch(
  db: DB,
  provider: EmbeddingProvider,
  opts: SemanticSearchOptions,
): Promise<{ hits: SemanticHit[]; totalEmbedded: number }> {
  if (!hasEmbeddingsTable(db)) {
    return { hits: [], totalEmbedded: 0 };
  }

  const allVecs = loadAllEmbeddings(db, provider.modelId);
  if (allVecs.size === 0) {
    return { hits: [], totalEmbedded: 0 };
  }

  // Embed the query.
  const [queryVec] = await provider.embed([opts.query]);
  if (!queryVec) return { hits: [], totalEmbedded: allVecs.size };
  normalizeL2(queryVec);

  const k = opts.k ?? 10;
  const threshold = opts.threshold ?? 0.3;

  // Brute-force cosine over all stored vectors.
  const scored: { id: number; score: number }[] = [];
  for (const [id, vec] of allVecs) {
    const score = cosineSimilarity(queryVec, vec);
    if (score >= threshold) scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const topIds = scored.slice(0, k);

  if (topIds.length === 0) {
    return { hits: [], totalEmbedded: allVecs.size };
  }

  // Fetch symbol metadata for the top hits.
  const placeholders = topIds.map(() => '?').join(',');
  let query = `
    SELECT s.id, s.name, s.kind, s.signature, s.start_line, f.path AS file_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.id IN (${placeholders})
  `;
  const params: unknown[] = topIds.map((t) => t.id);
  if (opts.kind) {
    query += ' AND s.kind = ?';
    params.push(opts.kind);
  }

  const rows = db.prepare(query).all(...params) as {
    id: number;
    name: string;
    kind: string;
    signature: string | null;
    start_line: number;
    file_path: string;
  }[];

  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const hits: SemanticHit[] = [];
  for (const { id, score } of topIds) {
    const row = rowMap.get(id);
    if (!row) continue;
    if (opts.kind && row.kind !== opts.kind) continue;
    hits.push({
      symbolId: row.id,
      name: row.name,
      kind: row.kind,
      file: row.file_path,
      line: row.start_line,
      signature: row.signature,
      score: Math.round(score * 1000) / 1000,
    });
  }
  return { hits, totalEmbedded: allVecs.size };
}

// ─── Background embedding job (18.3) ─────────────────────────────────────

export interface EmbedJobOptions {
  /** Max symbols per batch (default 64). */
  batchSize?: number;
  /** Max total symbols to embed in one run (default Infinity). */
  maxSymbols?: number;
  /** Callback for progress reporting. */
  onProgress?: (done: number, total: number) => void;
}

export interface EmbedJobResult {
  embedded: number;
  remaining: number;
  model: string;
}

/**
 * Embed all symbols that don't yet have an embedding for the given model.
 * Runs synchronously in batches; safe to call from the watcher idle hook
 * or the CLI.
 */
export async function runEmbedJob(
  db: DB,
  provider: EmbeddingProvider,
  opts: EmbedJobOptions = {},
): Promise<EmbedJobResult> {
  const batchSize = opts.batchSize ?? 64;
  const maxSymbols = opts.maxSymbols ?? Infinity;
  const model = provider.modelId;

  let embedded = 0;
  const total = countUnembedded(db, model);
  const cap = Math.min(total, maxSymbols);

  while (embedded < cap) {
    const batch = fetchUnembeddedBatch(db, model, Math.min(batchSize, cap - embedded));
    if (batch.length === 0) break;

    const texts = batch.map((b) => b.text);
    const vectors = await provider.embed(texts);

    const rows = batch.map((b, i) => ({
      symbolId: b.id,
      vector: vectors[i]!,
      model,
    }));
    upsertEmbeddings(db, rows);
    embedded += batch.length;
    opts.onProgress?.(embedded, cap);
  }

  const remaining = countUnembedded(db, model);
  return { embedded, remaining, model };
}

// ─── Hybrid ranker (18.4) ─────────────────────────────────────────────────

export interface HybridSearchOptions {
  query: string;
  k?: number;
  kind?: string;
  language?: string;
  fileGlob?: string;
}

export interface HybridHit {
  symbolId: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  signature: string | null;
  /** Which retrieval stage produced this hit. */
  source: 'exact' | 'fts' | 'fuzzy' | 'semantic';
  /** Composite relevance score (higher = better). */
  score: number;
}

/**
 * Phase 18.4 / 23.2 — Hybrid ranker with Reciprocal Rank Fusion (RRF).
 *
 * Combines four retrieval stages:
 *   1. **Exact** — direct name match
 *   2. **FTS** — FTS5 trigram MATCH
 *   3. **Fuzzy** — LIKE %query% with length tiebreak
 *   4. **Semantic** — cosine similarity
 *
 * Phase 23.2: Uses RRF (k=60) instead of fixed weights. Each stage produces
 * a ranked list; a hit's final score = Σ 1/(k + rank_in_stage). This is
 * parameter-free, rank-only, and consistently outperforms weighted-sum in
 * IR benchmarks.
 *
 * Deduplicates by symbol_id, fusing scores across stages.
 */
export async function hybridSearch(
  db: DB,
  provider: EmbeddingProvider | null,
  opts: HybridSearchOptions,
): Promise<{ hits: HybridHit[]; stages: Record<string, number> }> {
  const k = opts.k ?? 20;
  const RRF_K = 60; // Standard RRF constant.
  const stages = { exact: 0, fts: 0, fuzzy: 0, semantic: 0 };

  // Each stage produces ranked results; we'll fuse them via RRF.
  type StageName = 'exact' | 'fts' | 'fuzzy' | 'semantic';
  const stageResults: Array<{ stage: StageName; rows: SymRow[] }> = [];

  // Build filter clauses.
  const filters: string[] = [];
  const filterParams: unknown[] = [];
  if (opts.kind) {
    filters.push('s.kind = ?');
    filterParams.push(opts.kind);
  }
  if (opts.language) {
    filters.push('s.language = ?');
    filterParams.push(opts.language);
  }
  if (opts.fileGlob) {
    const like = opts.fileGlob.replace(/\*/g, '%');
    filters.push('f.path LIKE ?');
    filterParams.push(like);
  }
  const whereClause = filters.length > 0 ? 'AND ' + filters.join(' AND ') : '';

  // Stage 1: Exact name match.
  {
    const rows = db
      .prepare(
        `SELECT s.id, s.name, s.kind, s.signature, s.start_line, f.path AS file_path
         FROM symbols s JOIN files f ON s.file_id = f.id
         WHERE s.name = ? ${whereClause}
         LIMIT ?`,
      )
      .all(opts.query, ...filterParams, k * 2) as SymRow[];
    stageResults.push({ stage: 'exact', rows });
    stages.exact = rows.length;
  }

  // Stage 2: FTS match (if FTS table exists).
  {
    const hasFts = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') AND name = 'symbols_fts'")
      .get();
    if (hasFts && opts.query.length >= 3) {
      const ftsParam = `"${opts.query.replace(/"/g, '""')}"`;
      try {
        const rows = db
          .prepare(
            `SELECT s.id, s.name, s.kind, s.signature, s.start_line, f.path AS file_path
             FROM symbols_fts AS fts
             JOIN symbols s ON s.id = fts.rowid
             JOIN files f ON s.file_id = f.id
             WHERE symbols_fts MATCH ? ${whereClause}
             LIMIT ?`,
          )
          .all(ftsParam, ...filterParams, k * 2) as SymRow[];
        stageResults.push({ stage: 'fts', rows });
        stages.fts = rows.length;
      } catch {
        // FTS may fail on some query patterns — fall through.
      }
    }
  }

  // Stage 3: Fuzzy (LIKE %query%).
  {
    const likeParam = `%${opts.query.replace(/[%_]/g, '\\$&')}%`;
    const rows = db
      .prepare(
        `SELECT s.id, s.name, s.kind, s.signature, s.start_line, f.path AS file_path
         FROM symbols s JOIN files f ON s.file_id = f.id
         WHERE s.name LIKE ? ESCAPE '\\' ${whereClause}
         ORDER BY length(s.name), s.name
         LIMIT ?`,
      )
      .all(likeParam, ...filterParams, k * 2) as SymRow[];
    stageResults.push({ stage: 'fuzzy', rows });
    stages.fuzzy = rows.length;
  }

  // Stage 4: Semantic (if provider is available and embeddings exist).
  if (provider && hasEmbeddingsTable(db)) {
    try {
      const sem = await semanticSearch(db, provider, {
        query: opts.query,
        k: k * 2,
        kind: opts.kind,
      });
      const rows: SymRow[] = sem.hits.map((h) => ({
        id: h.symbolId,
        name: h.name,
        kind: h.kind,
        signature: h.signature,
        start_line: h.line,
        file_path: h.file,
      }));
      stageResults.push({ stage: 'semantic', rows });
      stages.semantic = rows.length;
    } catch {
      // Embedding provider unreachable — skip silently.
    }
  }

  // ─── RRF Fusion ──────────────────────────────────────────────────────────
  // For each stage, assign rank 0, 1, 2… to its results (in stage order).
  // A symbol's RRF score = Σ 1 / (RRF_K + rank) across all stages it appears in.
  const rrfScores = new Map<number, { score: number; row: SymRow; bestStage: StageName }>();

  for (const { stage, rows } of stageResults) {
    for (let rank = 0; rank < rows.length; rank++) {
      const r = rows[rank]!;
      const contribution = 1 / (RRF_K + rank);
      const existing = rrfScores.get(r.id);
      if (existing) {
        existing.score += contribution;
      } else {
        rrfScores.set(r.id, { score: contribution, row: r, bestStage: stage });
      }
    }
  }

  // Sort by RRF score descending.
  const fused = Array.from(rrfScores.values());
  fused.sort((a, b) => b.score - a.score);

  const hits: HybridHit[] = fused.slice(0, k).map((entry) => ({
    symbolId: entry.row.id,
    name: entry.row.name,
    kind: entry.row.kind,
    file: entry.row.file_path,
    line: entry.row.start_line,
    signature: entry.row.signature,
    source: entry.bestStage,
    score: Math.round(entry.score * 1000) / 1000,
  }));

  return { hits, stages };
}

type SymRow = {
  id: number;
  name: string;
  kind: string;
  signature: string | null;
  start_line: number;
  file_path: string;
};

// Re-export buildEmbeddingText for external use.
export { buildEmbeddingText };
