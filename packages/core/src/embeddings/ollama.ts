/**
 * Phase 18.1 — Ollama embedding provider.
 *
 * Calls the local Ollama HTTP API (`/api/embed`) to generate embeddings.
 * Requires a running Ollama instance (e.g. `ollama serve`) with a model
 * that supports embeddings pulled (e.g. `nomic-embed-text`, `mxbai-embed-large`).
 *
 * No external npm dependencies — uses the built-in `fetch`.
 */

import { normalizeL2, type EmbeddingProvider } from './provider.js';

export interface OllamaProviderOptions {
  /** Ollama model name (default `nomic-embed-text`). */
  model?: string;
  /** Base URL of the Ollama server (default `http://127.0.0.1:11434`). */
  baseUrl?: string;
  /** Timeout per request in ms (default 60 000). */
  timeoutMs?: number;
  /** Max texts per API call (default 64). Ollama batches internally. */
  batchSize?: number;
}

interface OllamaEmbedResponse {
  embeddings: number[][];
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly batchSize: number;
  private _dimensions: number | null = null;

  constructor(opts: OllamaProviderOptions = {}) {
    this.modelId = opts.model ?? 'nomic-embed-text';
    const base = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.url = `${base}/api/embed`;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.batchSize = opts.batchSize ?? 64;
  }

  get dimensions(): number {
    if (this._dimensions === null) {
      throw new Error(
        'OllamaEmbeddingProvider.dimensions is unknown until the first embed() call. ' +
          'Call embed(["test"]) once to auto-detect.',
      );
    }
    return this._dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const results: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const vecs = await this._call(batch);
      results.push(...vecs);
    }
    return results;
  }

  private async _call(input: string[]): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.modelId, input }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama embed failed (${res.status}): ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as OllamaEmbedResponse;
      const vectors = json.embeddings.map((arr) => {
        const f32 = new Float32Array(arr);
        return normalizeL2(f32);
      });
      if (vectors.length > 0 && this._dimensions === null) {
        this._dimensions = vectors[0]!.length;
      }
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Probe whether the Ollama server is reachable and the model is available.
 * Returns the embedding dimension on success, or null on failure.
 */
export async function probeOllama(opts?: OllamaProviderOptions): Promise<number | null> {
  try {
    const provider = new OllamaEmbeddingProvider(opts);
    const [vec] = await provider.embed(['test']);
    return vec?.length ?? null;
  } catch {
    return null;
  }
}
