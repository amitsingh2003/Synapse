/**
 * @synapse/core
 *
 * Phase 1 surface: DB layer, parser, single-file indexer.
 */

export const CORE_VERSION = '0.1.0';

/** Sanity helper used by the Phase 0 smoke test. */
export function ping(): 'pong' {
  return 'pong';
}

export * from './db/index.js';
export * from './parser/index.js';
export * from './indexer/index.js';
export * from './resolver/index.js';
export * from './languages/index.js';
export * from './embeddings/index.js';
export * from './diff/index.js';
export * from './scip/index.js';
export * from './retriever/index.js';
export * from './telemetry.js';
export { log, setLogLevel, getLogLevel } from './log.js';
export type { LogLevel } from './log.js';
