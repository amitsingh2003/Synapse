/**
 * Phase 18 — Embeddings module barrel export.
 */
export type { EmbeddingProvider } from './provider.js';
export { normalizeL2, cosineSimilarity } from './provider.js';
export { OllamaEmbeddingProvider, probeOllama } from './ollama.js';
export type { OllamaProviderOptions } from './ollama.js';
export { TransformersEmbeddingProvider } from './transformers.js';
export type { TransformersProviderOptions } from './transformers.js';
export {
  vectorToBlob,
  blobToVector,
  upsertEmbeddings,
  countUnembedded,
  fetchUnembeddedBatch,
  loadAllEmbeddings,
  hasEmbeddingsTable,
  clearEmbeddings,
  buildEmbeddingText,
  buildChunksFromSymbols,
} from './storage.js';
export {
  semanticSearch,
  runEmbedJob,
  hybridSearch,
} from './search.js';
export type {
  SemanticSearchOptions,
  SemanticHit,
  EmbedJobOptions,
  EmbedJobResult,
  HybridSearchOptions,
  HybridHit,
} from './search.js';
