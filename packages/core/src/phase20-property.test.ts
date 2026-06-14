/**
 * Phase 20.2 + 20.3 — Property tests.
 *
 * 20.2: Fuzz-test the AST walker by generating random valid-ish source files
 *       and asserting the parser never crashes.
 * 20.3: Determinism & idempotency:
 *       - parse(file) produces identical output on repeated calls
 *       - resolver is idempotent (running twice = same edges)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDatabase,
  indexRepo,
  resolveReferences,
} from '@synapse/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'fixtures', 'sample-shopping-app');

// ─── Arbitraries for generating TypeScript-like code ──────────────────────

/** Generate a valid identifier (lowercase letters only for simplicity). */
const tsIdent = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9]{0,14}$/);

/** Generate a simple TS function. */
const tsFunction = fc.tuple(tsIdent, tsIdent, fc.boolean()).map(
  ([name, param, isExport]) =>
    `${isExport ? 'export ' : ''}function ${name}(${param}: string): void {\n  console.log(${param});\n}\n`,
);

/** Generate a simple TS class. */
const tsClass = fc.tuple(tsIdent, tsIdent, tsIdent).map(
  ([cls, method, prop]) =>
    `export class ${cls} {\n  ${prop} = 0;\n  ${method}(): void { this.${prop}++; }\n}\n`,
);

/** Generate a TS interface. */
const tsInterface = fc.tuple(tsIdent, tsIdent, tsIdent).map(
  ([name, p1, p2]) =>
    `export interface ${name} {\n  ${p1}: string;\n  ${p2}: number;\n}\n`,
);

/** Generate an import statement. */
const tsImport = fc.tuple(tsIdent, tsIdent).map(
  ([name, mod]) => `import { ${name} } from './${mod}.js';\n`,
);

/** Generate a complete TS file with random constructs. */
const tsFile = fc.tuple(
  fc.array(tsImport, { minLength: 0, maxLength: 3 }),
  fc.array(fc.oneof(tsFunction, tsClass, tsInterface), { minLength: 1, maxLength: 5 }),
).map(([imports, decls]) => imports.join('') + '\n' + decls.join('\n'));

/** Generate a Python function. */
const pyFunction = fc.tuple(tsIdent, tsIdent, fc.boolean()).map(
  ([name, param, hasDoc]) =>
    `def ${name}(${param}):\n${hasDoc ? `    """Docstring."""\n` : ''}    return ${param}\n`,
);

/** Generate a Python class. */
const pyClass = fc.tuple(tsIdent, tsIdent).map(
  ([cls, method]) =>
    `class ${cls}:\n    def ${method}(self):\n        pass\n`,
);

const pyFile = fc.array(fc.oneof(pyFunction, pyClass), { minLength: 1, maxLength: 5 })
  .map((decls) => decls.join('\n'));

// ─── 20.2: Parser fuzz (never crashes) ────────────────────────────────────

describe('Phase 20.2 — Parser fuzz: never crashes on valid-ish source', () => {
  let dbDir: string;

  beforeAll(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-fuzz-'));
  });

  afterAll(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('indexes randomly generated TypeScript files without crashing', async () => {
    await fc.assert(
      fc.asyncProperty(tsFile, async (source) => {
        const tmpRoot = mkdtempSync(join(dbDir, 'ts-'));
        const srcDir = join(tmpRoot, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(join(srcDir, 'fuzz.ts'), source);

        const dbPath = join(tmpRoot, 'graph.db');
        const db = openDatabase({ path: dbPath });
        try {
          // Must not throw.
          const summary = await indexRepo(db, { root: tmpRoot, concurrency: 1, skipResolve: true });
          expect(summary.filesDiscovered).toBeGreaterThanOrEqual(0);
          // Symbols can be 0 if parse fails gracefully, but no crash.
        } finally {
          db.close();
        }
      }),
      { numRuns: 20, seed: 42 },
    );
  });

  it('indexes randomly generated Python files without crashing', async () => {
    await fc.assert(
      fc.asyncProperty(pyFile, async (source) => {
        const tmpRoot = mkdtempSync(join(dbDir, 'py-'));
        const srcDir = join(tmpRoot, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(join(srcDir, 'fuzz.py'), source);

        const dbPath = join(tmpRoot, 'graph.db');
        const db = openDatabase({ path: dbPath });
        try {
          const summary = await indexRepo(db, { root: tmpRoot, concurrency: 1, skipResolve: true });
          expect(summary.filesDiscovered).toBeGreaterThanOrEqual(0);
        } finally {
          db.close();
        }
      }),
      { numRuns: 20, seed: 42 },
    );
  });

  it('handles malformed/truncated source gracefully', async () => {
    // Edge cases: empty file, only whitespace, unclosed braces, etc.
    const edgeCases = [
      '',
      '   \n\n  ',
      'function (',
      'class { method() {',
      'export interface { }',
      'import { } from',
      '////',
      '/* unclosed comment',
      'const x: = ;',
      'export default function() { throw',
      'def f(:\n  pass',
      'class:\n  def',
    ];
    for (const src of edgeCases) {
      const tmpRoot = mkdtempSync(join(dbDir, 'edge-'));
      const srcDir = join(tmpRoot, 'src');
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'edge.ts'), src);

      const dbPath = join(tmpRoot, 'graph.db');
      const db = openDatabase({ path: dbPath });
      try {
        // Must not throw.
        await indexRepo(db, { root: tmpRoot, concurrency: 1, skipResolve: true });
      } finally {
        db.close();
      }
    }
  });
});

// ─── 20.3: Determinism & Idempotency ─────────────────────────────────────

describe('Phase 20.3 — Determinism: parse produces identical output on repeated calls', () => {
  it('indexing the same repo twice produces identical symbol sets', async () => {
    const run = async () => {
      const d = mkdtempSync(join(tmpdir(), 'cg-det-'));
      const db = openDatabase({ path: join(d, 'graph.db') });
      await indexRepo(db, { root: FIXTURE, concurrency: 1 });
      const symbols = db.prepare(
        'SELECT name, kind, start_line, end_line FROM symbols ORDER BY name, kind, start_line',
      ).all();
      db.close();
      rmSync(d, { recursive: true, force: true });
      return symbols;
    };

    const [run1, run2] = await Promise.all([run(), run()]);
    expect(run1).toEqual(run2);
  });

  it('indexing is deterministic across different concurrency levels', async () => {
    const runWith = async (concurrency: number) => {
      const d = mkdtempSync(join(tmpdir(), 'cg-conc-'));
      const db = openDatabase({ path: join(d, 'graph.db') });
      await indexRepo(db, { root: FIXTURE, concurrency });
      const symbols = db.prepare(
        'SELECT name, kind, start_line, end_line FROM symbols ORDER BY name, kind, start_line',
      ).all();
      db.close();
      rmSync(d, { recursive: true, force: true });
      return symbols;
    };

    const [c1, c4] = await Promise.all([runWith(1), runWith(4)]);
    expect(c1).toEqual(c4);
  });
});

describe('Phase 20.3 — Idempotency: resolver produces same edges when run twice', () => {
  it('resolveReferences is idempotent', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cg-idem-'));
    const db = openDatabase({ path: join(d, 'graph.db') });
    await indexRepo(db, { root: FIXTURE, concurrency: 2 });

    resolveReferences(db, { root: FIXTURE });
    const edges1 = db.prepare(
      'SELECT source_id, target_id, target_name, kind FROM edges ORDER BY source_id, target_name, kind',
    ).all();

    // Run resolver again — should not change edges.
    resolveReferences(db, { root: FIXTURE });
    const edges2 = db.prepare(
      'SELECT source_id, target_id, target_name, kind FROM edges ORDER BY source_id, target_name, kind',
    ).all();

    expect(edges1).toEqual(edges2);

    db.close();
    rmSync(d, { recursive: true, force: true });
  });

  it('re-indexing unchanged files produces identical symbol counts', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cg-reidx-'));
    const db = openDatabase({ path: join(d, 'graph.db') });

    const sum1 = await indexRepo(db, { root: FIXTURE, concurrency: 2 });
    const sym1 = db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number };

    // Index again (skipUnchanged is default behavior).
    const sum2 = await indexRepo(db, { root: FIXTURE, concurrency: 2 });
    const sym2 = db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number };

    expect(sym1.c).toBe(sym2.c);
    // Second run produces same discovery count.
    expect(sum2.filesDiscovered).toBe(sum1.filesDiscovered);

    db.close();
    rmSync(d, { recursive: true, force: true });
  });
});
