import { readFile, stat } from 'node:fs/promises';
import { readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import xxhash from 'xxhash-wasm';
import { detectLanguage, type Language } from '../parser/language.js';
import { shouldSkipDir, isKnownCodeExtension } from './skipPolicy.js';
import { createIgnoreStack, type IgnoreStack } from './ignoreStack.js';

export interface DiscoveredFile {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Path relative to the repo root, always using forward slashes. */
  relPath: string;
  language: Language;
  sizeBytes: number;
  mtimeMs: number;
  /** Content xxhash64 hex string. */
  xxhash: string;
}

export interface DiscoverOptions {
  /** Absolute path of the repo root. */
  root: string;
  /** Skip files larger than this many bytes (default 1 MiB). */
  maxFileSize?: number;
  /** Extra ignore patterns appended on top of .gitignore. */
  extraIgnores?: readonly string[];
  /** Optional callback fired for every skipped file. */
  onSkip?: (skip: DiscoverSkip) => void;
}

export type SkipReason =
  | 'unsupported_language'
  | 'too_large'
  | 'permission_error'
  | 'read_error'
  | 'symlink_cycle';

export interface DiscoverSkip {
  absolutePath: string;
  reason: SkipReason;
  detail?: string;
}

interface HashAPI {
  h64Raw: (input: Uint8Array) => bigint;
}

let hashPromise: Promise<HashAPI> | null = null;
async function getHasher(): Promise<HashAPI> {
  if (!hashPromise) hashPromise = xxhash() as unknown as Promise<HashAPI>;
  return hashPromise;
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/**
 * Walk the repo, honour ignore stack + HARD_SKIP_DIRS, return one
 * DiscoveredFile per indexable source file.
 *
 * Phase 11: uses the shared `shouldSkipDir` predicate and the layered
 * `IgnoreStack` (nested .gitignore + .synapseignore + global gitignore).
 * Tracks visited real paths to guard against symlink cycles.
 */
export async function discoverFiles(opts: DiscoverOptions): Promise<DiscoveredFile[]> {
  const root = resolve(opts.root);
  const stack: IgnoreStack = createIgnoreStack({ root, extraPatterns: opts.extraIgnores });
  const maxSize = opts.maxFileSize ?? 1_048_576;
  const hasher = await getHasher();
  const onSkip = opts.onSkip ?? (() => undefined);

  const candidates: string[] = [];
  // Track visited real paths so symlink loops can't make us spin forever.
  const visitedReal = new Set<string>();

  // Seed root's own .gitignore (base layer already loaded it, but addNested
  // is idempotent and lets us treat the root uniformly).
  stack.addNested(root);

  const walk = (dir: string): void => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      real = dir;
    }
    if (visitedReal.has(real)) {
      onSkip({ absolutePath: dir, reason: 'symlink_cycle', detail: `already visited ${real}` });
      return;
    }
    visitedReal.add(real);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      onSkip({
        absolutePath: dir,
        reason: 'permission_error',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name)) continue;
        const rel = toRel(root, abs);
        if (rel && stack.ignores(rel, true)) continue;
        // Pick up this directory's own .gitignore before descending.
        stack.addNested(abs);
        walk(abs);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        const rel = toRel(root, abs);
        if (!rel || stack.ignores(rel, false)) continue;
        if (!detectLanguage(abs)) {
          if (isKnownCodeExtension(abs)) {
            onSkip({ absolutePath: abs, reason: 'unsupported_language' });
          }
          continue;
        }
        candidates.push(abs);
      }
    }
  };
  walk(root);

  const out: DiscoveredFile[] = [];
  for (const abs of candidates) {
    let stats;
    try {
      stats = await stat(abs);
    } catch (err) {
      onSkip({
        absolutePath: abs,
        reason: 'permission_error',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (stats.size > maxSize) {
      onSkip({
        absolutePath: abs,
        reason: 'too_large',
        detail: `${(stats.size / 1024).toFixed(0)} KB exceeds limit ${(maxSize / 1024).toFixed(0)} KB`,
      });
      continue;
    }
    let buf;
    try {
      buf = await readFile(abs);
    } catch (err) {
      onSkip({
        absolutePath: abs,
        reason: 'read_error',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const language = detectLanguage(abs);
    if (!language) continue;
    const hash = hasher.h64Raw(buf).toString(16);
    out.push({
      absolutePath: abs,
      relPath: toRel(root, abs),
      language,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      xxhash: hash,
    });
  }
  return out;
}
