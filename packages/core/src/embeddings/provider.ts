/**
 * Phase 18 — Embedding provider interface.
 *
 * Abstracts the mechanism used to turn a text fragment (symbol
 * name + signature + doc) into a dense vector suitable for cosine
 * similarity searches.
 */

export interface EmbeddingProvider {
  /** Human-readable model identifier stored alongside vectors. */
  readonly modelId: string;
  /** Dimensionality of the embedding vectors produced. */
  readonly dimensions: number;
  /**
   * Embed a batch of texts. Returns one Float32Array per input, all of
   * length `dimensions`. Providers should handle batching internally if
   * the underlying API has a per-request limit.
   */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Normalise a vector in-place to unit length (L2).
 * Returns the same array for convenience.
 */
export function normalizeL2(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
  }
  return v;
}

/**
 * Cosine similarity between two unit-normalised vectors.
 * If vectors are already normalised this is just the dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
