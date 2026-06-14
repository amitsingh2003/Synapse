export { openDatabase, runMigrations, getManifestValue, setManifestValue, compactDatabase } from './open.js';
export type { OpenDbOptions } from './open.js';
export { SCHEMA_VERSION } from './migrations.js';
export { Queries } from './queries.js';
export type {
  SymbolKind,
  EdgeKind,
  FileRow,
  SymbolRow,
  EdgeRow,
  IncomingEdge,
  OutgoingEdge,
  FileImportRow,
  NewSymbol,
  NewEdge,
  NewFileImport,
} from './queries.js';
export { collectStats } from './stats.js';
export type { DbStats } from './stats.js';
