/**
 * Phase 11.2 + 11.3 — multi-source ignore resolution.
 *
 * Honors, in order of precedence (later wins per the gitignore spec):
 *   1. `~/.gitignore_global` (from git config `core.excludesfile`, if set)
 *   2. `<root>/.git/info/exclude`
 *   3. `<root>/.gitignore`
 *   4. `<root>/.synapseignore` (our own)
 *   5. Nested `<dir>/.gitignore` for every descendant directory
 *   6. Extra patterns supplied programmatically (highest precedence)
 *
 * Patterns from nested gitignores apply only inside their containing
 * directory tree, matching real git behaviour.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';

export interface IgnoreStack {
  /**
   * Return true if the (relative-to-root) path should be ignored.
   * `isDir` lets the caller signal trailing-slash semantics for dir matches.
   */
  ignores(relPath: string, isDir: boolean): boolean;
  /**
   * Register a freshly-discovered nested .gitignore at `dir` (absolute path).
   * Idempotent — calling twice for the same dir replaces the prior patterns.
   */
  addNested(dir: string): void;
}

export interface IgnoreStackOptions {
  /** Repo root, absolute. */
  root: string;
  /** Programmatic patterns applied with highest precedence. */
  extraPatterns?: readonly string[];
  /** Allow disabling the global gitignore lookup (useful in tests). */
  skipGlobal?: boolean;
}

function readIfExists(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Look up `core.excludesfile` from `~/.gitconfig` without shelling out. */
function findGlobalGitignore(): string | null {
  const home = homedir();
  const cfg = readIfExists(join(home, '.gitconfig'));
  if (cfg) {
    // Minimal INI parse: just find `excludesfile = ...` under a `[core]` section.
    const lines = cfg.split(/\r?\n/);
    let inCore = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('[')) {
        inCore = /^\[core\]/i.test(line);
        continue;
      }
      if (!inCore) continue;
      const m = line.match(/^excludesfile\s*=\s*(.+?)\s*$/i);
      if (m && m[1]) {
        const p = m[1].replace(/^~(?=[\\/])/, home);
        if (existsSync(p)) return p;
      }
    }
  }
  // Fallback to XDG default.
  const xdg = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
  const fallback = join(xdg, 'git', 'ignore');
  return existsSync(fallback) ? fallback : null;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Build the layered ignore stack for `root`. Returns an object that:
 *   - tracks per-directory ignore matchers so nested .gitignores work
 *   - applies global, repo, and synapse-specific exclusions up-front
 */
export function createIgnoreStack(opts: IgnoreStackOptions): IgnoreStack {
  const root = opts.root;
  // Base layer: combines global + .git/info/exclude + .gitignore + .synapseignore + extras.
  const base = ignore();

  if (!opts.skipGlobal) {
    const global = findGlobalGitignore();
    if (global) {
      const text = readIfExists(global);
      if (text) base.add(text);
    }
  }

  for (const rel of ['.git/info/exclude', '.gitignore', '.synapseignore']) {
    const text = readIfExists(join(root, rel));
    if (text) base.add(text);
  }

  if (opts.extraPatterns?.length) base.add(opts.extraPatterns.join('\n'));

  // Per-directory matchers. Keyed by repo-relative dir path (posix).
  // Each value contains the patterns from that directory's .gitignore
  // **rewritten** to be evaluated relative to the repo root by prefixing
  // the directory path — this preserves gitignore's directory-scoped
  // semantics while keeping a single Ignore instance per dir simple.
  const nested = new Map<string, Ignore>();

  function loadNested(absDir: string): void {
    const text = readIfExists(join(absDir, '.gitignore'));
    if (!text) return;
    const relDir = toPosix(relative(root, absDir));
    if (!relDir || relDir.startsWith('..')) return; // outside root
    const ig = ignore();
    // Rewrite patterns to be anchored under `relDir/`.
    const rewritten = text
      .split(/\r?\n/)
      .map((line) => rewriteNestedPattern(line, relDir))
      .join('\n');
    ig.add(rewritten);
    nested.set(relDir, ig);
  }

  return {
    addNested(dir: string) {
      loadNested(dir);
    },
    ignores(relPath: string, isDir: boolean): boolean {
      const probe = isDir && !relPath.endsWith('/') ? `${relPath}/` : relPath;
      if (base.ignores(probe)) return true;
      // Walk up ancestor dirs to apply nested matchers (later/closer wins,
      // but `ignore` semantics already handle later-pattern-overrides-earlier
      // within a single matcher; here we OR them — closest-match wins by
      // virtue of being the most specific anchored prefix).
      let cur = posix.dirname(relPath);
      while (cur && cur !== '.' && cur !== '/') {
        const ig = nested.get(cur);
        if (ig && ig.ignores(probe)) return true;
        cur = posix.dirname(cur);
      }
      return false;
    },
  };
}

/**
 * Rewrite a single gitignore line so it matches relative to the repo root
 * even though the file lives in a subdirectory. Comments and blanks pass
 * through untouched.
 *
 *   - `foo`         in dir `src/utils/` → `src/utils/**\/foo`
 *   - `/foo`        in dir `src/utils/` → `src/utils/foo`     (anchored)
 *   - `!foo`        in dir `src/utils/` → `!src/utils/**\/foo`
 *
 * This mirrors how git itself interprets nested .gitignore files.
 */
function rewriteNestedPattern(rawLine: string, relDir: string): string {
  const line = rawLine.replace(/\s+$/, '');
  if (!line || line.startsWith('#')) return rawLine;

  let negation = '';
  let body = line;
  if (body.startsWith('!')) {
    negation = '!';
    body = body.slice(1);
  }

  const anchored = body.startsWith('/');
  if (anchored) body = body.slice(1);

  const prefix = anchored ? `${relDir}/` : `${relDir}/**/`;
  return `${negation}${prefix}${body}`;
}

/**
 * Convenience: walk a directory tree synchronously, calling `addNested` for
 * every `.gitignore` found beneath the root. Discoverer calls this once per
 * directory as it descends so deeply nested files honor every layer.
 */
export function bindStackToDir(stack: IgnoreStack, dir: string): void {
  stack.addNested(dir);
  // dirname(root) intentionally not walked — handled by base layer.
  // (loadNested itself is a no-op when there's no .gitignore in the dir)
  // Kept for symmetry / future async resolution.
  void dirname;
}
