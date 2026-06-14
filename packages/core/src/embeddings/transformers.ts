/**
 * TransformersEmbeddingProvider — local, CPU-based embeddings via @xenova/transformers.
 *
 * Uses `all-MiniLM-L6-v2` (quantized INT8, ~23 MB one-time download, 384 dims).
 * The ONNX pipeline is loaded once and shared; subsequent calls have no startup cost.
 * No network calls at embed time — all computation is local and free.
 */

import type { EmbeddingProvider } from './provider.js';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;
const DEFAULT_BATCH = 32;

// Singleton pipeline promise — created on first embed() call, reused forever.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipelinePromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPipeline(progressCb?: (info: any) => void): Promise<any> {
  if (!_pipelinePromise) {
    // Dynamic import keeps the ONNX runtime out of require-graph until needed.
    _pipelinePromise = import('@xenova/transformers').then(({ pipeline }) =>
      pipeline('feature-extraction', MODEL_ID, {
        quantized: true, // INT8 quantization: ~2× faster, negligible quality loss
        progress_callback: progressCb,
      }),
    );
  }
  return _pipelinePromise;
}

export interface TransformersProviderOptions {
  /** Texts-per-ONNX-batch (default 32). Lower = less peak RAM; higher = faster throughput. */
  batchSize?: number;
  /**
   * Called during first-run model download.
   * `loaded` / `total` are byte counts; `total` may be 0 if the server omits Content-Length.
   */
  onModelLoad?: (loaded: number, total: number) => void;
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = MODEL_ID;
  readonly dimensions = DIMENSIONS;

  private readonly batchSize: number;
  private readonly onModelLoad?: (loaded: number, total: number) => void;

  constructor(opts: TransformersProviderOptions = {}) {
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
    this.onModelLoad = opts.onModelLoad;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const progressCb = this.onModelLoad
      ? (info: { status: string; loaded?: number; total?: number }) => {
          if (info.status === 'progress') {
            this.onModelLoad!(info.loaded ?? 0, info.total ?? 0);
          }
        }
      : undefined;

    const extractor = await getPipeline(progressCb);
    const results: Float32Array[] = [];

    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      // pooling:'mean' + normalize:true → output shape [batchSize, 384], already unit-normed.
      const tensor = await extractor(batch, { pooling: 'mean', normalize: true });
      const flat = tensor.data as Float32Array;
      for (let i = 0; i < batch.length; i++) {
        results.push(flat.slice(i * DIMENSIONS, (i + 1) * DIMENSIONS));
      }
    }
    return results;
  }
}
