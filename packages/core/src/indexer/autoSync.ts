/**
 * Auto-sync — starts automatically when the MCP server launches so users
 * never have to remember to run `synapse watch` or `synapse reindex`.
 *
 * Startup sequence (all edge cases handled):
 *
 *  1. Acquire watcher.lock — if held by another MCP instance, become a
 *     silent read-only client. No duplicate watchers, no race conditions.
 *
 *  2. Open a private writable DB handle. The MCP server's own handle stays
 *     read-only; SQLite WAL lets them coexist safely.
 *
 *  3. Crash recovery — if `indexing=true` is still set in the manifest, a
 *     previous run crashed mid-reindex. Force a full reindex to restore
 *     consistency regardless of HEAD or mtime state.
 *
 *  4. Git HEAD check (debounced 60 s to survive rapid MCP restarts):
 *     - Non-git repo / git not installed → skip, go to step 5.
 *     - Git worktrees work correctly because we call `git rev-parse HEAD`
 *       rather than reading `.git/HEAD` directly.
 *     - Detached HEAD, shallow clones, new-branch switches all produce a
 *       changed HEAD → trigger reindex.
 *
 *  5. Stale mtime fallback — catches changes that happened while the watcher
 *     was not running (git stash pop, git checkout -- file, laptop sleep).
 *     Samples up to 200 files; if any are newer on disk than indexed_at, a
 *     full incremental reindex runs (xxhash skips unchanged files).
 *
 *  6. Start chokidar watcher for ongoing file changes.
 *     - .gitignore / .synapseignore changes emit `ignore_changed` and
 *       trigger a full reindex (ignore rules may have changed).
 *     - Rapid bursts (git checkout of many files) are coalesced by the
 *       watcher's adaptive debounce before flushing.
 *     - Symlinks are never followed (chokidar option).
 *
 *  7. On close() — watcher stops, lock released, writable DB closed.
 *     Called automatically when the MCP server shuts down.
 *
 * Before each background reindex we try to acquire index.lock.  If the CLI
 * (`synapse init` / `synapse reindex`) already holds it we skip our
 * reindex — the CLI is already handling it.
 */

import { resolve as pathResolve, dirname } from 'node:path';
import { statSync } from 'node:fs';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase, getManifestValue, setManifestValue } from '../db/open.js';
import { acquireLock, type LockHandle } from './lock.js';
import { watchRepo, type WatcherHandle, type WatchOptions } from './watcher.js';
import { indexRepo } from './indexRepo.js';
import { getCurrentHead } from '../git.js';
import { log } from '../log.js';

const WATCHER_LOCK = 'watcher.lock';
const HEAD_CHECK_DEBOUNCE_MS = 60_000;
const STALE_GRACE_MS = 2_000;
const STALE_SAMPLE_LIMIT = 200;

export interface AutoSyncOptions {
  /** Absolute path to the .synapse/graph.db file. */
  dbPath: string;
  /**
   * Forwarded to watchRepo for tuning debounce / file-size limits.
   * onEvent from here is merged with the internal ignore-file handler.
   */
  watchOptions?: Partial<Pick<WatchOptions, 'debounceMs' | 'maxDebounceMs' | 'maxFileSize' | 'onEvent'>>;
  /** Override the HEAD re-check debounce for tests. Default 60 000 ms. */
  headCheckDebounceMs?: number;
}

export interface AutoSyncHandle {
  /** Stop the watcher, release the lock, and close the writable DB handle. */
  close(): Promise<void>;
}

/**
 * Start background auto-sync. Never throws — all errors are logged and the
 * MCP server starts regardless.
 */
export async function startAutoSync(opts: AutoSyncOptions): Promise<AutoSyncHandle> {
  const dbPath = opts.dbPath;
  const dbDir = dirname(dbPath);
  const debounceMs = opts.headCheckDebounceMs ?? HEAD_CHECK_DEBOUNCE_MS;

  let wdb: DB | null = null;
  let lockHandle: LockHandle | null = null;
  let watcherHandle: WatcherHandle | null = null;
  let reindexInProgress = false;

  const cleanup = async (): Promise<void> => {
    try { await watcherHandle?.close(); } catch { /* ignore */ }
    watcherHandle = null;
    try { lockHandle?.release(); } catch { /* ignore */ }
    lockHandle = null;
    try { wdb?.close(); } catch { /* ignore */ }
    wdb = null;
  };

  try {
    // ── Step 1: watcher lock ─────────────────────────────────────────────────
    try {
      lockHandle = acquireLock(dbDir, `pid=${process.pid}`, WATCHER_LOCK);
    } catch {
      // Another MCP instance is already watching — be a silent reader.
      log.info('auto-sync: watcher already running in another process, skipping');
      return { close: async () => {} };
    }

    // ── Step 2: writable DB + repo root ─────────────────────────────────────
    wdb = openDatabase({ path: dbPath, readonly: false });
    const root = getManifestValue(wdb, 'repo_root');
    if (!root) {
      log.warn('auto-sync: repo_root not set in manifest — run `synapse init` first');
      await cleanup();
      return { close: async () => {} };
    }

    // ── Step 3: crash recovery ───────────────────────────────────────────────
    const crashedMidIndex = getManifestValue(wdb, 'indexing') === 'true';
    if (crashedMidIndex) {
      log.warn('auto-sync: detected stale indexing=true from a crashed session — forcing reindex');
    }

    // ── Steps 4+5: HEAD check + stale fallback ───────────────────────────────
    const now = Date.now();
    const lastCheckMs = Number(getManifestValue(wdb, 'last_head_check_ms') ?? '0') || 0;
    const skipHeadCheck = !crashedMidIndex && (now - lastCheckMs) < debounceMs;

    let reindexTriggered = false;

    if (!skipHeadCheck) {
      // Record the check time immediately so rapid restarts don't all pile in.
      setManifestValue(wdb, 'last_head_check_ms', String(now));

      const currentHead = await getCurrentHead(root);

      if (currentHead !== null) {
        const lastHead = getManifestValue(wdb, 'last_indexed_head');
        if (crashedMidIndex || lastHead !== currentHead) {
          const reason = crashedMidIndex
            ? 'crash recovery'
            : `HEAD changed ${lastHead ?? '(none)'} → ${currentHead.slice(0, 8)}`;
          log.info(`auto-sync: reindexing — ${reason}`);
          await runReindex(wdb, root, dbDir);
          setManifestValue(wdb, 'last_indexed_head', currentHead);
          reindexTriggered = true;
        } else {
          log.info('auto-sync: HEAD unchanged, skipping full reindex', { head: currentHead.slice(0, 8) });
        }
      } else {
        // Non-git repo or git unavailable.
        if (crashedMidIndex) {
          log.info('auto-sync: reindexing — crash recovery (non-git repo)');
          await runReindex(wdb, root, dbDir);
          reindexTriggered = true;
        } else {
          log.info('auto-sync: non-git repo, relying on mtime staleness check');
        }
      }
    }

    // Stale mtime fallback — catches changes while the watcher was not running
    // (git stash pop, git checkout -- file, waking from sleep, etc.).
    if (!reindexTriggered) {
      const staleCount = countStaleFiles(wdb, root);
      if (staleCount > 0) {
        log.info(`auto-sync: ${staleCount} stale file(s) detected by mtime, triggering reindex`);
        await runReindex(wdb, root, dbDir);
        const head = await getCurrentHead(root);
        if (head) setManifestValue(wdb, 'last_indexed_head', head);
        reindexTriggered = true;
      }
    }

    // ── Step 6: start chokidar watcher ───────────────────────────────────────
    const userOnEvent = opts.watchOptions?.onEvent;

    watcherHandle = await watchRepo(wdb, {
      root,
      debounceMs: opts.watchOptions?.debounceMs,
      maxDebounceMs: opts.watchOptions?.maxDebounceMs,
      maxFileSize: opts.watchOptions?.maxFileSize,
      onEvent: (event) => {
        // Propagate to any caller-supplied handler first.
        userOnEvent?.(event);

        // Detect .gitignore / .synapseignore changes and trigger a full
        // reindex so newly-ignored files are removed from the index and
        // previously-ignored files can be added. Debounced with a flag so
        // rapid saves of the same ignore file only trigger one reindex.
        if (event.kind === 'ignore_changed' && !reindexInProgress) {
          log.info('auto-sync: ignore file changed, scheduling full reindex', {
            file: event.absolutePath,
          });
          reindexInProgress = true;
          void (async () => {
            try {
              await runReindex(wdb!, root, dbDir);
              const head = await getCurrentHead(root);
              if (head) setManifestValue(wdb!, 'last_indexed_head', head);
            } catch (err) {
              log.warn('auto-sync: reindex after ignore change failed', {
                error: (err as Error).message,
              });
            } finally {
              reindexInProgress = false;
            }
          })();
        }
      },
    });

    log.info('auto-sync: file watcher started', { root });
  } catch (err) {
    log.warn('auto-sync: startup failed, running in read-only mode', {
      error: (err as Error).message,
    });
    await cleanup();
  }

  return { close: cleanup };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Run a full incremental reindex, guarded by index.lock so it doesn't
 * conflict with a concurrent `synapse init` / `synapse reindex` CLI run.
 * The `indexing` flag in manifest is set/cleared by indexRepo itself.
 */
async function runReindex(wdb: DB, root: string, dbDir: string): Promise<void> {
  // Try to acquire the CLI index lock. If the CLI is already running, skip —
  // it will finish the reindex for us.
  let indexLock: LockHandle | null = null;
  try {
    indexLock = acquireLock(dbDir);
  } catch {
    log.info('auto-sync: index.lock held by CLI process — skipping background reindex');
    return;
  }
  try {
    await indexRepo(wdb, { root, skipUnchanged: true });
  } finally {
    indexLock.release();
  }
}

/**
 * Sample up to STALE_SAMPLE_LIMIT files and count those whose on-disk mtime
 * is newer than the stored mtime_ms (the mtime at the time of last indexing)
 * plus a grace period. A positive count means the watcher was not running
 * when those files changed.
 */
function countStaleFiles(db: DB, root: string): number {
  const rows = db
    .prepare('SELECT path, mtime_ms FROM files LIMIT ?')
    .all(STALE_SAMPLE_LIMIT) as { path: string; mtime_ms: number | null }[];

  let stale = 0;
  for (const f of rows) {
    if (f.mtime_ms === null) continue;
    try {
      const abs = pathResolve(root, f.path);
      const st = statSync(abs);
      if (st.mtimeMs > f.mtime_ms + STALE_GRACE_MS) stale++;
    } catch {
      stale++; // file missing on disk = deleted since last index
    }
  }
  return stale;
}
