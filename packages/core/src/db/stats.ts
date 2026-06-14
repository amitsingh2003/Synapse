import type { Database as DB } from 'better-sqlite3';

export interface DbStats {
  files: number;
  symbols: number;
  edges: number;
  symbolsByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  dbSizeBytes: number;
}

/** Cheap summary used by `synapse stats`. All single-row aggregates. */
export function collectStats(db: DB): DbStats {
  const files = (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
  const symbols = (db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n;
  const edges = (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n;

  const symbolsByKind: Record<string, number> = {};
  for (const row of db
    .prepare('SELECT kind, COUNT(*) AS n FROM symbols GROUP BY kind')
    .all() as { kind: string; n: number }[]) {
    symbolsByKind[row.kind] = row.n;
  }

  const edgesByKind: Record<string, number> = {};
  for (const row of db
    .prepare('SELECT kind, COUNT(*) AS n FROM edges GROUP BY kind')
    .all() as { kind: string; n: number }[]) {
    edgesByKind[row.kind] = row.n;
  }

  const page = db.pragma('page_size', { simple: true }) as number;
  const pages = db.pragma('page_count', { simple: true }) as number;

  return {
    files,
    symbols,
    edges,
    symbolsByKind,
    edgesByKind,
    dbSizeBytes: page * pages,
  };
}
