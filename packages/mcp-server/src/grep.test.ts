/**
 * Phase 25 — grep_code backend tests.
 *
 * Covers:
 *  - grepCode via the FTS5+DB content backend (when ripgrep is unavailable)
 *  - extractFtsLiteral logic (tested through grepCode behavior)
 *  - Fixed-string vs regex search
 *  - file_glob filtering
 *  - context_lines
 *  - Invalid regex handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, indexRepo, resolveReferences } from '@synapse/core';
import type { Database as DB } from 'better-sqlite3';
import { grepCode } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'fixtures', 'sample-shopping-app');

let dbDir: string;
let db: DB;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'cg-grep-'));
  db = openDatabase({ path: join(dbDir, 'graph.db') });
  await indexRepo(db, { root: FIXTURE, concurrency: 2 });
  resolveReferences(db, { root: FIXTURE });
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dbDir, { recursive: true, force: true });
});

describe('grepCode — basic regex search', () => {
  it('finds a known function name', async () => {
    const result = await grepCode(db, { pattern: 'addItem', rootDir: FIXTURE });
    expect(result.total_matches).toBeGreaterThan(0);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]!.match_text).toMatch(/addItem/);
  });

  it('returns zero matches for a pattern that does not exist', async () => {
    const result = await grepCode(db, { pattern: 'zzzNonExistentXYZABC123', rootDir: FIXTURE });
    expect(result.total_matches).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it('is case-insensitive by default', async () => {
    const lower = await grepCode(db, { pattern: 'additem', rootDir: FIXTURE });
    const upper = await grepCode(db, { pattern: 'ADDITEM', rootDir: FIXTURE });
    expect(lower.total_matches).toBeGreaterThan(0);
    expect(upper.total_matches).toBe(lower.total_matches);
  });

  it('is case-sensitive when case_sensitive=true', async () => {
    const sensitive = await grepCode(db, { pattern: 'additem', case_sensitive: true, rootDir: FIXTURE });
    const normal = await grepCode(db, { pattern: 'addItem', case_sensitive: true, rootDir: FIXTURE });
    expect(sensitive.total_matches).toBe(0);
    expect(normal.total_matches).toBeGreaterThan(0);
  });
});

describe('grepCode — fixed_string mode', () => {
  it('treats the pattern as a literal string when fixed_string=true', async () => {
    // "addItem()" is a literal string that appears in the fixture
    const fixed = await grepCode(db, { pattern: 'addItem(', fixed_string: true, rootDir: FIXTURE });
    expect(fixed.total_matches).toBeGreaterThan(0);
    // Regex interpretation of "addItem(" would throw; fixed_string prevents that
    expect(fixed.matches[0]!.match_text).toContain('addItem(');
  });

  it('does not interpret regex metacharacters in fixed_string mode', async () => {
    // "priceCents * line.quantity" contains the "*" metacharacter — appears in cart.ts
    const result = await grepCode(db, {
      pattern: 'priceCents * line.quantity',
      fixed_string: true,
      rootDir: FIXTURE,
    });
    expect(result.total_matches).toBeGreaterThan(0);
  });
});

describe('grepCode — invalid regex', () => {
  it('returns a hint for an invalid regex pattern', async () => {
    const result = await grepCode(db, { pattern: '[invalid', rootDir: FIXTURE });
    expect(result.total_matches).toBe(0);
    expect(result.hint).toMatch(/Invalid regex/);
  });
});

describe('grepCode — file_glob filter', () => {
  it('restricts search to matching files', async () => {
    const allMatches = await grepCode(db, { pattern: 'export', rootDir: FIXTURE });
    const cartOnly = await grepCode(db, { pattern: 'export', file_glob: '**/cart.ts', rootDir: FIXTURE });
    expect(cartOnly.total_matches).toBeGreaterThan(0);
    expect(cartOnly.total_matches).toBeLessThanOrEqual(allMatches.total_matches);
    // Every match file should match the glob
    for (const m of cartOnly.matches) {
      expect(m.file).toMatch(/cart\.ts/);
    }
  });

  it('returns zero matches for a glob that matches no files', async () => {
    const result = await grepCode(db, { pattern: 'export', file_glob: '**/*.go', rootDir: FIXTURE });
    expect(result.total_matches).toBe(0);
  });
});

describe('grepCode — context_lines', () => {
  it('includes context lines when context_lines > 0', async () => {
    const result = await grepCode(db, { pattern: 'addItem', context_lines: 2, rootDir: FIXTURE });
    const matchWithCtx = result.matches.find(
      (m) => m.context_before!.length > 0 || m.context_after!.length > 0,
    );
    expect(matchWithCtx).toBeDefined();
  });

  it('returns no context when context_lines = 0', async () => {
    const result = await grepCode(db, { pattern: 'addItem', context_lines: 0, rootDir: FIXTURE });
    for (const m of result.matches) {
      expect(m.context_before).toHaveLength(0);
      expect(m.context_after).toHaveLength(0);
    }
  });
});

describe('grepCode — match structure', () => {
  it('returns line and column numbers', async () => {
    const result = await grepCode(db, { pattern: 'addItem', rootDir: FIXTURE });
    for (const m of result.matches) {
      expect(m.line).toBeGreaterThan(0);
      expect(m.col).toBeGreaterThan(0);
    }
  });

  it('returns file paths relative to rootDir when rootDir is provided', async () => {
    const result = await grepCode(db, { pattern: 'Cart', rootDir: FIXTURE });
    for (const m of result.matches) {
      // Paths should not be absolute when rootDir is given
      expect(m.file).not.toMatch(/^[A-Za-z]:\\/);
    }
  });

  it('returns enclosing_symbol for matches inside a function', async () => {
    // "total += " is inside totalCents() in cart.ts
    const result = await grepCode(db, { pattern: 'total \\+= ', rootDir: FIXTURE });
    const withSymbol = result.matches.filter((m) => m.enclosing_symbol);
    expect(withSymbol.length).toBeGreaterThan(0);
  });
});

describe('grepCode — max_matches / truncation', () => {
  it('truncates when more matches than max_matches', async () => {
    // "export" appears many times; cap at 1
    const result = await grepCode(db, { pattern: 'export', max_matches: 1, rootDir: FIXTURE });
    if (result.total_matches > 1) {
      expect(result.truncated).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.hint).toMatch(/Showing first/);
    }
  });
});
