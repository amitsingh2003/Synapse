/**
 * CLI command: synapse import-scip <file.json>
 *
 * Ingests a SCIP JSON index into the synapse database.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, importScipIndex, type ScipIndex } from '@synapse/core';

export interface ImportScipOptions {
  file: string;
  dbPath?: string;
  language?: string;
  skipExisting?: boolean;
}

export async function runImportScip(opts: ImportScipOptions): Promise<number> {
  const filePath = resolve(opts.file);
  const dbPath = resolve(opts.dbPath ?? '.synapse/graph.db');

  process.stdout.write(`Importing SCIP index: ${filePath}\n`);

  let data: ScipIndex;
  try {
    const raw = readFileSync(filePath, 'utf8');
    data = JSON.parse(raw) as ScipIndex;
  } catch (err) {
    process.stderr.write(`Failed to read/parse SCIP file: ${(err as Error).message}\n`);
    return 1;
  }

  if (!data.documents || !Array.isArray(data.documents)) {
    process.stderr.write('Invalid SCIP index: missing "documents" array.\n');
    return 1;
  }

  const db = openDatabase({ path: dbPath });
  try {
    const result = importScipIndex(db, {
      data,
      language: opts.language,
      skipExisting: opts.skipExisting,
    });

    process.stdout.write(`\nSCIP Import complete:\n`);
    process.stdout.write(`  Files imported:   ${result.filesImported}\n`);
    process.stdout.write(`  Symbols imported: ${result.symbolsImported}\n`);
    process.stdout.write(`  Edges created:    ${result.edgesCreated}\n`);
    if (result.skipped > 0) {
      process.stdout.write(`  Files skipped:    ${result.skipped}\n`);
    }
    process.stdout.write(`  Duration:         ${result.durationMs}ms\n`);
    return 0;
  } finally {
    db.close();
  }
}
