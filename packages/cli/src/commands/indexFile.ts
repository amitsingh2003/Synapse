import { resolve } from 'node:path';
import { openDatabase, indexFile } from '@synapse/core';

export interface IndexFileOpts {
  file: string;
  dbPath?: string;
}

export async function runIndexFile(opts: IndexFileOpts): Promise<number> {
  const dbPath = resolve(opts.dbPath ?? resolve(process.cwd(), '.synapse', 'graph.db'));
  const filePath = resolve(opts.file);

  const db = openDatabase({ path: dbPath });
  try {
    const result = await indexFile(db, filePath);
    process.stdout.write(
      `indexed ${result.absolutePath}\n` +
        `  language: ${result.language}\n` +
        `  symbols : ${result.symbolCount}\n` +
        `  edges   : ${result.edgeCount}\n` +
        `  db      : ${dbPath}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}
