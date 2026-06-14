import type Parser from 'web-tree-sitter';
import { existsSync, statSync } from 'node:fs';
import { join, resolve as pathResolve, normalize, sep } from 'node:path';
import { loadLanguage, createParser } from '../parser/runtime.js';
import type { ParseResult, ImportBinding } from '../parser/extract.js';
import type { LanguageAdapter, ResolveCtx } from './types.js';
import { makeCtx, emitSymbol, symbolFrom, textOf, walk } from './walkUtils.js';

type Node = Parser.SyntaxNode;

/**
 * Phase 13 — Python adapter. Walks the tree-sitter-python grammar and emits
 * the same `ParseResult` shape used by the TS adapter:
 *
 *  - `function_definition`        → `function` symbol
 *  - `class_definition`           → `class` symbol (becomes parent of nested methods)
 *  - `decorated_definition`       → unwraps to its `definition` child
 *  - `import_statement`           → IMPORTS edge + ImportBinding per `dotted_name`
 *  - `import_from_statement`      → IMPORTS edge + one binding per imported name
 *  - `call`                       → CALLS edge using the rightmost identifier
 *
 * Module resolution handles:
 *  - Relative dotted imports (`from .foo import bar`, `from ..pkg import x`)
 *  - Absolute dotted imports (`from foo.bar import x`) against repo root
 *  - Both `<dotted>.py` and `<dotted>/__init__.py` candidates
 */
export const PythonAdapter: LanguageAdapter = {
  id: 'python',
  extensions: ['.py', '.pyi'],
  vendorDirs: ['__pycache__', '.venv', 'venv', 'env'],
  resolveExts: ['.py', '.pyi'],
  indexFiles: ['__init__.py'],

  async loadGrammar(): Promise<Parser.Language> {
    return loadLanguage('python');
  },

  async parse(source: string, _filePath: string): Promise<ParseResult> {
    const parser = await createParser('python');
    const tree = parser.parse(source);
    if (!tree) throw new Error('tree-sitter failed to parse Python source');

    const ctx = makeCtx(source);
    walk(tree.rootNode, (node, parent) => visitPython(node, parent, ctx));
    return { language: 'python', symbols: ctx.symbols, edges: ctx.edges, imports: ctx.imports };
  },

  resolveModule(spec, fromDir, ctx) {
    return resolvePythonModule(spec, fromDir, ctx);
  },
};

function visitPython(
  node: Node,
  parent: number | null,
  ctx: ReturnType<typeof makeCtx>,
): number | null | void {
  switch (node.type) {
    case 'function_definition': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return null;
      // A method is just a function whose parent is a class.
      const kind = parentIsClass(ctx, parent) ? 'method' : 'function';
      return emitSymbol(ctx, parent, symbolFrom(nameNode, node, kind, ctx.source));
    }
    case 'class_definition': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return null;
      const classIdx = emitSymbol(ctx, parent, symbolFrom(nameNode, node, 'class', ctx.source));
      // Inheritance: `class Sub(Base, mixins.Mixin)` → EXTENDS edges
      const superclasses = node.childForFieldName('superclasses');
      if (superclasses) {
        for (let i = 0; i < superclasses.childCount; i++) {
          const c = superclasses.child(i);
          if (!c) continue;
          const id = rightmostIdentifier(c, ctx.source);
          if (id) {
            ctx.edges.push({
              sourceLocalIndex: classIdx,
              target_name: id,
              kind: 'EXTENDS',
              line: c.startPosition.row + 1,
              col: c.startPosition.column,
            });
          }
        }
      }
      return classIdx;
    }
    case 'import_statement': {
      // `import foo`, `import foo.bar`, `import foo as bar`
      collectPythonImport(node, ctx);
      return null;
    }
    case 'import_from_statement': {
      collectPythonImportFrom(node, ctx);
      return null;
    }
    case 'call': {
      const fn = node.childForFieldName('function');
      if (fn) {
        const callee = rightmostIdentifier(fn, ctx.source);
        if (callee) {
          ctx.edges.push({
            sourceLocalIndex: parent,
            target_name: callee,
            kind: 'CALLS',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
          });
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function parentIsClass(
  ctx: ReturnType<typeof makeCtx>,
  parentLocalIndex: number | null,
): boolean {
  if (parentLocalIndex === null) return false;
  return ctx.symbols[parentLocalIndex]?.kind === 'class';
}

/** Walk a dotted-name / attribute / identifier chain and return the rightmost id. */
function rightmostIdentifier(node: Node, source: string): string | null {
  if (node.type === 'identifier') return textOf(node, source);
  if (node.type === 'attribute') {
    const attr = node.childForFieldName('attribute');
    if (attr) return textOf(attr, source);
  }
  if (node.type === 'dotted_name') {
    // Last identifier wins.
    for (let i = node.childCount - 1; i >= 0; i--) {
      const c = node.child(i);
      if (c && c.type === 'identifier') return textOf(c, source);
    }
  }
  for (let i = node.childCount - 1; i >= 0; i--) {
    const c = node.child(i);
    if (c && c.type === 'identifier') return textOf(c, source);
  }
  return null;
}

/** Return the full dotted text of a `dotted_name` node (e.g. `foo.bar.baz`). */
function dottedText(node: Node, source: string): string {
  return textOf(node, source).replace(/\s+/g, '');
}

function pushImportArtifacts(
  ctx: ReturnType<typeof makeCtx>,
  moduleSpec: string,
  bindings: readonly Omit<ImportBinding, 'moduleSpecifier' | 'line' | 'col'>[],
  line: number,
  col: number,
): void {
  // Synthetic 'import' symbol mirroring the TS walker's behavior — this is
  // what `find_references` on a module path keys off.
  ctx.symbols.push({
    name: moduleSpec,
    kind: 'import',
    start_line: line,
    end_line: line,
    start_col: col,
    end_col: col + moduleSpec.length,
    localIndex: ctx.symbols.length,
    parentLocalIndex: null,
  });
  ctx.edges.push({
    sourceLocalIndex: null,
    target_name: moduleSpec,
    kind: 'IMPORTS',
    line,
    col,
  });
  for (const b of bindings) {
    ctx.imports.push({
      localName: b.localName,
      importedName: b.importedName,
      moduleSpecifier: moduleSpec,
      line,
      col,
    });
  }
}

function collectPythonImport(node: Node, ctx: ReturnType<typeof makeCtx>): void {
  const line = node.startPosition.row + 1;
  const col = node.startPosition.column;
  // Children: `import` keyword, then one or more dotted_name / aliased_import
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'dotted_name') {
      const mod = dottedText(c, ctx.source);
      // `import foo.bar` introduces local name `foo` bound to the whole chain.
      const local = mod.split('.', 1)[0]!;
      pushImportArtifacts(ctx, mod, [{ localName: local, importedName: '*' }], line, col);
    } else if (c.type === 'aliased_import') {
      const name = c.childForFieldName('name');
      const alias = c.childForFieldName('alias');
      if (!name) continue;
      const mod = dottedText(name, ctx.source);
      const localName = alias ? textOf(alias, ctx.source) : (mod.split('.', 1)[0] ?? mod);
      pushImportArtifacts(ctx, mod, [{ localName, importedName: '*' }], line, col);
    }
  }
}

function collectPythonImportFrom(node: Node, ctx: ReturnType<typeof makeCtx>): void {
  const line = node.startPosition.row + 1;
  const col = node.startPosition.column;
  const moduleNode = node.childForFieldName('module_name');

  // Count leading dots for relative imports: `from . import x` / `from ..pkg import x`
  let dots = 0;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'import_prefix') {
      dots += textOf(c, ctx.source).length;
    } else if (c.type === '.' || c.text === '.') {
      dots++;
    }
  }

  let modulePath = '';
  if (moduleNode) modulePath = dottedText(moduleNode, ctx.source);
  const moduleSpec = `${'.'.repeat(dots)}${modulePath}` || '.';

  const bindings: Omit<ImportBinding, 'moduleSpecifier' | 'line' | 'col'>[] = [];

  // The names being imported are at named children after the `import` keyword.
  // We accept both bare `dotted_name` and `aliased_import` forms; `*` is a
  // wildcard_import node.
  let sawImportKeyword = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (!sawImportKeyword) {
      if (c.type === 'import' || c.text === 'import') sawImportKeyword = true;
      continue;
    }
    if (c.type === 'dotted_name') {
      const name = textOf(c, ctx.source);
      bindings.push({ localName: name, importedName: name });
    } else if (c.type === 'aliased_import') {
      const name = c.childForFieldName('name');
      const alias = c.childForFieldName('alias');
      if (!name) continue;
      const imported = textOf(name, ctx.source);
      const local = alias ? textOf(alias, ctx.source) : imported;
      bindings.push({ localName: local, importedName: imported });
    } else if (c.type === 'wildcard_import' || c.text === '*') {
      bindings.push({ localName: '*', importedName: '*' });
    }
  }

  pushImportArtifacts(ctx, moduleSpec, bindings, line, col);
}

/**
 * Resolve a Python module specifier to a repo-relative path.
 *
 * Strategy:
 *  1. Count leading dots → walk up that many parents from `fromDir`.
 *  2. Convert remaining dotted segments to path segments.
 *  3. Probe `<path>.py` then `<path>/__init__.py` in `filesByPath`.
 *
 * Bare absolute imports (`from numpy import ...`) almost never resolve to a
 * file inside the repo and intentionally return null.
 */
function resolvePythonModule(
  spec: string,
  fromDir: string,
  ctx: ResolveCtx,
): string | null {
  let leadingDots = 0;
  while (leadingDots < spec.length && spec[leadingDots] === '.') leadingDots++;
  const dotted = spec.slice(leadingDots);

  let baseDir: string;
  if (leadingDots === 0) {
    // Absolute import — search from repo root.
    baseDir = '';
  } else {
    // `from .` → same dir; `from ..` → up one; etc.
    const parts = fromDir === '' || fromDir === '.' ? [] : fromDir.split('/');
    const ups = leadingDots - 1;
    if (ups > parts.length) return null;
    baseDir = parts.slice(0, parts.length - ups).join('/');
  }

  const segments = dotted ? dotted.split('.') : [];
  const joined = segments.length === 0 ? baseDir : (baseDir ? baseDir + '/' : '') + segments.join('/');

  // Probe <joined>.py and <joined>/__init__.py
  const candidates = [`${joined}.py`, `${joined}/__init__.py`, `${joined}.pyi`];
  for (const c of candidates) {
    const key = normRel(c);
    if (ctx.filesByPath.has(key)) return key;
  }
  // Fallback: if `joined` itself is a directory containing python files,
  // also try the bare `__init__.py` (e.g. `from . import foo` → check parent).
  const absJoined = pathResolve(ctx.root, joined);
  if (isDir(absJoined)) {
    const k = normRel(`${joined}/__init__.py`);
    if (ctx.filesByPath.has(k)) return k;
  }
  return null;
}

function normRel(p: string): string {
  return normalize(p).split(sep).join('/').replace(/\/$/, '');
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Re-export `join` for tests if needed.
export const _internal = { join };
