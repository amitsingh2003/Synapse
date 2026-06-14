/**
 * Phase 25 — New tool tests.
 *
 * Covers:
 *  - findDeadCode: SQL query for symbols with no incoming edges
 *  - codeMetrics: per-file function/class/edge metrics
 *  - scanSecurity: graceful degradation when semgrep not installed
 *  - structuralSearch: graceful degradation when ast-grep not installed
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, indexRepo, resolveReferences } from '@synapse/core';
import type { Database as DB } from 'better-sqlite3';
import { findDeadCode, codeMetrics, scanSecurity, structuralSearch } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'fixtures', 'sample-shopping-app');

let dbDir: string;
let db: DB;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'cg-tools-'));
  db = openDatabase({ path: join(dbDir, 'graph.db') });
  await indexRepo(db, { root: FIXTURE, concurrency: 2 });
  resolveReferences(db, { root: FIXTURE });
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dbDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findDeadCode
// ---------------------------------------------------------------------------

describe('findDeadCode', () => {
  it('returns a result object with required fields', () => {
    const result = findDeadCode(db, { rootDir: FIXTURE });
    expect(result).toHaveProperty('symbols');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('kinds');
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(Array.isArray(result.kinds)).toBe(true);
  });

  it('total matches the length of symbols array (when not truncated)', () => {
    const result = findDeadCode(db, { limit: 200, rootDir: FIXTURE });
    if (!result.hint) {
      // Not truncated: total should equal symbols.length
      expect(result.symbols.length).toBe(result.total);
    }
  });

  it('respects the kinds filter', () => {
    const fnOnly = findDeadCode(db, { kinds: ['function'], rootDir: FIXTURE });
    for (const sym of fnOnly.symbols) {
      expect(sym.kind).toBe('function');
    }
  });

  it('returns empty when kinds is empty', () => {
    const result = findDeadCode(db, { kinds: [], rootDir: FIXTURE });
    expect(result.symbols).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('respects the limit parameter', () => {
    const unlimited = findDeadCode(db, { limit: 200, rootDir: FIXTURE });
    if (unlimited.total > 2) {
      const limited = findDeadCode(db, { limit: 2, rootDir: FIXTURE });
      expect(limited.symbols.length).toBe(2);
      expect(limited.total).toBe(unlimited.total);
      expect(limited.hint).toMatch(/Showing first/);
    }
  });

  it('restricts results by file_glob', () => {
    const cartOnly = findDeadCode(db, { file_glob: '**/cart.ts', rootDir: FIXTURE });
    for (const sym of cartOnly.symbols) {
      expect(sym.file).toMatch(/cart\.ts/);
    }
  });

  it('each symbol has name, kind, and file fields', () => {
    const result = findDeadCode(db, { rootDir: FIXTURE });
    for (const sym of result.symbols) {
      expect(typeof sym.name).toBe('string');
      expect(typeof sym.kind).toBe('string');
      expect(typeof sym.file).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// codeMetrics
// ---------------------------------------------------------------------------

describe('codeMetrics', () => {
  it('returns a result object with required fields', () => {
    const result = codeMetrics(db, { rootDir: FIXTURE });
    expect(result).toHaveProperty('files');
    expect(result).toHaveProperty('total_files');
    expect(result).toHaveProperty('truncated');
    expect(Array.isArray(result.files)).toBe(true);
  });

  it('total_files reflects all indexed files', () => {
    const result = codeMetrics(db, { top_n: 100, rootDir: FIXTURE });
    expect(result.total_files).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThanOrEqual(result.total_files);
  });

  it('each file entry has expected metric fields', () => {
    const result = codeMetrics(db, { rootDir: FIXTURE });
    for (const f of result.files) {
      expect(typeof f.file).toBe('string');
      expect(typeof f.functions).toBe('number');
      expect(typeof f.classes).toBe('number');
      expect(typeof f.avg_fn_lines).toBe('number');
      expect(typeof f.max_fn_lines).toBe('number');
      expect(typeof f.total_edges_in).toBe('number');
      expect(f.functions).toBeGreaterThanOrEqual(0);
      expect(f.classes).toBeGreaterThanOrEqual(0);
    }
  });

  it('cart.ts has at least one function and one class', () => {
    const result = codeMetrics(db, { file_glob: '**/cart.ts', top_n: 10, rootDir: FIXTURE });
    const cartFile = result.files.find((f) => f.file.includes('cart.ts'));
    expect(cartFile).toBeDefined();
    if (cartFile) {
      expect(cartFile.functions).toBeGreaterThan(0);
      expect(cartFile.classes).toBeGreaterThanOrEqual(1);
    }
  });

  it('respects the file_glob filter', () => {
    const cartOnly = codeMetrics(db, { file_glob: '**/cart.ts', rootDir: FIXTURE });
    for (const f of cartOnly.files) {
      expect(f.file).toMatch(/cart\.ts/);
    }
  });

  it('respects the top_n limit', () => {
    const result = codeMetrics(db, { top_n: 1, rootDir: FIXTURE });
    expect(result.files.length).toBeLessThanOrEqual(1);
  });

  it('function line counts are non-negative', () => {
    const result = codeMetrics(db, { rootDir: FIXTURE });
    for (const f of result.files) {
      expect(f.avg_fn_lines).toBeGreaterThanOrEqual(0);
      expect(f.max_fn_lines).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// scanSecurity
// ---------------------------------------------------------------------------

describe('scanSecurity', () => {
  it('returns a result with required fields regardless of semgrep installation', () => {
    const result = scanSecurity(db, { rootDir: FIXTURE });
    expect(result).toHaveProperty('findings');
    expect(result).toHaveProperty('total_findings');
    expect(result).toHaveProperty('config');
    expect(Array.isArray(result.findings)).toBe(true);
  });

  it('gracefully handles missing semgrep installation', () => {
    const result = scanSecurity(db, { rootDir: FIXTURE });
    if (!result.installed) {
      // Semgrep not installed: should have a descriptive error message
      expect(result.error ?? result.errors?.[0] ?? '').toMatch(/semgrep/i);
    } else {
      // Semgrep ran; just verify the structure is correct
      expect(result.total_findings).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not throw when semgrep is not in PATH', () => {
    expect(() => scanSecurity(db, { rootDir: FIXTURE })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// structuralSearch
// ---------------------------------------------------------------------------

describe('structuralSearch', () => {
  it('returns a result with required fields regardless of ast-grep installation', async () => {
    const result = await structuralSearch(db, {
      pattern: 'export function $NAME',
      language: 'ts',
      rootDir: FIXTURE,
    });
    expect(result).toHaveProperty('matches');
    expect(result).toHaveProperty('total_matches');
    expect(result).toHaveProperty('pattern');
    expect(Array.isArray(result.matches)).toBe(true);
  });

  it('does not throw when ast-grep is not installed', async () => {
    await expect(
      structuralSearch(db, { pattern: 'function $F($$$ARGS)', language: 'ts', rootDir: FIXTURE }),
    ).resolves.toBeDefined();
  });

  it('gracefully handles missing ast-grep installation', async () => {
    const result = await structuralSearch(db, {
      pattern: 'export class $NAME',
      language: 'ts',
      rootDir: FIXTURE,
    });
    if (result.error) {
      // ast-grep not installed: should mention how to install it
      expect(result.error).toMatch(/ast-grep/i);
      expect(result.matches).toHaveLength(0);
    } else {
      // ast-grep IS installed — verify real results
      expect(result.total_matches).toBeGreaterThanOrEqual(0);
    }
  });
});
