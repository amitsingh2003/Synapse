import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as pathResolve, normalize, sep } from 'node:path';

/**
 * Phase 14.1 / 14.2 / 14.3 — TypeScript project context.
 *
 * Reads `tsconfig.json` (with `extends` chain) for `compilerOptions.paths`
 * and `baseUrl`, plus per-package `package.json` `main`/`module`/`exports`
 * fields and pnpm/yarn/npm workspace globs. Everything is loaded lazily and
 * cached per repo root.
 *
 * The cache is keyed by repo root, then specifier+fromDir, so workspaces
 * with deep `tsconfig` extends chains pay the disk cost only once per run.
 */
export interface TsProject {
  root: string;
  /** Absolute baseUrl directory. May be null if tsconfig didn't set one. */
  baseUrl: string | null;
  /** Path-mapping entries: `{ pattern, targets }`. Patterns may contain a single `*`. */
  paths: PathEntry[];
  /** Workspace package roots (absolute), discovered from package.json globs. */
  workspacePackages: WorkspacePackage[];
}

export interface PathEntry {
  pattern: string;
  /** Targets relative to baseUrl (or to tsconfig dir if no baseUrl). */
  targets: readonly string[];
  /** Absolute base directory the targets are resolved against. */
  baseDir: string;
}

export interface WorkspacePackage {
  /** `name` from package.json. */
  name: string;
  /** Absolute path to the package root (containing package.json). */
  dir: string;
  /** Parsed package.json. */
  pkg: PackageJson;
}

export interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  workspaces?: string[] | { packages?: string[] };
}

const projectCache = new Map<string, TsProject>();

/** Test hook — wipe the per-root cache. */
export function _clearTsProjectCache(): void {
  projectCache.clear();
}

export function loadTsProject(root: string): TsProject {
  const cached = projectCache.get(root);
  if (cached) return cached;

  const { baseUrl, paths } = readTsConfig(root);
  const workspacePackages = readWorkspaces(root);
  const project: TsProject = { root, baseUrl, paths, workspacePackages };
  projectCache.set(root, project);
  return project;
}

// ---------------------------------------------------------------------------
// tsconfig.json (14.1)
// ---------------------------------------------------------------------------

function readTsConfig(root: string): { baseUrl: string | null; paths: PathEntry[] } {
  const tsconfigPath = join(root, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return { baseUrl: null, paths: [] };

  const visited = new Set<string>();
  const merged = mergeTsConfigChain(tsconfigPath, visited);
  if (!merged) return { baseUrl: null, paths: [] };

  const co = (merged.compilerOptions ?? {}) as {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
  // baseUrl is relative to the tsconfig file that defined it. We simplify:
  // resolve against the *root* tsconfig dir.
  const baseDir = co.baseUrl ? pathResolve(dirname(tsconfigPath), co.baseUrl) : null;
  const pathsObj = co.paths ?? {};
  const entries: PathEntry[] = [];
  for (const [pattern, targets] of Object.entries(pathsObj)) {
    if (!Array.isArray(targets)) continue;
    entries.push({
      pattern,
      targets,
      baseDir: baseDir ?? dirname(tsconfigPath),
    });
  }
  return { baseUrl: baseDir, paths: entries };
}

function mergeTsConfigChain(
  tsconfigPath: string,
  visited: Set<string>,
): { compilerOptions?: Record<string, unknown> } | null {
  if (visited.has(tsconfigPath)) return null;
  visited.add(tsconfigPath);
  const parsed = parseJsonc(tsconfigPath);
  if (!parsed) return null;

  let base: { compilerOptions?: Record<string, unknown> } = {};
  const extendsField = (parsed as { extends?: string | string[] }).extends;
  const extendsList = Array.isArray(extendsField)
    ? extendsField
    : extendsField
      ? [extendsField]
      : [];
  for (const ext of extendsList) {
    const extPath = resolveExtendsPath(ext, dirname(tsconfigPath));
    if (!extPath) continue;
    const child = mergeTsConfigChain(extPath, visited);
    if (child) base = deepMerge(base, child);
  }
  return deepMerge(base, parsed as { compilerOptions?: Record<string, unknown> });
}

function resolveExtendsPath(spec: string, fromDir: string): string | null {
  // Relative path
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const direct = pathResolve(fromDir, spec);
    if (existsSync(direct)) return direct;
    const withJson = direct.endsWith('.json') ? direct : `${direct}.json`;
    if (existsSync(withJson)) return withJson;
    return null;
  }
  // Package name — best-effort: look in node_modules walking up.
  let cur = fromDir;
  while (true) {
    const candidate = join(cur, 'node_modules', spec);
    if (existsSync(candidate)) {
      const stat = safeStat(candidate);
      if (stat?.isFile()) return candidate;
      const tsc = join(candidate, 'tsconfig.json');
      if (existsSync(tsc)) return tsc;
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function parseJsonc(file: string): unknown {
  try {
    const raw = readFileSync(file, 'utf8');
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return null;
  }
}

/** Minimal JSONC stripper: removes // line comments and /* … *\/ block comments. */
function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inStr: string | null = null;
  while (i < n) {
    const ch = src[i]!;
    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Also strip trailing commas — JSON.parse rejects them.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function deepMerge<T extends Record<string, unknown>>(a: T, b: T): T {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') {
      out[k] = deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// workspaces + package.json (14.2 / 14.3)
// ---------------------------------------------------------------------------

function readWorkspaces(root: string): WorkspacePackage[] {
  const rootPkg = parseJsonc(join(root, 'package.json')) as PackageJson | null;
  const globs = collectWorkspaceGlobs(root, rootPkg);
  if (globs.length === 0) return [];

  const packages: WorkspacePackage[] = [];
  for (const glob of globs) {
    for (const dir of expandWorkspaceGlob(root, glob)) {
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = parseJsonc(pkgPath) as PackageJson | null;
      if (!pkg?.name) continue;
      packages.push({ name: pkg.name, dir, pkg });
    }
  }
  return packages;
}

function collectWorkspaceGlobs(root: string, rootPkg: PackageJson | null): string[] {
  const out: string[] = [];
  // npm/yarn: package.json "workspaces"
  if (rootPkg) {
    const ws = rootPkg.workspaces;
    if (Array.isArray(ws)) out.push(...ws);
    else if (ws && Array.isArray(ws.packages)) out.push(...ws.packages);
  }
  // pnpm-workspace.yaml — naive single-line parser, good enough for the
  // canonical `packages: ['…']` shape.
  const pnpmYaml = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpmYaml)) {
    try {
      const raw = readFileSync(pnpmYaml, 'utf8');
      const matches = raw.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm);
      for (const m of matches) out.push(m[1]!);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Expand a workspace glob like `packages/*` to an array of absolute dirs. */
function expandWorkspaceGlob(root: string, glob: string): string[] {
  // Only support the canonical `<segments>/*` and `<segments>/**` shapes —
  // anything else is treated as a literal directory.
  const trimmed = glob.replace(/\\/g, '/').replace(/\/+$/, '');
  const starIdx = trimmed.indexOf('*');
  if (starIdx === -1) {
    const abs = join(root, trimmed);
    return safeIsDir(abs) ? [abs] : [];
  }
  const baseGlob = trimmed.slice(0, starIdx).replace(/\/$/, '');
  const baseAbs = join(root, baseGlob);
  if (!safeIsDir(baseAbs)) return [];
  const tail = trimmed.slice(starIdx);
  // `packages/*` → first-level dirs; `packages/**` → walk recursively (1 level
  // is enough in practice — we cap at depth 2 to avoid pathological repos).
  const recurse = tail.startsWith('**');
  return listSubdirs(baseAbs, recurse ? 2 : 1);
}

function listSubdirs(dir: string, depth: number): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const child = join(dir, name);
    if (!safeIsDir(child)) continue;
    out.push(child);
    if (depth > 1) out.push(...listSubdirs(child, depth - 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/**
 * Apply tsconfig `paths` + `baseUrl` mapping. Returns repo-relative candidate
 * paths (without extensions) to probe, in priority order.
 */
export function resolveViaTsPaths(
  project: TsProject,
  specifier: string,
  root: string,
): string[] {
  const candidates: string[] = [];

  // 1) explicit paths mapping
  for (const entry of project.paths) {
    const match = matchPathPattern(entry.pattern, specifier);
    if (match === null) continue;
    for (const target of entry.targets) {
      const filled = target.replace(/\*/g, match);
      const abs = pathResolve(entry.baseDir, filled);
      const rel = absoluteToRel(abs, root);
      if (rel !== null) candidates.push(rel);
    }
  }

  // 2) bare baseUrl fallback (`baseUrl: 'src'` → `import 'foo/bar'`)
  if (project.baseUrl && !specifier.startsWith('.') && !isAbsolute(specifier)) {
    const abs = pathResolve(project.baseUrl, specifier);
    const rel = absoluteToRel(abs, root);
    if (rel !== null) candidates.push(rel);
  }

  return candidates;
}

/**
 * Try to resolve `specifier` against a workspace package's entry point
 * (`exports`, `module`, `main`). Returns a repo-relative file path or null.
 */
export function resolveViaWorkspace(
  project: TsProject,
  specifier: string,
  root: string,
): string | null {
  const match = project.workspacePackages.find(
    (w) => w.name === specifier || specifier.startsWith(`${w.name}/`),
  );
  if (!match) return null;
  const subPath = specifier === match.name ? '.' : `./${specifier.slice(match.name.length + 1)}`;
  const entry = resolveExportField(match.pkg, subPath) ?? fallbackEntry(match.pkg, subPath);
  if (!entry) return null;
  const abs = pathResolve(match.dir, entry);
  return absoluteToRel(abs, root);
}

function fallbackEntry(pkg: PackageJson, subPath: string): string | null {
  if (subPath === '.') {
    return pkg.module ?? pkg.main ?? 'index.js';
  }
  // For subpath imports without exports, return the literal subpath.
  return subPath.replace(/^\.\//, '');
}

/**
 * Subset of node's `exports` resolution: handles a plain string, a single
 * conditional object, and a subpath map. Conditions are checked in this
 * preference order: `import`, `default`, `require`, `node`.
 */
function resolveExportField(pkg: PackageJson, subPath: string): string | null {
  const exp = pkg.exports;
  if (!exp) return null;
  if (typeof exp === 'string') {
    return subPath === '.' ? exp : null;
  }
  if (typeof exp !== 'object') return null;

  // Subpath form: { ".": ..., "./feature": ... }
  const obj = exp as Record<string, unknown>;
  const looksLikeSubpathMap = Object.keys(obj).some((k) => k === '.' || k.startsWith('./'));
  if (looksLikeSubpathMap) {
    const direct = obj[subPath];
    if (direct !== undefined) return pickConditional(direct);
    // Try a trailing-`/*` wildcard match
    for (const [key, val] of Object.entries(obj)) {
      if (!key.endsWith('/*')) continue;
      const prefix = key.slice(0, -1); // strip trailing *
      if (subPath.startsWith(prefix)) {
        const rest = subPath.slice(prefix.length);
        const picked = pickConditional(val);
        if (picked) return picked.replace(/\*/g, rest);
      }
    }
    return null;
  }
  // Conditional form (no subpaths): only valid for "."
  return subPath === '.' ? pickConditional(exp) : null;
}

function pickConditional(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of ['import', 'default', 'require', 'node']) {
      if (key in obj) {
        const picked = pickConditional(obj[key]);
        if (picked) return picked;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

function matchPathPattern(pattern: string, specifier: string): string | null {
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return pattern === specifier ? '' : null;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
  return middle;
}

function absoluteToRel(abs: string, root: string): string | null {
  const normAbs = normalize(abs);
  const normRoot = normalize(root);
  if (!normAbs.startsWith(normRoot)) return null;
  let rel = normAbs.slice(normRoot.length);
  if (rel.startsWith(sep)) rel = rel.slice(1);
  return rel.split(sep).join('/');
}

function safeIsDir(p: string): boolean {
  const s = safeStat(p);
  return s?.isDirectory() ?? false;
}

function safeStat(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
