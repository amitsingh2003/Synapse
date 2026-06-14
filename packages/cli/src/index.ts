import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ping } from '@synapse/core';
import { runIndexFile } from './commands/indexFile.js';
import { runQuery } from './commands/query.js';
import { runInit } from './commands/init.js';
import { runStats } from './commands/stats.js';
import { runRefs } from './commands/refs.js';
import { runWatch } from './commands/watch.js';
import { runConfigure } from './commands/configure.js';
import { runDoctor } from './commands/doctor.js';
import { runCompact } from './commands/compact.js';
import { runEmbed } from './commands/embed.js';
import { runDiff } from './commands/diff.js';
import { runImportScip } from './commands/importScip.js';

/** Read this CLI package's version from its own package.json. */
function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ sits next to package.json
  const pkgPath = resolve(here, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

const HELP = `synapse — local code intelligence engine

Usage:
  synapse <command> [options]

Commands:
  init [root]                 Crawl repo and build the graph DB (skips unchanged files)
  reindex [root]              Force full re-index of every file (ignores hash cache)
  watch [root]                Long-running incremental indexer (Phase 4)
  configure [root]            Write .synapse/config.json + print MCP client snippet
  doctor [root]               Diagnose installation (node, db, mcp bin)
  compact                     VACUUM + ANALYZE the DB; reclaims free pages (Phase 16.4)
  embed                       Generate embeddings for semantic search (Phase 18.3)
  diff <base> [head]          Show changed public APIs between git refs (Phase 19.2)
  import-scip <file.json>     Ingest a SCIP JSON index (Phase 19.1)
  index-file <path>           Parse one file into the local graph DB
  query <symbol-name>         Look up symbols by name
  refs <symbol-name>          Show every reference to a symbol (Phase 3 cross-file)
  stats                       Print DB summary (file/symbol/edge counts)
  ping                        Sanity check (prints "pong")
  --version, -v               Print version
  --help,    -h               Print this help

Options:
  --db <path>                 Override DB path (default: ./.synapse/graph.db)
  --concurrency <n>           init/reindex: parallel file workers (default 8)
  --languages <csv>           init/reindex: restrict to adapter ids (e.g. typescript,python)
  --debounce <ms>             watch: debounce window before re-resolve (default 250)
  --skip-initial              watch: skip the up-front full-repo index
  --client <name>             configure: 'claude' (default), 'cursor', or 'generic'
  --print                     configure: skip writing config, only print snippet
  --limit <n>                 query/refs: max results (default 25/50)
  --in <substr>               refs: only count references in files matching substring
  --json                      stats: emit JSON
  --verbose                   init/reindex: print each parse-error file path + message
`;


/** Tiny hand-rolled flag lookup; proper arg parsing arrives in Phase 6. */
function parseFlag(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

/**
 * Parse a flag that must be a positive integer.
 * Returns undefined when the flag is absent, or exits with an error message
 * when the value is present but not a valid positive integer.
 */
function parseIntFlag(
  argv: readonly string[],
  name: string,
): { value: number | undefined; error: string | null } {
  const raw = parseFlag(argv, name);
  if (raw === undefined) return { value: undefined, error: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { value: undefined, error: `${name} must be a positive integer, got: "${raw}"` };
  }
  return { value: n, error: null };
}

export async function run(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }

  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  if (cmd === 'ping') {
    process.stdout.write(`${ping()}\n`);
    return 0;
  }

  if (cmd === 'init' || cmd === 'reindex') {
    const positional = rest.find((a) => !a.startsWith('-'));
    const { value: concurrency, error: concErr } = parseIntFlag(rest, '--concurrency');
    if (concErr) { process.stderr.write(`${concErr}\n`); return 1; }
    return runInit({
      root: positional,
      dbPath: parseFlag(rest, '--db'),
      force: cmd === 'reindex',
      concurrency,
      languages: parseFlag(rest, '--languages'),
      verbose: rest.includes('--verbose'),
    });
  }

  if (cmd === 'stats') {
    return runStats({
      dbPath: parseFlag(rest, '--db'),
      json: rest.includes('--json'),
    });
  }

  if (cmd === 'watch') {
    const positional = rest.find((a) => !a.startsWith('-'));
    const { value: debounceMs, error: debounceErr } = parseIntFlag(rest, '--debounce');
    if (debounceErr) { process.stderr.write(`${debounceErr}\n`); return 1; }
    return runWatch({
      root: positional,
      dbPath: parseFlag(rest, '--db'),
      debounceMs,
      skipInitial: rest.includes('--skip-initial'),
    });
  }

  if (cmd === 'configure') {
    const positional = rest.find((a) => !a.startsWith('-'));
    return runConfigure({
      root: positional,
      dbPath: parseFlag(rest, '--db'),
      client: parseFlag(rest, '--client'),
      printOnly: rest.includes('--print'),
    });
  }

  if (cmd === 'doctor') {
    const positional = rest.find((a) => !a.startsWith('-'));
    return runDoctor({
      root: positional,
      dbPath: parseFlag(rest, '--db'),
    });
  }

  if (cmd === 'compact') {
    return runCompact({ dbPath: parseFlag(rest, '--db') });
  }

  if (cmd === 'embed') {
    const { value: batchSize, error: batchErr } = parseIntFlag(rest, '--batch-size');
    if (batchErr) { process.stderr.write(`${batchErr}\n`); return 1; }
    const { value: maxSymbols, error: maxErr } = parseIntFlag(rest, '--max');
    if (maxErr) { process.stderr.write(`${maxErr}\n`); return 1; }
    const rawProvider = parseFlag(rest, '--provider');
    if (rawProvider && rawProvider !== 'transformers' && rawProvider !== 'ollama') {
      process.stderr.write(`embed: --provider must be 'transformers' or 'ollama'\n`);
      return 1;
    }
    return runEmbed({
      dbPath: parseFlag(rest, '--db'),
      provider: (rawProvider as 'transformers' | 'ollama' | undefined),
      model: parseFlag(rest, '--model'),
      ollamaUrl: parseFlag(rest, '--ollama-url'),
      batchSize,
      maxSymbols,
    });
  }

  if (cmd === 'import-scip') {
    const file = rest[0];
    if (!file || file.startsWith('-')) {
      process.stderr.write(`import-scip: expected a SCIP JSON file path\n`);
      return 1;
    }
    return runImportScip({
      file,
      dbPath: parseFlag(rest, '--db'),
      language: parseFlag(rest, '--language'),
      skipExisting: rest.includes('--skip-existing'),
    });
  }

  if (cmd === 'diff') {
    const base = rest[0];
    if (!base || base.startsWith('-')) {
      process.stderr.write(`diff: expected a base ref (e.g. main, HEAD~3)\n`);
      return 1;
    }
    const head = rest[1] && !rest[1].startsWith('-') ? rest[1] : undefined;
    return runDiff({
      base,
      head,
      root: parseFlag(rest, '--root') ?? '.',
      kinds: parseFlag(rest, '--kinds'),
      publicOnly: !rest.includes('--all'),
      json: rest.includes('--json'),
    });
  }

  if (cmd === 'refs') {
    const name = rest[0];
    if (!name || name.startsWith('-')) {
      process.stderr.write(`refs: expected a symbol name\n`);
      return 1;
    }
    const { value: refsLimit, error: refsLimitErr } = parseIntFlag(rest, '--limit');
    if (refsLimitErr) { process.stderr.write(`${refsLimitErr}\n`); return 1; }
    return runRefs({
      name,
      dbPath: parseFlag(rest, '--db'),
      inFile: parseFlag(rest, '--in'),
      limit: refsLimit,
    });
  }

  if (cmd === 'index-file') {
    const file = rest[0];
    if (!file || file.startsWith('-')) {
      process.stderr.write(`index-file: expected a file path\n`);
      return 1;
    }
    return runIndexFile({ file, dbPath: parseFlag(rest, '--db') });
  }

  if (cmd === 'query') {
    const name = rest[0];
    if (!name || name.startsWith('-')) {
      process.stderr.write(`query: expected a symbol name\n`);
      return 1;
    }
    const { value: queryLimit, error: queryLimitErr } = parseIntFlag(rest, '--limit');
    if (queryLimitErr) { process.stderr.write(`${queryLimitErr}\n`); return 1; }
    return runQuery({ name, dbPath: parseFlag(rest, '--db'), limit: queryLimit });
  }

  process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
  return 1;
}

// Direct invocation entry point
const isDirect = (() => {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = realpathSync(resolve(process.argv[1]));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  }
})();
if (isDirect) {
  run(process.argv.slice(2)).then(
    (code) => hardExit(code),
    (err) => {
      console.error(err);
      hardExit(1);
    },
  );
}

/**
 * Exit the process without running V8/libuv finalisers.
 *
 * Background: web-tree-sitter's emscripten module keeps libuv async handles
 * alive after we're done with it. On Node 22+ (especially Node 25 on Windows)
 * the normal `process.exit()` shutdown trips `UV_HANDLE_CLOSING` asserts. We
 * silence stderr just before exit so the user never sees the cosmetic noise,
 * then fall through to `process.exit`.
 */
function hardExit(code: number): never {
  // Drain stderr quickly so any final user-facing error is visible, then mute
  // it before libuv tries to tear down the WASM module.
  try {
    process.stderr.write('', () => {
      (process.stderr.write as (chunk: unknown) => boolean) = () => true;
      process.exit(code);
    });
  } catch {
    process.exit(code);
  }
  // Belt-and-braces in case the callback never fires.
  setImmediate(() => process.exit(code));
  return undefined as never;
}
