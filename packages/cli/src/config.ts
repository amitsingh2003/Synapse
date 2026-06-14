import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

/**
 * Persistent project configuration written to `.synapse/config.json`.
 *
 * Kept intentionally tiny in Phase 6. Each field is optional so the file can
 * grow without breaking old installs.
 */
export interface SynapseConfig {
  /** Schema version of this config file. */
  version: 1;
  /** Workspace root (absolute path at write time, resolved relatively at read time). */
  root?: string;
  /** Path to the SQLite graph DB. */
  db?: string;
  /** Indexer defaults. */
  indexer?: {
    concurrency?: number;
  };
  /** Watcher defaults. */
  watcher?: {
    debounceMs?: number;
  };
}

export const DEFAULT_CONFIG: SynapseConfig = {
  version: 1,
  db: '.synapse/graph.db',
  indexer: { concurrency: 8 },
  watcher: { debounceMs: 250 },
};

export function configPath(root: string): string {
  return resolve(root, '.synapse', 'config.json');
}

export function readConfig(root: string): SynapseConfig | null {
  const p = configPath(root);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SynapseConfig;
  } catch {
    return null;
  }
}

export function writeConfig(root: string, cfg: SynapseConfig): string {
  const p = configPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return p;
}

/**
 * Phase 9: Walk up from `startDir` (default cwd) looking for a
 * `.synapse/config.json`. Returns the resolved config and the root
 * directory it was found in, or null if none found.
 */
export function findConfigUp(startDir?: string): { root: string; config: SynapseConfig } | null {
  let dir = resolve(startDir ?? process.cwd());
  const { root: systemRoot } = { root: (dir.match(/^[A-Za-z]:\\/) ? dir.slice(0, 3) : '/') };
  while (true) {
    const candidate = join(dir, '.synapse', 'config.json');
    if (existsSync(candidate)) {
      try {
        const cfg = JSON.parse(readFileSync(candidate, 'utf8')) as SynapseConfig;
        return { root: dir, config: cfg };
      } catch {
        // malformed config — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir || parent === systemRoot) break;
    dir = parent;
  }
  return null;
}

/**
 * Phase 9: Resolve the DB path by:
 *  1. Explicit `--db` flag
 *  2. `.synapse/config.json` found by walking up
 *  3. Fallback: `.synapse/graph.db` relative to cwd
 */
export function resolveDbPath(explicitDb?: string): string {
  if (explicitDb) return resolve(explicitDb);
  const found = findConfigUp();
  if (found && found.config.db) {
    return resolve(found.root, found.config.db);
  }
  return resolve(process.cwd(), '.synapse', 'graph.db');
}
