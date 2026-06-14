import { dirname, resolve, relative } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import cliProgress from 'cli-progress';
import { openDatabase, indexRepo, acquireLock } from '@synapse/core';
import { DEFAULT_CONFIG, readConfig, writeConfig } from '../config.js';

export interface InitOpts {
  root?: string;
  dbPath?: string;
  /** Force re-index of every file even when hashes match (alias: `reindex`). */
  force?: boolean;
  concurrency?: number;
  /** CSV of adapter ids (e.g. 'typescript,python') — restrict indexing. */
  languages?: string;
  /** Print each parse-error file path + message to stderr. */
  verbose?: boolean;
}

export async function runInit(opts: InitOpts): Promise<number> {
  const root = resolve(opts.root ?? process.cwd());

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`init: root directory does not exist: ${root}\n`);
    return 1;
  }

  const dbPath = resolve(opts.dbPath ?? resolve(root, '.synapse', 'graph.db'));

  process.stdout.write(`synapse init\n  root: ${root}\n  db  : ${dbPath}\n\n`);

  // Seed .synapse/config.json on first run so subsequent commands and
  // editor clients have a known location for defaults.
  if (!readConfig(root)) {
    const dbRel = relative(root, dbPath) || dbPath;
    const p = writeConfig(root, { ...DEFAULT_CONFIG, root, db: dbRel });
    process.stdout.write(`  wrote ${p}\n\n`);
  }

  const db = openDatabase({ path: dbPath });

  // Phase 11.8 — PID lockfile prevents concurrent init/reindex corruption.
  let lock;
  try {
    lock = acquireLock(dirname(dbPath));
  } catch (err) {
    process.stderr.write(`\n⚠ ${(err as Error).message}\n`);
    db.close();
    return 2;
  }

  const bar = new cliProgress.SingleBar(
    {
      format: '  indexing |{bar}| {value}/{total} files ({duration_formatted})',
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );

  let started = false;
  let total = 0;
  let done = 0;

  try {
    const summary = await indexRepo(db, {
      root,
      concurrency: opts.concurrency,
      skipUnchanged: !opts.force,
      languages: opts.languages
        ? opts.languages.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
      onProgress: (event) => {
        if (event.kind === 'discovered') {
          total = event.total;
          process.stdout.write(`  discovered ${total} indexable file(s)\n\n`);
          if (total > 0) {
            bar.start(total, 0);
            started = true;
          }
        } else if (event.kind === 'indexed' || event.kind === 'skipped') {
          if (opts.verbose && event.kind === 'skipped' && event.reason === 'error') {
            if (started) { bar.stop(); started = false; }
            process.stderr.write(`  parse error: ${event.file.relPath}\n    ${event.error ?? 'unknown error'}\n`);
          }
          done++;
          if (started) bar.update(done);
        } else if (event.kind === 'resolving') {
          if (started) {
            bar.stop();
            started = false;
          }
          process.stdout.write('\n  resolving cross-file references...\n');
        } else if (event.kind === 'resolved') {
          const r = event.summary;
          process.stdout.write(
            `  resolved in ${r.durationMs}ms — ` +
              `${r.importsResolved}/${r.importsResolved + r.importsUnresolved} imports, ` +
              `${r.edgesResolved}/${r.edgesResolved + r.edgesUnresolved} edges\n`,
          );
        }
      },
    });

    if (started) bar.stop();

    process.stdout.write(
      `\nindexed in ${(summary.durationMs / 1000).toFixed(2)}s\n` +
        `  files indexed : ${summary.filesIndexed}\n` +
        `  files skipped : ${summary.filesSkipped}\n` +
        `  symbols       : ${summary.symbolCount}\n` +
        `  edges         : ${summary.edgeCount}\n` +
        `  database      : ${dbPath}\n`,
    );

    // Phase 13: per-language breakdown.
    const langEntries = Object.entries(summary.indexedByLanguage);
    if (langEntries.length > 0) {
      langEntries.sort(([, a], [, b]) => b - a);
      const formatted = langEntries.map(([k, v]) => `${k}=${v}`).join(', ');
      process.stdout.write(`  by language   : ${formatted}\n`);
    }

    // Phase 9: print skip breakdown when there are non-trivial skips
    const sr = summary.skipReasons;
    const hasReasons =
      sr.unsupported_language + sr.too_large + sr.permission_error + sr.read_error + sr.symlink_cycle + sr.parse_error > 0;
    if (hasReasons) {
      process.stdout.write(`\n  skip reasons:\n`);
      if (sr.unsupported_language) process.stdout.write(`    unsupported language : ${sr.unsupported_language}\n`);
      if (sr.too_large) process.stdout.write(`    too large (>1 MiB)   : ${sr.too_large}\n`);
      if (sr.permission_error) process.stdout.write(`    permission denied    : ${sr.permission_error}\n`);
      if (sr.read_error) process.stdout.write(`    read error           : ${sr.read_error}\n`);
      if (sr.symlink_cycle) process.stdout.write(`    symlink cycle        : ${sr.symlink_cycle}\n`);
      if (sr.parse_error) process.stdout.write(`    parse error          : ${sr.parse_error}\n`);
      if (sr.unchanged) process.stdout.write(`    unchanged (cached)   : ${sr.unchanged}\n`);
    }

    // Phase 9: exit non-zero if nothing was indexed
    if (summary.filesIndexed === 0 && summary.filesDiscovered > 0) {
      process.stderr.write(
        `\n⚠ No files were indexed. Check that the repo contains supported languages (TypeScript/JavaScript).\n`,
      );
      return 1;
    }

    return 0;
  } finally {
    lock.release();
    db.close();
  }
}
