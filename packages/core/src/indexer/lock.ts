/**
 * Phase 11.8 — PID lockfile to prevent concurrent `init` / `reindex` on the
 * same DB from corrupting each other. Stored at `<dbDir>/index.lock`.
 *
 * Semantics:
 *   - `acquireLock(dir)` writes `<pid>` to `index.lock`. If the file exists
 *     and its PID is still alive, throws with an actionable message.
 *   - If the PID is dead (stale lock), silently replaces it.
 *   - `release()` removes the lock; safe to call twice.
 *   - We also register a `process.on('exit')` cleanup so a crashed process
 *     leaves a stale lock rather than a held one.
 */

import { existsSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface LockHandle {
  /** Remove the lockfile. Idempotent. */
  release(): void;
  /** Absolute path of the lockfile (mostly for diagnostics). */
  readonly path: string;
}

const LOCK_NAME = 'index.lock';

/** Detect whether a PID is currently running. `process.kill(pid, 0)` is the
 * portable trick; it doesn't actually signal, just probes liveness. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we can't signal it (still alive).
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * Try to take an exclusive lock in `dir`. Throws if another live process
 * already holds it. The error message includes the holding PID so users can
 * `taskkill /PID <n>` or `kill <n>` and retry.
 */
export function acquireLock(dir: string, holder = `pid=${process.pid}`, lockName = LOCK_NAME): LockHandle {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, lockName);
  const content = `${holder} ts=${new Date().toISOString()}\n`;

  // Atomic exclusive create — the OS guarantees only one concurrent caller
  // succeeds. This eliminates the TOCTOU race that existsSync+writeFileSync had.
  try {
    const fd = openSync(path, 'wx');
    writeSync(fd, content);
    closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    // File already exists — check whether the holder is still alive.
    let raw = '';
    try { raw = readFileSync(path, 'utf8').trim(); } catch { /* ignore */ }

    const pidMatch = raw.match(/pid=(\d+)/);
    const pid = pidMatch ? Number(pidMatch[1]) : NaN;
    if (Number.isFinite(pid) && pid !== process.pid && isAlive(pid)) {
      throw new Error(
        `another synapse process is already operating on this DB (lock=${path}, ${raw}). ` +
          `If you're sure it's dead, delete the lock file and retry.`,
      );
    }
    // Stale lock (dead PID) — overwrite it.
    writeFileSync(path, content, 'utf8');
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      // Only remove if we still own it (paranoia against parallel cleanups).
      if (existsSync(path)) {
        const raw = readFileSync(path, 'utf8');
        if (raw.includes(`pid=${process.pid}`)) unlinkSync(path);
      }
    } catch {
      /* best-effort */
    }
  };

  // Best-effort cleanup on process exit. Crashes (SIGKILL) still leak — the
  // stale-detection on next acquire is the fallback.
  const onExit = (): void => release();
  process.once('exit', onExit);

  return { release, path };
}
