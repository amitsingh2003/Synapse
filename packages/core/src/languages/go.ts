import type Parser from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { loadLanguage, createParser } from '../parser/runtime.js';
import type { ParseResult, ImportBinding } from '../parser/extract.js';
import type { LanguageAdapter, ResolveCtx } from './types.js';
import { makeCtx, emitSymbol, symbolFrom, textOf, walk } from './walkUtils.js';

type Node = Parser.SyntaxNode;

/**
 * Phase 13 — Go adapter. Walks the tree-sitter-go grammar:
 *
 *  - `function_declaration`  → `function`
 *  - `method_declaration`    → `method`
 *  - `type_declaration`      → one symbol per `type_spec`; struct/interface
 *    are tagged accordingly (`struct` / `interface`), everything else is
 *    `type`.
 *  - `import_declaration`    → IMPORTS edge + ImportBinding per import_spec
 *  - `call_expression`       → CALLS edge using the rightmost identifier
 *
 * Module resolution parses `go.mod` once per repo to learn the module path,
 * then maps `import "github.com/org/repo/internal/pkg"` to any `.go` file
 * found under `<root>/internal/pkg/`.
 */
export const GoAdapter: LanguageAdapter = {
  id: 'go',
  extensions: ['.go'],
  vendorDirs: ['vendor'],
  resolveExts: ['.go'],
  indexFiles: [],

  async loadGrammar(): Promise<Parser.Language> {
    return loadLanguage('go');
  },

  async parse(source: string, _filePath: string): Promise<ParseResult> {
    const parser = await createParser('go');
    const tree = parser.parse(source);
    if (!tree) throw new Error('tree-sitter failed to parse Go source');

    const ctx = makeCtx(source);
    walk(tree.rootNode, (node, parent) => visitGo(node, parent, ctx));
    return { language: 'go', symbols: ctx.symbols, edges: ctx.edges, imports: ctx.imports };
  },

  resolveModule(spec, fromDir, ctx) {
    return resolveGoModule(spec, fromDir, ctx);
  },
};

function visitGo(
  node: Node,
  parent: number | null,
  ctx: ReturnType<typeof makeCtx>,
): number | null | void {
  switch (node.type) {
    case 'function_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) emitSymbol(ctx, parent, symbolFrom(nameNode, node, 'function', ctx.source));
      return null;
    }
    case 'method_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) emitSymbol(ctx, parent, symbolFrom(nameNode, node, 'method', ctx.source));
      return null;
    }
    case 'type_declaration': {
      // type_declaration → ( type_spec | type_alias )+   (possibly inside parens)
      for (let i = 0; i < node.childCount; i++) {
        const spec = node.child(i);
        if (!spec) continue;
        if (spec.type !== 'type_spec' && spec.type !== 'type_alias') continue;
        const nameNode = spec.childForFieldName('name');
        if (!nameNode) continue;
        const typeNode = spec.childForFieldName('type');
        const kind: 'struct' | 'interface' | 'type' =
          typeNode?.type === 'struct_type'
            ? 'struct'
            : typeNode?.type === 'interface_type'
              ? 'interface'
              : 'type';
        emitSymbol(ctx, parent, symbolFrom(nameNode, spec, kind, ctx.source));
      }
      return null;
    }
    case 'import_declaration': {
      collectGoImports(node, ctx);
      return null;
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn) {
        const callee = rightmostGoIdentifier(fn, ctx.source);
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

function rightmostGoIdentifier(node: Node, source: string): string | null {
  if (node.type === 'identifier' || node.type === 'field_identifier') {
    return textOf(node, source);
  }
  if (node.type === 'selector_expression') {
    const field = node.childForFieldName('field');
    if (field) return textOf(field, source);
  }
  for (let i = node.childCount - 1; i >= 0; i--) {
    const c = node.child(i);
    if (c && (c.type === 'identifier' || c.type === 'field_identifier')) {
      return textOf(c, source);
    }
  }
  return null;
}

function collectGoImports(node: Node, ctx: ReturnType<typeof makeCtx>): void {
  // import_declaration → "import" ( import_spec | import_spec_list )
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'import_spec') {
      pushGoImportSpec(c, ctx);
    } else if (c.type === 'import_spec_list') {
      for (let j = 0; j < c.childCount; j++) {
        const s = c.child(j);
        if (s && s.type === 'import_spec') pushGoImportSpec(s, ctx);
      }
    }
  }
}

function pushGoImportSpec(spec: Node, ctx: ReturnType<typeof makeCtx>): void {
  const pathNode = spec.childForFieldName('path');
  if (!pathNode) return;
  const raw = textOf(pathNode, ctx.source);
  const mod = raw.replace(/^["`]|["`]$/g, '');
  const line = spec.startPosition.row + 1;
  const col = spec.startPosition.column;

  const aliasNode = spec.childForFieldName('name');
  // The local name defaults to the basename of the import path.
  const baseName = mod.split('/').pop() ?? mod;
  const localName = aliasNode ? textOf(aliasNode, ctx.source) : baseName;

  ctx.symbols.push({
    name: mod,
    kind: 'import',
    start_line: line,
    end_line: line,
    start_col: col,
    end_col: col + mod.length,
    localIndex: ctx.symbols.length,
    parentLocalIndex: null,
  });
  ctx.edges.push({
    sourceLocalIndex: null,
    target_name: mod,
    kind: 'IMPORTS',
    line,
    col,
  });
  const binding: ImportBinding = {
    localName,
    importedName: '*',
    moduleSpecifier: mod,
    line,
    col,
  };
  ctx.imports.push(binding);
}

/**
 * Resolve a Go import path to a `.go` file in the repo. We learn the
 * module's own path from `go.mod`; imports prefixed with that path map to
 * a directory under the repo, and we pick the first `.go` file in it
 * (Go has no per-file imports — any file in the package is fine for
 * cross-file linking).
 */
function resolveGoModule(spec: string, _fromDir: string, ctx: ResolveCtx): string | null {
  const modulePath = getGoModulePath(ctx.root);
  if (!modulePath) return null;
  if (spec !== modulePath && !spec.startsWith(`${modulePath}/`)) return null;
  const subPath = spec === modulePath ? '' : spec.slice(modulePath.length + 1);
  // Prefer files we've already indexed.
  const prefix = subPath ? `${subPath}/` : '';
  let firstMatch: string | null = null;
  for (const key of ctx.filesByPath.keys()) {
    if (!key.endsWith('.go')) continue;
    if (key === `${subPath}.go`) return key;
    if (!key.startsWith(prefix)) continue;
    // Pick a file directly inside the target package directory (no nested /).
    const rest = key.slice(prefix.length);
    if (rest.includes('/')) continue;
    // Prefer a non-test file; remember the first hit either way.
    if (!rest.endsWith('_test.go')) return key;
    if (firstMatch === null) firstMatch = key;
  }
  return firstMatch;
}

// --- go.mod cache --------------------------------------------------------

const goModCache = new Map<string, string | null>();

function getGoModulePath(root: string): string | null {
  if (goModCache.has(root)) return goModCache.get(root) ?? null;
  let content: string;
  try {
    content = readFileSync(join(root, 'go.mod'), 'utf8');
  } catch {
    goModCache.set(root, null);
    return null;
  }
  const m = /^module\s+(\S+)/m.exec(content);
  const path = m ? m[1]!.trim() : null;
  goModCache.set(root, path);
  return path;
}

/** Test hook — clears the per-root go.mod cache. */
export function _clearGoModuleCache(): void {
  goModCache.clear();
}

// Re-export `posix` so callers can normalise their own paths consistently
// when they cross the adapter boundary in tests.
export const _internal = { posix };
