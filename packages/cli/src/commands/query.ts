import { existsSync } from 'node:fs';
import { openDatabase, Queries } from '@synapse/core';
import { resolveDbPath } from '../config.js';

export interface QueryOpts {
  name: string;
  dbPath?: string;
  limit?: number;
}

export async function runQuery(opts: QueryOpts): Promise<number> {
  const dbPath = resolveDbPath(opts.dbPath);
  if (!existsSync(dbPath)) {
    process.stderr.write(`query: no database at ${dbPath}\nRun: synapse init\n`);
    return 1;
  }
  const db = openDatabase({ path: dbPath, readonly: true });
  try {
    const q = new Queries(db);
    const results = q.searchByName(opts.name, opts.limit ?? 25);

    if (results.length === 0) {
      process.stdout.write(`no symbols named "${opts.name}"\n`);
      return 0;
    }

    process.stdout.write(`found ${results.length} symbol(s) named "${opts.name}":\n\n`);
    for (const r of results) {
      // Phase 10: r.file_path is already repo-relative with forward slashes.
      process.stdout.write(
        `  [${r.kind.padEnd(9)}] ${r.name}  —  ${r.file_path}:${r.start_line}\n` +
          (r.signature ? `              ${r.signature}\n` : ''),
      );
    }
    return 0;
  } finally {
    db.close();
  }
}
