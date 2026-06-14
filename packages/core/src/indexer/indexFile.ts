import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import { Queries } from '../db/queries.js';
import { detectLanguage } from '../parser/language.js';
import { getAdapterForFile } from '../languages/registry.js';
import type { ExtractedSymbol, ExtractedEdge } from '../parser/extract.js';
import { writeFileToGraph } from './writeFile.js';
import { applyParseCaps } from './limits.js';

export interface IndexFileResult {
  absolutePath: string;
  language: string;
  fileId: number;
  symbolCount: number;
  edgeCount: number;
}

export interface IndexFileOptions {
  /** Optional repo root to anchor scip-ids. Falls back to file basename. */
  repoRoot?: string;
}

/**
 * Phase 1: parse a single file and atomically (re)write its symbols + edges.
 *
 * The transaction guarantees readers never see a partial state — they either
 * see the file's old contents or its new contents.
 */
export async function indexFile(
  db: DB,
  path: string,
  opts: IndexFileOptions = {},
): Promise<IndexFileResult> {
  const absolutePath = resolve(path);
  const adapter = getAdapterForFile(absolutePath);
  const language = detectLanguage(absolutePath);
  if (!adapter || !language) {
    throw new Error(`Unsupported file extension: ${absolutePath}`);
  }

  const [source, stats] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);
  const parsed = await adapter.parse(source, absolutePath);
  applyParseCaps(parsed);

  const q = new Queries(db);

  const result = db.transaction(() =>
    writeFileToGraph(db, q, {
      absolutePath,
      repoRoot: opts.repoRoot ?? dirname(absolutePath),
      language,
      mtimeMs: stats.mtimeMs,
      parsed,
      content: source,
    }),
  )();

  return {
    absolutePath,
    language,
    fileId: result.fileId,
    symbolCount: result.symbolCount,
    edgeCount: result.edgeCount,
  };
}

export type { ExtractedSymbol, ExtractedEdge };
