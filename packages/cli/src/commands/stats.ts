import { existsSync } from 'node:fs';
import { openDatabase, collectStats } from '@synapse/core';
import { resolveDbPath } from '../config.js';

export interface StatsOpts {
  dbPath?: string;
  json?: boolean;
}

export function runStats(opts: StatsOpts): number {
  const dbPath = resolveDbPath(opts.dbPath);
  if (!existsSync(dbPath)) {
    process.stderr.write(`stats: no database at ${dbPath}\nRun: synapse init\n`);
    return 1;
  }
  const db = openDatabase({ path: dbPath, readonly: true });
  try {
    const s = collectStats(db);

    if (opts.json) {
      process.stdout.write(JSON.stringify(s, null, 2) + '\n');
      return 0;
    }

    const sizeKb = (s.dbSizeBytes / 1024).toFixed(1);
    process.stdout.write(
      `synapse stats\n  db      : ${dbPath} (${sizeKb} KB)\n` +
        `  files   : ${s.files}\n  symbols : ${s.symbols}\n  edges   : ${s.edges}\n`,
    );
    if (Object.keys(s.symbolsByKind).length) {
      process.stdout.write('\n  symbols by kind:\n');
      for (const [k, n] of Object.entries(s.symbolsByKind).sort((a, b) => b[1] - a[1])) {
        process.stdout.write(`    ${k.padEnd(16)} ${n}\n`);
      }
    }
    if (Object.keys(s.edgesByKind).length) {
      process.stdout.write('\n  edges by kind:\n');
      for (const [k, n] of Object.entries(s.edgesByKind).sort((a, b) => b[1] - a[1])) {
        process.stdout.write(`    ${k.padEnd(16)} ${n}\n`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
