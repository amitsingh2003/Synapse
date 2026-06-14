import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import { Queries } from '../db/queries.js';
import { setManifestValue } from '../db/open.js';
import { getAdapterForFile } from '../languages/registry.js';
import { resolveReferences, type ResolveSummary } from '../resolver/resolve.js';
import { discoverFiles, type DiscoveredFile } from './discover.js';
import { writeFileToGraph } from './writeFile.js';
import { applyParseCaps } from './limits.js';

export interface IndexRepoOptions {
  /** Absolute path to the repo root. */
  root: string;
  /** Max files parsed in parallel (default: CPU count, capped at 8). */
  concurrency?: number;
  /** Skip files whose content xxhash matches the previously indexed one. */
  skipUnchanged?: boolean;
  /** Callback invoked once per file (success or skip) for progress reporting. */
  onProgress?: (event: ProgressEvent) => void;
  /** Disable the post-index cross-reference resolver. */
  skipResolve?: boolean;
  /**
   * Restrict indexing to the given adapter ids (e.g. `['typescript']`).
   * Files whose adapter is not in the set are filtered out before indexing.
   * When omitted, all registered adapters are indexed.
   */
  languages?: readonly string[];
}

export type ProgressEvent =
  | { kind: 'discovered'; total: number }
  | { kind: 'indexed'; file: DiscoveredFile; symbolCount: number; edgeCount: number }
  | { kind: 'skipped'; file: DiscoveredFile; reason: 'unchanged' | 'error'; error?: string }
  | { kind: 'resolving' }
  | { kind: 'resolved'; summary: ResolveSummary };

export interface SkipBreakdown {
  unsupported_language: number;
  too_large: number;
  permission_error: number;
  read_error: number;
  symlink_cycle: number;
  parse_error: number;
  unchanged: number;
}

export interface IndexRepoSummary {
  filesDiscovered: number;
  filesIndexed: number;
  filesSkipped: number;
  /** Breakdown of why files were skipped (Phase 9). */
  skipReasons: SkipBreakdown;
  symbolCount: number;
  edgeCount: number;
  durationMs: number;
  /** Phase 13 — count of indexed files keyed by adapter id. */
  indexedByLanguage: Record<string, number>;
  resolve?: ResolveSummary;
}

/**
 * Phase 2: crawl a repo, parse every supported file in parallel, write all
 * symbols/edges to SQLite. Honours .gitignore and skips unchanged files when
 * possible.
 *
 * Sets `indexing=true` in the manifest at the start and always clears it on
 * completion or error — the MCP server reads this flag to warn the AI that
 * results may be partial while a background reindex is in progress.
 */
export async function indexRepo(db: DB, opts: IndexRepoOptions): Promise<IndexRepoSummary> {
  const root = resolve(opts.root);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, 16));
  const onProgress = opts.onProgress ?? (() => undefined);

  const t0 = Date.now();

  const skipReasons: SkipBreakdown = {
    unsupported_language: 0,
    too_large: 0,
    permission_error: 0,
    read_error: 0,
    symlink_cycle: 0,
    parse_error: 0,
    unchanged: 0,
  };

  const files = await discoverFiles({
    root,
    onSkip: (skip) => {
      skipReasons[skip.reason]++;
    },
  });

  // Phase 13: optional `--languages` filter — keep only files whose adapter
  // id is in the requested set. Unknown adapter ids are silently ignored.
  const langFilter = opts.languages && opts.languages.length > 0
    ? new Set(opts.languages)
    : null;
  const effectiveFiles = langFilter
    ? files.filter((f) => {
        const id = getAdapterForFile(f.absolutePath)?.id;
        return id !== undefined && langFilter.has(id);
      })
    : files;
  onProgress({ kind: 'discovered', total: effectiveFiles.length });

  const q = new Queries(db);

  // Phase 10: persist the repo root in manifest for portability.
  setManifestValue(db, 'repo_root', root);

  // Signal to the MCP server that indexing is active. Always cleared in the
  // finally block so a crashed process leaves an observable stale flag that
  // auto-sync detects on next startup and triggers a recovery reindex.
  setManifestValue(db, 'indexing', 'true');
  setManifestValue(db, 'indexing_since', new Date().toISOString());

  try {
    // Build a fast lookup of previously seen hashes so we can short-circuit.
    // files.path is now repo-relative (Phase 10), so key by relPath.
    const prevHashes = new Map<string, string | null>();
    if (opts.skipUnchanged) {
      const rows = db
        .prepare('SELECT path, xxhash FROM files')
        .all() as { path: string; xxhash: string | null }[];
      for (const r of rows) prevHashes.set(r.path, r.xxhash);
    }

    let symbolCount = 0;
    let edgeCount = 0;
    let filesIndexed = 0;
    let filesSkipped = 0;
    const indexedByLanguage: Record<string, number> = {};

    // Hand-rolled bounded-concurrency runner. We deliberately do not use piscina
    // here: parsing dominates I/O and the tree-sitter WASM cache lives in the
    // main process. Workers would force one-WASM-instance-per-worker, eating the
    // gains for repos under a few thousand files.
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < effectiveFiles.length) {
        const i = cursor++;
        const file = effectiveFiles[i]!;
        const fileRelPath = relative(root, file.absolutePath).split(sep).join('/');
        if (opts.skipUnchanged && prevHashes.get(fileRelPath) === file.xxhash) {
          filesSkipped++;
          skipReasons.unchanged++;
          onProgress({ kind: 'skipped', file, reason: 'unchanged' });
          continue;
        }
        try {
          const result = await indexOneFile(db, q, file, root);
          symbolCount += result.symbolCount;
          edgeCount += result.edgeCount;
          filesIndexed++;
          const langId = getAdapterForFile(file.absolutePath)?.id ?? 'unknown';
          indexedByLanguage[langId] = (indexedByLanguage[langId] ?? 0) + 1;
          onProgress({
            kind: 'indexed',
            file,
            symbolCount: result.symbolCount,
            edgeCount: result.edgeCount,
          });
        } catch (err) {
          filesSkipped++;
          skipReasons.parse_error++;
          onProgress({
            kind: 'skipped',
            file,
            reason: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    let resolveSummary: ResolveSummary | undefined;
    if (!opts.skipResolve) {
      onProgress({ kind: 'resolving' });
      resolveSummary = resolveReferences(db, { root });
      onProgress({ kind: 'resolved', summary: resolveSummary });
    }

    return {
      filesDiscovered: effectiveFiles.length,
      filesIndexed,
      filesSkipped,
      skipReasons,
      symbolCount,
      edgeCount,
      durationMs: Date.now() - t0,
      indexedByLanguage,
      resolve: resolveSummary,
    };
  } finally {
    setManifestValue(db, 'indexing', 'false');
  }
}

/**
 * Parse one already-discovered file and atomically rewrite its rows.
 *
 * This is the multi-file variant of `indexFile` and shares the same
 * clear-then-insert primitive — the watcher will reuse it in Phase 4.
 */
async function indexOneFile(
  db: DB,
  q: Queries,
  file: DiscoveredFile,
  repoRoot: string,
): Promise<{ symbolCount: number; edgeCount: number }> {
  const source = await readFile(file.absolutePath, 'utf8');
  const adapter = getAdapterForFile(file.absolutePath);
  if (!adapter) {
    throw new Error(`No language adapter for ${file.absolutePath}`);
  }
  const parsed = await adapter.parse(source, file.absolutePath);
  applyParseCaps(parsed);

  return db.transaction(() => {
    const r = writeFileToGraph(db, q, {
      absolutePath: file.absolutePath,
      repoRoot,
      language: file.language,
      xxhash: file.xxhash,
      mtimeMs: file.mtimeMs,
      parsed,
      content: source,
    });
    return { symbolCount: r.symbolCount, edgeCount: r.edgeCount };
  })();
}
