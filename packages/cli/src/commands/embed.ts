/**
 * `synapse embed` CLI command.
 *
 * Embeds symbols into the vector store using Transformers.js by default
 * (fully local, no server required) or Ollama when --provider=ollama is set.
 *
 * The Transformers.js model (~23 MB, INT8 quantized) is downloaded once to
 * ~/.cache/huggingface/hub on first run and reused on all subsequent runs.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  openDatabase,
  TransformersEmbeddingProvider,
  OllamaEmbeddingProvider,
  probeOllama,
  runEmbedJob,
  type EmbeddingProvider,
} from '@synapse/core';

export interface EmbedOptions {
  dbPath?: string;
  /** 'transformers' (default, local/free) or 'ollama' (requires running server). */
  provider?: 'transformers' | 'ollama';
  /** Model name — used only when provider='ollama' (default 'nomic-embed-text'). */
  model?: string;
  ollamaUrl?: string;
  batchSize?: number;
  maxSymbols?: number;
}

export async function runEmbed(opts: EmbedOptions): Promise<number> {
  const dbPath = opts.dbPath ?? resolve(process.cwd(), '.synapse', 'graph.db');
  if (!existsSync(dbPath)) {
    process.stderr.write(`embed: DB not found at ${dbPath}\n`);
    return 1;
  }

  const providerName = opts.provider ?? 'transformers';
  let provider: EmbeddingProvider;

  if (providerName === 'ollama') {
    const model = opts.model ?? 'nomic-embed-text';
    const baseUrl = opts.ollamaUrl;
    process.stdout.write(`Probing Ollama (model=${model})...\n`);
    const dims = await probeOllama({ model, baseUrl });
    if (dims === null) {
      process.stderr.write(
        `embed: cannot reach Ollama or model "${model}" is not available.\n` +
          `Ensure \`ollama serve\` is running and \`ollama pull ${model}\` has been done.\n`,
      );
      return 1;
    }
    process.stdout.write(`  ✓ connected — ${dims}-dimensional embeddings\n`);
    provider = new OllamaEmbeddingProvider({ model, baseUrl, batchSize: opts.batchSize });
  } else {
    process.stdout.write(`Provider: Transformers.js (all-MiniLM-L6-v2, local, free)\n`);
    process.stdout.write(`  First run downloads ~23 MB model to ~/.cache/huggingface/hub\n`);
    let lastPct = -1;
    provider = new TransformersEmbeddingProvider({
      batchSize: opts.batchSize,
      onModelLoad: (loaded: number, total: number) => {
        if (total > 0) {
          const pct = Math.floor((loaded / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            process.stdout.write(`  Downloading model: ${pct}%\r`);
          }
        }
      },
    });
  }

  const db = openDatabase({ path: dbPath });
  try {
    process.stdout.write(`\n`);
    const t0 = Date.now();
    const result = await runEmbedJob(db, provider, {
      batchSize: opts.batchSize,
      maxSymbols: opts.maxSymbols,
      onProgress: (done, total) => {
        process.stdout.write(`  embedded ${done}/${total}\r`);
      },
    });
    const elapsed = Date.now() - t0;
    process.stdout.write(`\n  done: ${result.embedded} symbols embedded in ${elapsed}ms\n`);
    if (result.remaining > 0) {
      process.stdout.write(`  ${result.remaining} symbols remain (re-run to continue)\n`);
    }
  } finally {
    db.close();
  }
  return 0;
}
