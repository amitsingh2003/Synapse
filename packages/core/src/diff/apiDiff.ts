/**
 * Phase 19.2 — Diff-aware mode.
 *
 * Compares indexed symbols between two git revisions to produce a structured
 * list of changed public APIs. Useful for PR review bots, changelogs, and
 * breaking-change detection.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { openDatabase } from '../db/open.js';
import { indexRepo } from '../indexer/index.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ApiChange {
  /** 'added' | 'removed' | 'modified' */
  change: 'added' | 'removed' | 'modified';
  /** Symbol name */
  name: string;
  /** Symbol kind (function, class, method, type, interface, etc.) */
  kind: string;
  /** File path (relative) */
  file: string;
  /** Line number in the *new* revision (or old if removed) */
  line: number;
  /** Old signature (for modified/removed) */
  oldSignature?: string;
  /** New signature (for modified/added) */
  newSignature?: string;
}

export interface DiffResult {
  /** Base ref used */
  base: string;
  /** Head ref used */
  head: string;
  /** Files changed between the two refs */
  filesChanged: string[];
  /** Public API changes detected */
  changes: ApiChange[];
  /** Total time in ms */
  durationMs: number;
}

export interface DiffOptions {
  /** Repo root (absolute path) */
  root: string;
  /** Base git ref (branch, tag, or commit hash) */
  base: string;
  /** Head git ref (default: working tree / HEAD) */
  head?: string;
  /** Only include symbols of these kinds */
  kinds?: string[];
  /** Only include exported/top-level symbols (no parent) */
  publicOnly?: boolean;
}

// ─── Implementation ────────────────────────────────────────────────────────

/**
 * Get list of files changed between two git refs.
 */
function getChangedFiles(root: string, base: string, head: string): string[] {
  const cmd = head === 'WORKTREE'
    ? `git diff --name-only ${base}`
    : `git diff --name-only ${base}...${head}`;
  try {
    const out = execSync(cmd, { cwd: root, encoding: 'utf8', timeout: 30_000 });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Checkout files from a specific ref into a temporary directory.
 * Only checks out the files that changed.
 */
function checkoutFilesToTemp(
  root: string,
  ref: string,
  files: string[],
): string {
  const tmp = mkdtempSync(join(tmpdir(), 'cg-diff-'));
  for (const f of files) {
    try {
      const content = execSync(`git show ${ref}:${f.replace(/\\/g, '/')}`, {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const dest = join(tmp, f);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    } catch {
      // File might not exist in that ref (added/deleted) — skip
    }
  }
  return tmp;
}

interface SymbolRow {
  name: string;
  kind: string;
  signature: string | null;
  start_line: number;
  parent_id: number | null;
  file_path: string;
}

/**
 * Index a set of files in a temp directory and return their symbols.
 */
async function indexAndExtract(
  files: string[],
  tmpRoot: string,
): Promise<Map<string, SymbolRow>> {
  const dbPath = join(tmpRoot, '.synapse', 'graph.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase({ path: dbPath });
  try {
    await indexRepo(db, { root: tmpRoot, concurrency: 4, skipResolve: true });
    const rows = db.prepare(`
      SELECT s.name, s.kind, s.signature, s.start_line, s.parent_id, f.path AS file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
    `).all() as SymbolRow[];

    const map = new Map<string, SymbolRow>();
    for (const r of rows) {
      // Key: file#name#kind for unique identification
      map.set(`${r.file_path}#${r.name}#${r.kind}`, r);
    }
    return map;
  } finally {
    db.close();
  }
}

/**
 * Copy working-tree versions of the changed files into a temp dir.
 */
function copyWorktreeFiles(root: string, files: string[]): string {
  const tmp = mkdtempSync(join(tmpdir(), 'cg-diff-head-'));
  for (const f of files) {
    try {
      const content = readFileSync(resolve(root, f), 'utf8');
      const dest = join(tmp, f);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    } catch {
      // File might have been deleted in working tree
    }
  }
  return tmp;
}

/**
 * Compare public APIs between two git refs.
 *
 * Usage:
 * ```ts
 * const result = await diffApis({ root: '/repo', base: 'main' });
 * // result.changes → [{change: 'added', name: 'newFunc', kind: 'function', ...}]
 * ```
 */
export async function diffApis(opts: DiffOptions): Promise<DiffResult> {
  const t0 = Date.now();
  const root = resolve(opts.root);
  const base = opts.base;
  const head = opts.head ?? 'WORKTREE';

  // 1. Find changed files.
  const filesChanged = getChangedFiles(root, base, head);
  if (filesChanged.length === 0) {
    return { base, head, filesChanged: [], changes: [], durationMs: Date.now() - t0 };
  }

  // 2. Checkout base versions and index them.
  const baseDir = checkoutFilesToTemp(root, base, filesChanged);
  let headDir: string;
  if (head === 'WORKTREE') {
    headDir = copyWorktreeFiles(root, filesChanged);
  } else {
    headDir = checkoutFilesToTemp(root, head, filesChanged);
  }

  try {
    const [baseSymbols, headSymbols] = await Promise.all([
      indexAndExtract(filesChanged, baseDir),
      indexAndExtract(filesChanged, headDir),
    ]);

    // 3. Compare.
    const changes: ApiChange[] = [];
    const kinds = opts.kinds ? new Set(opts.kinds) : null;

    const shouldInclude = (r: SymbolRow): boolean => {
      if (kinds && !kinds.has(r.kind)) return false;
      if (opts.publicOnly && r.parent_id != null) return false;
      return true;
    };

    // Removed: in base but not in head.
    for (const [key, sym] of baseSymbols) {
      if (!shouldInclude(sym)) continue;
      if (!headSymbols.has(key)) {
        changes.push({
          change: 'removed',
          name: sym.name,
          kind: sym.kind,
          file: sym.file_path,
          line: sym.start_line,
          oldSignature: sym.signature ?? undefined,
        });
      }
    }

    // Added: in head but not in base.
    for (const [key, sym] of headSymbols) {
      if (!shouldInclude(sym)) continue;
      if (!baseSymbols.has(key)) {
        changes.push({
          change: 'added',
          name: sym.name,
          kind: sym.kind,
          file: sym.file_path,
          line: sym.start_line,
          newSignature: sym.signature ?? undefined,
        });
      }
    }

    // Modified: same key but different signature.
    for (const [key, headSym] of headSymbols) {
      if (!shouldInclude(headSym)) continue;
      const baseSym = baseSymbols.get(key);
      if (baseSym && baseSym.signature !== headSym.signature) {
        changes.push({
          change: 'modified',
          name: headSym.name,
          kind: headSym.kind,
          file: headSym.file_path,
          line: headSym.start_line,
          oldSignature: baseSym.signature ?? undefined,
          newSignature: headSym.signature ?? undefined,
        });
      }
    }

    // Sort: removed first, then modified, then added.
    const order = { removed: 0, modified: 1, added: 2 };
    changes.sort((a, b) => order[a.change] - order[b.change] || a.file.localeCompare(b.file));

    return { base, head, filesChanged, changes, durationMs: Date.now() - t0 };
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(headDir, { recursive: true, force: true });
  }
}
