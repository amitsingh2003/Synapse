import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import chokidar, { type FSWatcher } from 'chokidar';
import { Queries } from '../db/queries.js';
import { getAdapterForFile } from '../languages/registry.js';
import { detectLanguage } from '../parser/language.js';
import { readFile } from 'node:fs/promises';
import xxhash from 'xxhash-wasm';
import { resolveReferences, type ResolveSummary } from '../resolver/resolve.js';
import { writeFileToGraph, toRelPath } from './writeFile.js';
import { shouldSkipPath } from './skipPolicy.js';
import { applyParseCaps } from './limits.js';

/** Phase 11.6 — hard cap on per-flush work so a `git checkout` of 50k files
 * can't lock up the indexer in one giant batch. Anything beyond this rolls
 * over to the next flush window. */
const MAX_BATCH = 1000;

export interface WatchOptions {
  /** Repo root to watch. */
  root: string;
  /** Debounce window in ms before re-resolving (default 250). */
  debounceMs?: number;
  /**
   * Phase 16.5 — upper bound on the adaptive debounce window during bursts.
   * Defaults to max(debounceMs × 8, 2000).
   */
  maxDebounceMs?: number;
  /** Phase 11.7 — skip files larger than this many bytes (default 1 MiB). */
  maxFileSize?: number;
  /** Per-event hook, mainly for tests + CLI logging. */
  onEvent?: (e: WatchEvent) => void;
}

export type WatchEvent =
  | { kind: 'ready'; watched: number }
  | { kind: 'indexed'; absolutePath: string; symbolCount: number; edgeCount: number; durationMs: number }
  | { kind: 'removed'; absolutePath: string }
  | { kind: 'resolved'; summary: ResolveSummary; pending: number }
  | { kind: 'skipped'; absolutePath: string; reason: 'too_large'; detail: string }
  | { kind: 'error'; absolutePath: string; error: string }
  | { kind: 'ignore_changed'; absolutePath: string };

export interface WatcherHandle {
  /** Stop watching and close the underlying chokidar instance. */
  close(): Promise<void>;
  /** Resolves once any pending debounce + resolve pass has drained. */
  flush(): Promise<void>;
}

interface HashAPI {
  h64Raw: (input: Uint8Array) => bigint;
}

/**
 * Phase 4: file watcher with debounced incremental re-index.
 *
 * Strategy:
 *   - One chokidar watcher over the repo root, with the same HARD_SKIP set as
 *     the discoverer.
 *   - Per event (add/change/unlink), enqueue the file. A trailing-debounce
 *     timer fires `flushPending()` to: re-parse changed files, drop removed
 *     files, then re-run the cross-file resolver once over the whole repo.
 *   - The resolver is cheap (a couple ms on small repos) but quadratic in the
 *     worst case — keeping it out of the per-file path avoids thrash when an
 *     editor saves several files in quick succession.
 *
 * The watcher does *not* re-resolve everything per file. It accumulates and
 * runs one resolve pass per debounce window. Tests can call `flush()` to wait
 * for that pass to complete deterministically.
 */
function isIgnoreFile(p: string): boolean {
  const name = basename(p);
  return name === ".gitignore" || name === ".synapseignore" || name === ".gitattributes";
}

export async function watchRepo(db: DB, opts: WatchOptions): Promise<WatcherHandle> {
  const root = resolve(opts.root);
  const baseDebounceMs = opts.debounceMs ?? 250;
  const maxDebounceMs = opts.maxDebounceMs ?? Math.max(baseDebounceMs * 8, 2000);
  const maxFileSize = opts.maxFileSize ?? 1_048_576;
  const onEvent = opts.onEvent ?? (() => undefined);

  const q = new Queries(db);
  const hasher = (await xxhash()) as unknown as HashAPI;

  // Per-file queue: latest event wins. 'change'/'add' get re-indexed, 'unlink' deleted.
  type Op = 'reindex' | 'delete';
  const pending = new Map<string, Op>();

  let timer: NodeJS.Timeout | null = null;
  let flushChain: Promise<void> = Promise.resolve();

  // Phase 16.5 — adaptive debounce. Track events in a sliding 1-second window;
  // a "burst" (≥ 20 events/s) ramps the debounce wait toward `maxDebounceMs`
  // so we coalesce e.g. a `git checkout` of 5k files into a single flush
  // instead of N micro-batches. Quiet periods reset the wait to baseline.
  const eventTimes: number[] = [];
  const BURST_THRESHOLD = 20; // events per second
  const computeWait = (): number => {
    const now = Date.now();
    while (eventTimes.length > 0 && now - eventTimes[0]! > 1000) eventTimes.shift();
    const rate = eventTimes.length; // per second
    if (rate < BURST_THRESHOLD) return baseDebounceMs;
    // Linear ramp 1×..8× baseline scaled by how far above threshold we are.
    const factor = Math.min(8, 1 + Math.floor((rate - BURST_THRESHOLD) / 20));
    return Math.min(maxDebounceMs, baseDebounceMs * factor);
  };

  const schedule = (): void => {
    eventTimes.push(Date.now());
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flushChain = flushChain.then(() => flushPending()).catch(() => undefined);
    }, computeWait());
  };

  async function flushPending(): Promise<void> {
    // Belt-and-braces: native FS watchers on Windows occasionally miss unlink
    // events when a file is created, modified, and deleted in quick
    // succession. Cheap sweep of every tracked file's existence catches the
    // gaps. This is O(files), runs at most once per debounce window, and the
    // common case (no missing files) is just N existsSync calls.
    // files.path is repo-relative (Phase 10); reconstruct absolute for existsSync.
    const tracked = db.prepare('SELECT path FROM files').all() as { path: string }[];
    for (const row of tracked) {
      const absTracked = resolve(root, row.path);
      if (!pending.has(absTracked) && !existsSync(absTracked)) {
        pending.set(absTracked, 'delete');
      }
    }

    if (pending.size === 0) return;
    // Phase 11.6 — cap batch size; overflow stays in `pending` for next flush.
    const allEntries = Array.from(pending.entries());
    const ops = allEntries.slice(0, MAX_BATCH);
    const overflow = allEntries.slice(MAX_BATCH);
    pending.clear();
    for (const [k, v] of overflow) pending.set(k, v);
    if (overflow.length > 0) schedule();

    for (const [absPath, op] of ops) {
      try {
        if (op === 'delete') {
          const relPath = toRelPath(absPath, root);
          const file = q.fileByPath(relPath);
          if (file) {
            db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
            onEvent({ kind: 'removed', absolutePath: absPath });
          }
        } else {
          const language = detectLanguage(absPath);
          const adapter = getAdapterForFile(absPath);
          if (!language || !adapter) continue;
          const t0 = Date.now();
          const st = await stat(absPath);
          if (st.size > maxFileSize) {
            onEvent({
              kind: 'skipped',
              absolutePath: absPath,
              reason: 'too_large',
              detail: `${(st.size / 1024).toFixed(0)} KB exceeds limit ${(maxFileSize / 1024).toFixed(0)} KB`,
            });
            continue;
          }
          const source = await readFile(absPath, 'utf8');
          const hash = hasher.h64Raw(new Uint8Array(Buffer.from(source))).toString(16);
          const parsed = await adapter.parse(source, absPath);
          applyParseCaps(parsed);
          const result = db.transaction(() =>
            writeFileToGraph(db, q, {
              absolutePath: absPath,
              repoRoot: root,
              language,
              xxhash: hash,
              mtimeMs: st.mtimeMs,
              parsed,
              content: source,
            }),
          )();
          onEvent({
            kind: 'indexed',
            absolutePath: absPath,
            symbolCount: result.symbolCount,
            edgeCount: result.edgeCount,
            durationMs: Date.now() - t0,
          });
        }
      } catch (err) {
        onEvent({
          kind: 'error',
          absolutePath: absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Single resolver pass for the whole batch — much cheaper than per-file.
    const summary = resolveReferences(db, { root });
    onEvent({ kind: 'resolved', summary, pending: pending.size });
  }

  const enqueue = (absPath: string, op: Op): void => {
    if (shouldSkipPath(absPath)) return;
    if (isIgnoreFile(absPath)) {
      onEvent({ kind: 'ignore_changed', absolutePath: absPath });
      return;
    }
    if (op === 'reindex' && !detectLanguage(absPath)) return;
    pending.set(absPath, op);
    schedule();
  };

  const watcher: FSWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (p: string) => shouldSkipPath(p),
    // Phase 11.5 — never follow symlinks; the discoverer's realpath cycle
    // guard handles the static walk, but chokidar would otherwise re-watch
    // the target through every alias.
    followSymlinks: false,
    // awaitWriteFinish would help on big files but causes missed unlink events
    // on Windows. The per-file debounce in this module already coalesces
    // back-to-back writes; rely on that instead.
    persistent: true,
  });

  watcher.on('add', (p) => enqueue(resolve(p), 'reindex'));
  watcher.on('change', (p) => enqueue(resolve(p), 'reindex'));
  watcher.on('unlink', (p) => enqueue(resolve(p), 'delete'));
  watcher.on('unlinkDir', (p) => {
    // Cascade: drop every file under this directory. Paths in DB are
    // repo-relative (Phase 10), so compute a relative prefix.
    const relPrefix = toRelPath(resolve(p), root);
    const rows = db
      .prepare("SELECT id, path FROM files WHERE path LIKE ? ESCAPE '\\'")
      .all(relPrefix.replace(/[%_\\]/g, '\\$&') + '/%') as { id: number; path: string }[];
    for (const r of rows) enqueue(resolve(root, r.path), 'delete');
  });

  await new Promise<void>((res) => {
    watcher.once('ready', () => {
      const watched = Object.values(watcher.getWatched()).reduce((n, arr) => n + arr.length, 0);
      onEvent({ kind: 'ready', watched });
      res();
    });
  });

  return {
    async close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await watcher.close();
      await flushChain;
    },
    async flush() {
      // Give the OS / chokidar a beat to surface any in-flight events before
      // we check the timer state. Native watchers on Windows have ~50ms
      // observed latency between fs op and chokidar callback. Under heavy
      // CPU load this can stretch — poll up to ~500ms for an event to land.
      for (let waited = 0; waited < 500 && !timer && pending.size === 0; waited += 80) {
        await new Promise<void>((r) => setTimeout(r, 80));
      }
      // Wait for any debounce timer to fire so its callback has chained.
      if (timer) {
        await new Promise<void>((r) => setTimeout(r, maxDebounceMs + 30));
      }
      await flushChain;
      // Always sweep for deletions the native watcher may have missed.
      flushChain = flushChain.then(() => flushPending()).catch(() => undefined);
      await flushChain;
      if (pending.size > 0 || timer) {
        if (timer) {
          await new Promise<void>((r) => setTimeout(r, maxDebounceMs + 30));
        }
        await flushChain;
      }
    },
  };
}
