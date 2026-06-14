/**
 * Phase 11.1 + 11.4 — single source of truth for "which paths should we never
 * descend into or watch", shared by `discover.ts` and `watcher.ts`.
 *
 * Entries are grouped by ecosystem so it's obvious where to add a new one
 * when adding language support. Match is by **basename** (case-sensitive on
 * Unix, case-insensitive in the predicate below).
 */

/** SCM metadata dirs. */
const SCM_DIRS = ['.git', '.hg', '.svn', '.bzr', '_darcs'] as const;

/** JS / TS ecosystem. */
const JS_DIRS = [
  'node_modules', '.pnpm-store', '.yarn',
  'dist', 'build', 'out',
  '.next', '.nuxt', '.svelte-kit', '.astro',
  '.turbo', '.cache', '.parcel-cache',
  'coverage', '.nyc_output',
] as const;

/** Python ecosystem. */
const PY_DIRS = [
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.venv', 'venv', 'env', '.eggs', '*.egg-info',
] as const;

/** Rust. */
const RUST_DIRS = ['target'] as const;

/** Go. */
const GO_DIRS = ['vendor'] as const;

/** Java / Kotlin / Gradle / Maven. */
const JVM_DIRS = ['.gradle', 'gradle', '.idea', 'target', 'build', 'bin', 'out'] as const;

/** Apple / iOS / Xcode. */
const APPLE_DIRS = [
  'Pods', 'DerivedData', '.swiftpm', 'xcuserdata',
  '*.xcworkspace', '*.xcodeproj',
] as const;

/** Terraform / infra. */
const INFRA_DIRS = ['.terraform', '.terragrunt-cache'] as const;

/** IDE / editor metadata. */
const IDE_DIRS = ['.vscode', '.idea', '.vs', '.fleet', '.history'] as const;

/** Synapse's own data dir. */
const SELF_DIRS = ['.synapse'] as const;

/**
 * Combined hard-skip set. Membership is checked against directory basenames
 * during the walk and as a chokidar `ignored` predicate.
 */
export const HARD_SKIP_DIRS: ReadonlySet<string> = new Set<string>([
  ...SCM_DIRS,
  ...JS_DIRS,
  ...PY_DIRS,
  ...RUST_DIRS,
  ...GO_DIRS,
  ...JVM_DIRS,
  ...APPLE_DIRS,
  ...INFRA_DIRS,
  ...IDE_DIRS,
  ...SELF_DIRS,
]);

/** Patterns containing `*` are checked via simple suffix/prefix match. */
const WILDCARD_PATTERNS: readonly { test: (name: string) => boolean }[] = [
  { test: (n) => n.endsWith('.egg-info') },
  { test: (n) => n.endsWith('.xcworkspace') },
  { test: (n) => n.endsWith('.xcodeproj') },
];

/**
 * Decide whether a directory basename should be skipped without descending.
 *
 * Both the directory walker (`discover`) and chokidar watcher (`watcher`)
 * call this. Keep it cheap — it's invoked once per directory entry.
 */
export function shouldSkipDir(basename: string): boolean {
  if (HARD_SKIP_DIRS.has(basename)) return true;
  for (const w of WILDCARD_PATTERNS) {
    if (w.test(basename)) return true;
  }
  return false;
}

/**
 * Predicate for chokidar's `ignored` option. Receives any path under the
 * watch root; we just check whether any path segment is a hard-skip dir.
 *
 * Using `/` and `\\` both because Windows paths show up with backslashes.
 */
export function shouldSkipPath(p: string): boolean {
  // Split on either separator without regex back-tracking pitfalls.
  const segs = p.split(/[\\/]/);
  for (const s of segs) {
    if (!s) continue;
    if (shouldSkipDir(s)) return true;
  }
  return false;
}

/**
 * Common code-file extensions that aren't currently supported by any adapter
 * but are plausibly indexable in the future. We log them as
 * `unsupported_language` skips so users see "we noticed your Python but can't
 * parse it yet" rather than silent omission.
 */
export const KNOWN_CODE_EXTS: ReadonlySet<string> = new Set([
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php',
  '.swift', '.c', '.cpp', '.cc', '.h', '.hpp', '.scala', '.zig',
  '.lua', '.dart', '.ex', '.exs', '.clj', '.cljs', '.ml', '.mli', '.hs',
]);

export function isKnownCodeExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return KNOWN_CODE_EXTS.has(path.slice(dot).toLowerCase());
}
