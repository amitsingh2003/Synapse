import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { openDatabase, compactDatabase } from '@synapse/core';

export interface CompactOptions {
  dbPath?: string;
}

/**
 * Phase 16.4 — `synapse compact`.
 * Runs VACUUM + ANALYZE + PRAGMA optimize and reports the size delta.
 * Useful after large reindexes or to recover space from per-file rewrites.
 */
export async function runCompact(opts: CompactOptions = {}): Promise<number> {
  const dbPath = resolve(opts.dbPath ?? './.synapse/graph.db');
  let beforeBytes = 0;
  try {
    beforeBytes = statSync(dbPath).size;
  } catch {
    process.stderr.write(`compact: DB not found at ${dbPath}\n`);
    return 1;
  }
  const db = openDatabase({ path: dbPath });
  try {
    const t0 = Date.now();
    const { vacuumed, analyzed } = compactDatabase(db);
    const elapsed = Date.now() - t0;
    db.close();
    let afterBytes = 0;
    try { afterBytes = statSync(dbPath).size; } catch { /* ignore */ }
    const saved = beforeBytes - afterBytes;
    const pct = beforeBytes > 0 ? ((saved / beforeBytes) * 100).toFixed(1) : '0.0';
    process.stdout.write(
      `compact: vacuum=${vacuumed ? 'yes' : 'skipped'} analyze=${analyzed ? 'yes' : 'skipped'} ` +
      `before=${formatBytes(beforeBytes)} after=${formatBytes(afterBytes)} ` +
      `saved=${formatBytes(saved)} (${pct}%) in ${elapsed}ms\n`,
    );
    return 0;
  } catch (err) {
    try { db.close(); } catch { /* ignore */ }
    process.stderr.write(`compact: ${(err as Error).message}\n`);
    return 1;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
