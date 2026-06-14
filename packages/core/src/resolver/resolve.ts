import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve as pathResolve, join, normalize, sep } from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import { Queries, type FileImportRow, type SymbolRow } from '../db/queries.js';
import { getAdapterForFile } from '../languages/registry.js';
import { TypeScriptAdapter } from '../languages/typescript.js';

export interface ResolveOptions {
  /** Repo root — used to resolve modules to absolute paths for filesystem checks. */
  root: string;
}

export interface ResolveSummary {
  importsResolved: number;
  importsUnresolved: number;
  edgesResolved: number;
  edgesUnresolved: number;
  durationMs: number;
}

/**
 * Phase 12 — the resolver now delegates per-language module resolution to
 * the importing file's `LanguageAdapter.resolveModule`. The fallback
 * (used when an adapter omits `resolveModule`) mirrors the historical
 * TS-style behavior: relative join, extension probe, and `index.*` lookup.
 */

/**
 * Phase 3 cross-reference linker (Phase 10: adapted for relative paths).
 *
 * `files.path` is now repo-relative (forward slashes). Resolution logic
 * joins relative specifiers to the file's directory, normalizes, then looks
 * up in the `filesByPath` map keyed by relative path. Filesystem checks
 * (e.g. "is this a directory?") use `root` to reconstruct absolute paths.
 */
export function resolveReferences(db: DB, opts: ResolveOptions): ResolveSummary {
  const t0 = Date.now();
  const root = opts.root;
  const q = new Queries(db);

  // Build a fast `relPath → file_id` map (forward slashes).
  const filesByPath = new Map<string, number>();
  for (const row of db.prepare(`SELECT id, path FROM files`).all() as {
    id: number;
    path: string;
  }[]) {
    filesByPath.set(normalizeRel(row.path), row.id);
  }

  // === Pass 1: resolve every file_imports row =============================
  const importRows = db
    .prepare(
      `SELECT fi.*, f.path AS file_path
         FROM file_imports fi
         JOIN files f ON fi.file_id = f.id`,
    )
    .all() as (FileImportRow & { file_path: string })[];

  let importsResolved = 0;
  let importsUnresolved = 0;

  const importTargetByFileLocal = new Map<string, number>();
  // Phase 24: pre-built fileId -> [importedFileId] eliminates quadratic fallback scan.
  const importedFilesByFile = new Map<number, number[]>(); // `${file_id}\0${local_name}` → resolved_file_id

  db.transaction(() => {
    for (const imp of importRows) {
      const dir = dirname(imp.file_path);
      const targetFileId = resolveModuleToFileId(
        imp.module_specifier,
        dir,
        filesByPath,
        root,
        imp.file_path,
      );
      q.setImportResolved(imp.id, targetFileId);
      if (targetFileId !== null) {
        importsResolved++;
        importTargetByFileLocal.set(`${imp.file_id}\u0000${imp.local_name}`, targetFileId);
        let list = importedFilesByFile.get(imp.file_id);
        if (!list) { list = []; importedFilesByFile.set(imp.file_id, list); }
        if (!list.includes(targetFileId)) list.push(targetFileId);
      } else {
        importsUnresolved++;
      }
    }
  })();

  // === Pass 2: resolve every unresolved edge ==============================
  type EdgeForResolve = {
    id: number;
    file_id: number;
    target_name: string;
    kind: string;
  };

  const edgeRows = db
    .prepare(
      `SELECT id, file_id, target_name, kind
         FROM edges
         WHERE target_id IS NULL
           AND target_name IS NOT NULL
           AND kind IN ('CALLS','REFERENCES','EXTENDS','IMPLEMENTS')`,
    )
    .all() as EdgeForResolve[];

  // Pre-build a per-file index of public-ish symbols (non-import, non-variable).
  // Looking these up by SQL inside the loop would dominate runtime on big repos.
  const symbolsByFile = new Map<number, SymbolRow[]>();
  for (const sym of db
    .prepare(`SELECT * FROM symbols WHERE kind != 'import'`)
    .all() as SymbolRow[]) {
    let list = symbolsByFile.get(sym.file_id);
    if (!list) {
      list = [];
      symbolsByFile.set(sym.file_id, list);
    }
    list.push(sym);
  }

  let edgesResolved = 0;
  let edgesUnresolved = 0;

  db.transaction(() => {
    for (const edge of edgeRows) {
      const targetId = resolveEdgeTarget(
        edge.file_id,
        edge.target_name,
        importTargetByFileLocal,
        symbolsByFile,
        importedFilesByFile,
      );
      if (targetId !== null) {
        q.setEdgeTargetId(edge.id, targetId);
        edgesResolved++;
      } else {
        edgesUnresolved++;
      }
    }
  })();

  return {
    importsResolved,
    importsUnresolved,
    edgesResolved,
    edgesUnresolved,
    durationMs: Date.now() - t0,
  };
}

/** Normalize a relative path to use forward slashes and remove redundant segments. */
function normalizeRel(p: string): string {
  return normalize(p).split(sep).join('/').replace(/\/$/, '');
}

/**
 * Turn an `import` specifier into a repo-relative path and look it up.
 *
 * Phase 10: works entirely with relative paths. `fromDir` is the repo-relative
 * directory of the importing file (e.g. `src`). Filesystem checks (for
 * directory detection) use `root` to make absolute paths.
 *
 * Only relative specifiers (`./`, `../`) are attempted. Bare specifiers
 * (npm packages, node builtins) intentionally return null.
 */
function resolveModuleToFileId(
  specifier: string,
  fromDir: string,
  filesByPath: ReadonlyMap<string, number>,
  root: string,
  importerPath: string,
): number | null {
  const adapter = getAdapterForFile(importerPath) ?? TypeScriptAdapter;
  // Prefer the adapter's own resolution rules. If it returns a hit, we're
  // done. If it returns null (e.g. TypeScriptAdapter only handles bare/tsconfig
  // specifiers, not relative paths), fall through to the legacy resolver below.
  if (adapter.resolveModule) {
    const key = adapter.resolveModule(specifier, fromDir, { root, filesByPath });
    if (key !== null) return filesByPath.get(key) ?? null;
    // key === null — adapter couldn't resolve it; let the legacy path try.
  }

  if (!specifier.startsWith('.') && !isAbsolute(specifier)) return null;

  const resolveExts = adapter.resolveExts;
  const indexFiles = adapter.indexFiles;

  const joined = normalizeRel(join(fromDir, specifier));
  const stripped = joined.replace(/\.(?:js|jsx|mjs|cjs)$/, '');

  if (filesByPath.has(joined)) return filesByPath.get(joined) ?? null;
  if (filesByPath.has(stripped)) return filesByPath.get(stripped) ?? null;

  for (const ext of resolveExts) {
    const candidate = stripped + ext;
    const id = filesByPath.get(candidate);
    if (id !== undefined) return id;
  }

  const absJoined = pathResolve(root, joined);
  const absStripped = pathResolve(root, stripped);
  if (safeIsDir(absStripped) || safeIsDir(absJoined)) {
    const dir = safeIsDir(absStripped) ? stripped : joined;
    for (const idx of indexFiles) {
      const candidate = normalizeRel(join(dir, idx));
      const id = filesByPath.get(candidate);
      if (id !== undefined) return id;
    }
  }
  return null;
}

function safeIsDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a single edge's target.
 *
 * Strategy: prefer cross-file (imported) lookup, fall back to a same-file
 * name match. The same-file fallback covers in-file calls like
 * `someHelper()` where there's no import involved.
 *
 * Phase 3 limit: we ignore overload disambiguation and prefer the first
 * non-method match in the target file. Class-method dispatch (`cart.addItem`)
 * is matched by *name only*; Phase 7 will lean on TS type info for accuracy.
 */
function resolveEdgeTarget(
  fileId: number,
  targetName: string,
  importTargets: ReadonlyMap<string, number>,
  symbolsByFile: ReadonlyMap<number, readonly SymbolRow[]>,
  importedFilesByFile: ReadonlyMap<number, readonly number[]>,
): number | null {
  const PREFERRED: readonly string[] = ['method', 'function', 'class', 'interface'];

  // Direct import lookup: `import { foo } from './bar'` — look in bar only.
  const importedFromFile = importTargets.get(`${fileId} ${targetName}`);
  if (importedFromFile !== undefined) {
    const match = pickSymbolByName(symbolsByFile.get(importedFromFile), targetName, PREFERRED);
    if (match) return match.id;
    // Not directly in the imported file — traverse barrel re-exports (e.g. index.ts).
    const deep = resolveViaBarrels(importedFromFile, targetName, importedFilesByFile, symbolsByFile, 3);
    if (deep) return deep.id;
  }

  // Method-call style: `cart.addItem` — scan all files directly imported by this file.
  const importedFiles = importedFilesByFile.get(fileId);
  if (importedFiles) {
    for (const importedFileId of importedFiles) {
      const match = pickSymbolByName(symbolsByFile.get(importedFileId), targetName, PREFERRED);
      if (match) return match.id;
    }
    // Also search through barrel re-exports of each imported file.
    for (const importedFileId of importedFiles) {
      const deep = resolveViaBarrels(importedFileId, targetName, importedFilesByFile, symbolsByFile, 2);
      if (deep) return deep.id;
    }
  }

  // Same-file fallback.
  return pickSymbolByName(symbolsByFile.get(fileId), targetName)?.id ?? null;
}

/**
 * BFS through barrel re-exports to find a symbol definition.
 * Handles workspace packages that route through multiple index.ts barrel files.
 */
function resolveViaBarrels(
  startFileId: number,
  targetName: string,
  importedFilesByFile: ReadonlyMap<number, readonly number[]>,
  symbolsByFile: ReadonlyMap<number, readonly SymbolRow[]>,
  maxDepth: number,
): SymbolRow | undefined {
  const PREFERRED: readonly string[] = ['method', 'function', 'class', 'interface'];
  const visited = new Set<number>([startFileId]);
  let frontier = [...(importedFilesByFile.get(startFileId) ?? [])];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: number[] = [];
    for (const fid of frontier) {
      if (visited.has(fid)) continue;
      visited.add(fid);
      const match = pickSymbolByName(symbolsByFile.get(fid), targetName, PREFERRED);
      if (match) return match;
      const sub = importedFilesByFile.get(fid);
      if (sub) nextFrontier.push(...sub);
    }
    frontier = nextFrontier;
  }
  return undefined;
}

function pickSymbolByName(
  candidates: readonly SymbolRow[] | undefined,
  name: string,
  preferredKinds?: readonly string[],
): SymbolRow | undefined {
  if (!candidates) return undefined;
  if (preferredKinds) {
    for (const k of preferredKinds) {
      const hit = candidates.find((s) => s.name === name && s.kind === k);
      if (hit) return hit;
    }
  }
  return candidates.find((s) => s.name === name);
}
