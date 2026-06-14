import { resolve } from 'node:path';
import { openDatabase, indexRepo, watchRepo } from '@synapse/core';
import { resolveDbPath } from '../config.js';

export interface WatchOpts {
  root?: string;
  dbPath?: string;
  /** Skip the initial full-repo index (useful if the DB is already current). */
  skipInitial?: boolean;
  debounceMs?: number;
}

/**
 * Long-running command. Indexes the repo once, then keeps the DB warm by
 * re-indexing files as they change. Ctrl+C to exit.
 */
export async function runWatch(opts: WatchOpts): Promise<number> {
  const root = resolve(opts.root ?? process.cwd());
  const dbPath = opts.dbPath
    ? resolve(opts.dbPath)
    : resolveDbPath(undefined);

  process.stdout.write(`synapse watch\n  root: ${root}\n  db  : ${dbPath}\n\n`);
  const db = openDatabase({ path: dbPath });

  if (!opts.skipInitial) {
    process.stdout.write('  initial index...\n');
    const s = await indexRepo(db, { root, skipUnchanged: true });
    process.stdout.write(
      `  initial: ${s.filesIndexed} indexed / ${s.filesSkipped} cached, ${s.symbolCount} symbols, ${s.edgeCount} edges\n\n`,
    );
  }

  const handle = await watchRepo(db, {
    root,
    debounceMs: opts.debounceMs,
    onEvent: (e) => {
      switch (e.kind) {
        case 'ready':
          process.stdout.write(`  watching ${e.watched} path(s). Press Ctrl+C to stop.\n`);
          break;
        case 'indexed':
          process.stdout.write(
            `  [+] ${rel(root, e.absolutePath)}  ${e.symbolCount} sym / ${e.edgeCount} edge  (${e.durationMs}ms)\n`,
          );
          break;
        case 'removed':
          process.stdout.write(`  [-] ${rel(root, e.absolutePath)}\n`);
          break;
        case 'resolved':
          process.stdout.write(
            `  [r] resolved ${e.summary.importsResolved} imports + ${e.summary.edgesResolved} edges (${e.summary.durationMs}ms)\n`,
          );
          break;
        case 'error':
          process.stderr.write(`  [!] ${rel(root, e.absolutePath)}: ${e.error}\n`);
          break;
      }
    },
  });

  // Block forever — exit via SIGINT.
  await new Promise<void>((res) => {
    const stop = (): void => {
      process.stdout.write('\nstopping...\n');
      handle.close().finally(() => {
        db.close();
        res();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  return 0;
}

function rel(root: string, abs: string): string {
  if (abs.startsWith(root)) return abs.slice(root.length + 1).replace(/\\/g, '/');
  return abs;
}
