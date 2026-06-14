import { existsSync } from 'node:fs';
import { openDatabase, Queries, type IncomingEdge } from '@synapse/core';
import { resolveDbPath } from '../config.js';

export interface RefsOpts {
  name: string;
  dbPath?: string;
  /** Restrict to a particular file path (substring match). */
  inFile?: string;
  /** Cap on number of incoming edges printed per symbol (default 50). */
  limit?: number;
}

/**
 * Print every place that references the named symbol.
 *
 * Reference linking happens at index time (Phase 3 resolver), so this is just
 * a JOIN over the edges table — no on-demand analysis required.
 */
export function runRefs(opts: RefsOpts): number {
  const dbPath = resolveDbPath(opts.dbPath);
  if (!existsSync(dbPath)) {
    process.stderr.write(`refs: no database at ${dbPath}\nRun: synapse init\n`);
    return 1;
  }
  const db = openDatabase({ path: dbPath, readonly: true });
  try {
    const q = new Queries(db);
    const limit = opts.limit ?? 50;

    let symbols = q.searchByName(opts.name, 25);
    if (opts.inFile) {
      const needle = opts.inFile;
      symbols = symbols.filter((s) => s.file_path.includes(needle));
    }

    if (symbols.length === 0) {
      process.stderr.write(`no symbol named "${opts.name}"\n`);
      return 1;
    }

    for (const sym of symbols) {
      const edges = q.incomingEdges(sym.id).slice(0, limit);
      process.stdout.write(
        `\n${sym.kind} ${sym.name}  (${sym.file_path}:${sym.start_line})\n` +
          `  ${edges.length} reference(s)\n`,
      );
      if (edges.length === 0) continue;
      for (const e of edges) {
        process.stdout.write(`    ${formatEdge(e)}\n`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

function formatEdge(e: IncomingEdge): string {
  const where = `${e.file_path}:${e.line}:${e.col}`;
  const from = e.source_name ? `${e.source_kind ?? '?'} ${e.source_name}` : '<top-level>';
  return `${e.kind.padEnd(10)} from ${from.padEnd(28)} ${where}`;
}
