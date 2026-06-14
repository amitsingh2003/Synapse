import type Parser from 'web-tree-sitter';
import type { NewEdge, NewSymbol, SymbolKind } from '../db/queries.js';
import type { Language, SubLanguage } from './language.js';
import { createParser } from './runtime.js';

type SyntaxNode = Parser.SyntaxNode;
type Tree = Parser.Tree;
// Internal alias to keep the AST-walking code below readable.
type Node = SyntaxNode;

export interface ExtractedSymbol extends NewSymbol {
  /** Stable index within the file — used to wire up parent/child relationships
   *  before rows are inserted. */
  localIndex: number;
  parentLocalIndex: number | null;
}

export interface ExtractedEdge extends Omit<NewEdge, 'source_id'> {
  /** Local-index of the caller symbol in this file (null if at file top-level). */
  sourceLocalIndex: number | null;
}

/**
 * One binding pulled out of an `import` statement.
 *
 * `localName` is the identifier visible inside this file (alias if present).
 * `importedName` is the symbol exported by the target module. `default` for
 * default imports, `*` for namespace imports.
 */
export interface ImportBinding {
  localName: string;
  importedName: string;
  moduleSpecifier: string;
  /** Phase 14: 'type' for `import type` / `export type from`, else 'value'. */
  kind?: 'value' | 'type';
  line: number;
  col: number;
}

export interface ParseResult {
  language: Language;
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  imports: ImportBinding[];
}

/** Parse a single source file and extract symbols + edges (Phase 1 set). */
export async function parseSource(source: string, language: SubLanguage): Promise<ParseResult> {
  const parser = await createParser(language);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${language} source`);

  const symbols: ExtractedSymbol[] = [];
  const edges: ExtractedEdge[] = [];
  const imports: ImportBinding[] = [];

  walk(tree.rootNode, {
    parentIndex: null,
    symbols,
    edges,
    imports,
    source,
  });

  return { language, symbols, edges, imports };
}

interface WalkCtx {
  parentIndex: number | null;
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  imports: ImportBinding[];
  source: string;
}

/**
 * Iteratively walk the tree-sitter AST and emit symbols/edges for the node
 * types we care about. An explicit stack keeps deep ASTs (giant generated
 * files) from blowing Node's call stack.
 *
 * Phase 16.6 — converted from recursive to iterative; behaviour is preserved
 * by pushing children in reverse so they pop in declaration order, and by
 * mutating `ctx.parentIndex` per frame.
 */
function walk(root: Node, ctx: WalkCtx): void {
  type Frame = { node: Node; parentIndex: number | null };
  const stack: Frame[] = [{ node: root, parentIndex: ctx.parentIndex }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    ctx.parentIndex = frame.parentIndex;
    const node = frame.node;
    let nextParent = frame.parentIndex;
    const emit = (sym: NewSymbol): number => {
      const localIndex = ctx.symbols.length;
      ctx.symbols.push({ ...sym, localIndex, parentLocalIndex: ctx.parentIndex });
      return localIndex;
    };

  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) nextParent = emit(symbolFrom(nameNode, node, 'function', ctx));
      break;
    }
    case 'class_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        nextParent = emit(symbolFrom(nameNode, node, 'class', ctx));
        emitExtendsImplements(node, nameNode, ctx, nextParent);
        emitDecorators(node, ctx, nextParent);
      }
      break;
    }
    case 'interface_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) nextParent = emit(symbolFrom(nameNode, node, 'interface', ctx));
      break;
    }
    case 'type_alias_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) emit(symbolFrom(nameNode, node, 'type', ctx));
      break;
    }
    case 'enum_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) emit(symbolFrom(nameNode, node, 'enum', ctx));
      break;
    }
    case 'method_definition':
    case 'method_signature': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        nextParent = emit(symbolFrom(nameNode, node, 'method', ctx));
        emitDecorators(node, ctx, nextParent);
      }
      break;
    }
    case 'lexical_declaration':
    case 'variable_declaration':
      // Children (variable_declarator) are pushed below and handled by their own case.
      break;
    case 'variable_declarator': {
      // Phase 14.6 — surface `const fn = () => {}` and `const fn = function() {}`
      // as `function` symbols so callers can be linked. Setting nextParent ensures
      // that call_expression nodes inside the arrow/function body get the correct
      // sourceLocalIndex instead of null.
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (
        nameNode &&
        valueNode &&
        nameNode.type === 'identifier' &&
        (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')
      ) {
        nextParent = emit(symbolFrom(nameNode, node, 'function', ctx));
      }
      break;
    }
    case 'export_statement': {
      // Phase 14.5 — re-exports: `export * from 'x'`, `export { y } from 'x'`,
      // including the `export type … from` variant.
      collectReexport(node, ctx);
      // Continue walking children so a wrapped `export const fn = () => {}`
      // still emits its symbol via the lexical_declaration case.
      break;
    }
    case 'import_statement': {
      // Record the imported source path as a synthetic "import" symbol.
      const sourceNode = node.childForFieldName('source');
      if (sourceNode) {
        const raw = textOf(sourceNode, ctx.source);
        const trimmed = raw.replace(/^['"`]|['"`]$/g, '');
        ctx.symbols.push({
          name: trimmed,
          kind: 'import',
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          start_col: node.startPosition.column,
          end_col: node.endPosition.column,
          localIndex: ctx.symbols.length,
          parentLocalIndex: null,
        });
        ctx.edges.push({
          sourceLocalIndex: null,
          target_name: trimmed,
          kind: 'IMPORTS',
          line: node.startPosition.row + 1,
          col: node.startPosition.column,
        });
        collectImportBindings(node, trimmed, ctx);
      }
      break;
    }
    case 'call_expression': {
      const fnNode = node.childForFieldName('function');
      if (fnNode) {
        // Phase 14.4 — dynamic import('x') and require('x') become IMPORTS.
        if (tryEmitDynamicImport(node, fnNode, ctx)) break;
        const calleeName = lastIdentifier(fnNode, ctx.source);
        if (calleeName) {
          ctx.edges.push({
            sourceLocalIndex: ctx.parentIndex,
            target_name: calleeName,
            kind: 'CALLS',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
          });
        }
      }
      break;
    }
    case 'jsx_opening_element':
    case 'jsx_self_closing_element': {
      // Phase 14.8 — `<MyComp .../>` references MyComp. Lowercase tags are
      // intrinsic HTML and skipped.
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const tag = lastIdentifier(nameNode, ctx.source) ?? textOf(nameNode, ctx.source);
        if (tag && /^[A-Z]/.test(tag)) {
          ctx.edges.push({
            sourceLocalIndex: ctx.parentIndex,
            target_name: tag,
            kind: 'REFERENCES',
            line: node.startPosition.row + 1,
            col: node.startPosition.column,
          });
        }
      }
      break;
    }
    default:
      break;
  }

    // Push children in REVERSE so they pop in declaration order, preserving
    // the visitation order of the previous recursive implementation.
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push({ node: child, parentIndex: nextParent });
    }
  } // end while
}

function emitExtendsImplements(
  classNode: Node,
  _nameNode: Node,
  ctx: WalkCtx,
  classLocalIndex: number,
): void {
  const heritage = classNode.descendantsOfType?.('class_heritage') ?? [];
  for (const h of heritage) {
    for (let i = 0; i < h.childCount; i++) {
      const c = h.child(i);
      if (!c) continue;
      if (c.type === 'extends_clause') {
        for (const id of identifiersIn(c, ctx.source)) {
          ctx.edges.push({
            sourceLocalIndex: classLocalIndex,
            target_name: id,
            kind: 'EXTENDS',
            line: c.startPosition.row + 1,
            col: c.startPosition.column,
          });
        }
      } else if (c.type === 'implements_clause') {
        for (const id of identifiersIn(c, ctx.source)) {
          ctx.edges.push({
            sourceLocalIndex: classLocalIndex,
            target_name: id,
            kind: 'IMPLEMENTS',
            line: c.startPosition.row + 1,
            col: c.startPosition.column,
          });
        }
      }
    }
  }
}

function symbolFrom(
  nameNode: Node,
  fullNode: Node,
  kind: SymbolKind,
  ctx: WalkCtx,
): NewSymbol {
  const sig = signatureOf(fullNode, ctx.source);
  const doc = extractJSDoc(fullNode, ctx.source);
  return {
    name: textOf(nameNode, ctx.source),
    kind,
    start_line: fullNode.startPosition.row + 1,
    end_line: fullNode.endPosition.row + 1,
    start_col: fullNode.startPosition.column,
    end_col: fullNode.endPosition.column,
    signature: sig,
    doc,
  };
}

/**
 * Phase 14.9 — grab the JSDoc/TSDoc block immediately preceding `node`
 * (`/** … *\/`). Returns `null` if there isn't one. Tree-sitter typically
 * attaches the comment as a previous-named-sibling on the enclosing
 * statement, so we walk up one level when the node itself has no preceding
 * comment.
 */
function extractJSDoc(node: Node, source: string): string | null {
  const findComment = (n: Node | null): string | null => {
    if (!n) return null;
    const prev = n.previousNamedSibling;
    if (!prev) return null;
    if (prev.type !== 'comment') return null;
    const text = source.slice(prev.startIndex, prev.endIndex);
    if (!text.startsWith('/**')) return null;
    return text;
  };
  const direct = findComment(node);
  if (direct) return cleanJSDoc(direct);
  const wrapped = findComment(node.parent);
  return wrapped ? cleanJSDoc(wrapped) : null;
}

function cleanJSDoc(raw: string): string {
  const inner = raw.replace(/^\/\*\*?/, '').replace(/\*\/$/, '');
  const lines = inner
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
    .filter((l, i, arr) => !(i === 0 && l === '') && !(i === arr.length - 1 && l === ''));
  return lines.join('\n').trim();
}

function textOf(node: Node, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

/** First line of the declaration, trimmed — good enough as a Phase 1 signature. */
function signatureOf(node: Node, source: string): string {
  const slice = source.slice(node.startIndex, node.endIndex);
  const firstLine = slice.split('\n', 1)[0] ?? '';
  return firstLine.trim().slice(0, 200);
}

/** Walk down a member-expression chain to get the final identifier ("cart.addItem" → "addItem"). */
function lastIdentifier(node: Node, source: string): string | null {
  if (node.type === 'identifier' || node.type === 'property_identifier') {
    return textOf(node, source);
  }
  if (node.type === 'member_expression') {
    const prop = node.childForFieldName('property');
    if (prop) return textOf(prop, source);
  }
  // Fallback: scan children for the rightmost identifier.
  for (let i = node.childCount - 1; i >= 0; i--) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'identifier' || c.type === 'property_identifier') return textOf(c, source);
  }
  return null;
}

function identifiersIn(node: Node, source: string): string[] {
  const out: string[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'identifier' || n.type === 'type_identifier') {
      out.push(textOf(n, source));
      return;
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
    }
  };
  visit(node);
  return out;
}

/**
 * Walk an `import_statement` node and emit one ImportBinding per imported name.
 *
 * Handles the three shapes:
 *   - default: `import Foo from 'mod'`           → local=Foo  imported=default
 *   - namespace: `import * as Ns from 'mod'`     → local=Ns   imported=*
 *   - named: `import { A, B as Cee } from 'mod'` → local=A/Cee imported=A/B
 *
 * Side-effect-free imports (`import 'mod'`) yield no bindings — only the
 * IMPORTS edge. Phase 14.10: `import type {…}` and `import { type X }`
 * are tagged with `kind: 'type'`.
 */
function collectImportBindings(node: Node, moduleSpecifier: string, ctx: WalkCtx): void {
  const line = node.startPosition.row + 1;
  const col = node.startPosition.column;
  // Whole-statement type marker: `import type { ... } from 'x'`.
  const stmtIsType = hasTypeKeyword(node, ctx.source);
  const push = (localName: string, importedName: string, isType = false): void => {
    ctx.imports.push({
      localName,
      importedName,
      moduleSpecifier,
      kind: stmtIsType || isType ? 'type' : 'value',
      line,
      col,
    });
  };

  // tree-sitter-typescript shape: import_statement → import_clause → (identifier | named_imports | namespace_import)
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type !== 'import_clause') continue;
    for (let j = 0; j < c.childCount; j++) {
      const part = c.child(j);
      if (!part) continue;
      if (part.type === 'identifier') {
        push(textOf(part, ctx.source), 'default');
      } else if (part.type === 'namespace_import') {
        // namespace_import → '*' 'as' identifier
        for (let k = 0; k < part.childCount; k++) {
          const id = part.child(k);
          if (id && id.type === 'identifier') {
            push(textOf(id, ctx.source), '*');
            break;
          }
        }
      } else if (part.type === 'named_imports') {
        for (let k = 0; k < part.childCount; k++) {
          const spec = part.child(k);
          if (!spec || spec.type !== 'import_specifier') continue;
          const nameNode = spec.childForFieldName('name');
          const aliasNode = spec.childForFieldName('alias');
          if (!nameNode) continue;
          const imported = textOf(nameNode, ctx.source);
          const local = aliasNode ? textOf(aliasNode, ctx.source) : imported;
          // `import { type X }` — per-specifier type marker.
          const specIsType = hasTypeKeyword(spec, ctx.source);
          push(local, imported, specIsType);
        }
      }
    }
  }
}

// ===========================================================================
// Phase 14 helpers
// ===========================================================================

/**
 * Detect a `type` keyword child (case-sensitive). Used for `import type`,
 * `export type`, and per-specifier `import { type X }`.
 */
function hasTypeKeyword(node: Node, source: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'type') return true;
    // Some grammars expose it as an anonymous keyword node.
    if (!c.isNamed && source.slice(c.startIndex, c.endIndex) === 'type') return true;
  }
  return false;
}

/**
 * Phase 14.6 — emit a `function` symbol when a `const`/`let` binds an arrow
 * function or function expression. Skips bindings that don't look callable.
 */
function emitArrowFunctionConsts(
  node: Node,
  ctx: WalkCtx,
  emit: (sym: NewSymbol) => number,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const decl = node.child(i);
    if (!decl) continue;
    if (decl.type !== 'variable_declarator') continue;
    const nameNode = decl.childForFieldName('name');
    const valueNode = decl.childForFieldName('value');
    if (!nameNode || !valueNode) continue;
    if (nameNode.type !== 'identifier') continue;
    if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression') continue;
    emit(symbolFrom(nameNode, decl, 'function', ctx));
  }
}

/**
 * Phase 14.7 — emit REFERENCES edges from a class/method to each `@decorator`.
 * Tree-sitter exposes decorators as previous-named-siblings of the decorated
 * node (and sometimes as children of an enclosing `export_statement`).
 */
function emitDecorators(node: Node, ctx: WalkCtx, targetIdx: number): void {
  const seen = new Set<Node>();
  // 1) Decorators as direct children of the decorated node (most grammars).
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === 'decorator') seen.add(c);
  }
  // 2) Decorators as previous-named-siblings (the older typescript grammar
  //    sometimes detaches them onto the enclosing block).
  const scan = (start: Node | null): void => {
    let cur: Node | null = start;
    while (cur) {
      if (cur.type !== 'decorator') break;
      seen.add(cur);
      cur = cur.previousNamedSibling;
    }
  };
  scan(node.previousNamedSibling);
  // 3) Decorators alongside an `export class` wrapper.
  if (node.parent) {
    for (let i = 0; i < node.parent.childCount; i++) {
      const c = node.parent.child(i);
      if (c && c.type === 'decorator') seen.add(c);
    }
  }
  for (const dec of seen) {
    const name = decoratorName(dec, ctx.source);
    if (!name) continue;
    ctx.edges.push({
      sourceLocalIndex: targetIdx,
      target_name: name,
      kind: 'REFERENCES',
      line: dec.startPosition.row + 1,
      col: dec.startPosition.column,
    });
  }
}

/**
 * Extract the decorator name from a `decorator` node. Handles `@Foo`,
 * `@Foo(...)`, and `@ns.Foo(...)` shapes by drilling through call_expression
 * and member_expression wrappers.
 */
function decoratorName(dec: Node, source: string): string | null {
  // The decorator's first named child is the expression after `@`.
  for (let i = 0; i < dec.childCount; i++) {
    const c = dec.child(i);
    if (!c || !c.isNamed) continue;
    return drillForIdentifier(c, source);
  }
  return null;
}

function drillForIdentifier(node: Node, source: string): string | null {
  if (node.type === 'identifier' || node.type === 'property_identifier') {
    return textOf(node, source);
  }
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    return fn ? drillForIdentifier(fn, source) : null;
  }
  if (node.type === 'member_expression') {
    const prop = node.childForFieldName('property');
    return prop ? drillForIdentifier(prop, source) : null;
  }
  // Fallback — scan named children.
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'identifier' || c.type === 'property_identifier') return textOf(c, source);
  }
  return null;
}

/**
 * Phase 14.4 — detect `import('x')` (call_expression with `import` as fn) or
 * `require('x')`. Emits the same IMPORTS edge + synthetic import symbol that
 * a static `import` statement would.
 */
function tryEmitDynamicImport(callNode: Node, fnNode: Node, ctx: WalkCtx): boolean {
  let isImport = false;
  if (fnNode.type === 'import') isImport = true;
  else if (fnNode.type === 'identifier' && textOf(fnNode, ctx.source) === 'require') {
    isImport = true;
  }
  if (!isImport) return false;

  const args = callNode.childForFieldName('arguments');
  if (!args) return false;
  // First string literal among the args
  for (let i = 0; i < args.childCount; i++) {
    const a = args.child(i);
    if (!a) continue;
    if (a.type === 'string' || a.type === 'template_string') {
      const raw = textOf(a, ctx.source);
      const trimmed = raw.replace(/^['"`]|['"`]$/g, '');
      if (!trimmed || trimmed.includes('${')) return true; // dynamic — bail
      const line = callNode.startPosition.row + 1;
      const col = callNode.startPosition.column;
      ctx.symbols.push({
        name: trimmed,
        kind: 'import',
        start_line: line,
        end_line: line,
        start_col: col,
        end_col: col + trimmed.length,
        localIndex: ctx.symbols.length,
        parentLocalIndex: null,
      });
      ctx.edges.push({
        sourceLocalIndex: ctx.parentIndex,
        target_name: trimmed,
        kind: 'IMPORTS',
        line,
        col,
      });
      ctx.imports.push({
        localName: '*',
        importedName: '*',
        moduleSpecifier: trimmed,
        kind: 'value',
        line,
        col,
      });
      return true;
    }
  }
  return true; // recognized but no string arg — still suppress the CALL edge
}

/**
 * Phase 14.5 — re-export statements. We pick up:
 *   - `export * from 'x'`
 *   - `export { y, z as w } from 'x'`
 *   - `export type { y } from 'x'`           (kind:'type')
 *   - `export * as Ns from 'x'`
 */
function collectReexport(node: Node, ctx: WalkCtx): void {
  // Find a `source` field (string literal) — only present on re-exports.
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return;
  const raw = textOf(sourceNode, ctx.source);
  const moduleSpecifier = raw.replace(/^['"`]|['"`]$/g, '');
  if (!moduleSpecifier) return;
  const line = node.startPosition.row + 1;
  const col = node.startPosition.column;
  const isType = hasTypeKeyword(node, ctx.source);

  ctx.symbols.push({
    name: moduleSpecifier,
    kind: 'import',
    start_line: line,
    end_line: line,
    start_col: col,
    end_col: col + moduleSpecifier.length,
    localIndex: ctx.symbols.length,
    parentLocalIndex: null,
  });
  ctx.edges.push({
    sourceLocalIndex: null,
    target_name: moduleSpecifier,
    kind: 'IMPORTS',
    line,
    col,
  });

  // Per-binding emit. `export_clause` holds named re-exports; namespace
  // re-export uses `namespace_export`; bare `export * from` has neither and
  // gets a single `*` binding.
  let sawNamed = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'export_clause') {
      sawNamed = true;
      for (let j = 0; j < c.childCount; j++) {
        const spec = c.child(j);
        if (!spec || spec.type !== 'export_specifier') continue;
        const nameNode = spec.childForFieldName('name');
        const aliasNode = spec.childForFieldName('alias');
        if (!nameNode) continue;
        const imported = textOf(nameNode, ctx.source);
        const local = aliasNode ? textOf(aliasNode, ctx.source) : imported;
        ctx.imports.push({
          localName: local,
          importedName: imported,
          moduleSpecifier,
          kind: isType || hasTypeKeyword(spec, ctx.source) ? 'type' : 'value',
          line,
          col,
        });
      }
    } else if (c.type === 'namespace_export') {
      sawNamed = true;
      // `export * as Ns from 'x'`
      for (let j = 0; j < c.childCount; j++) {
        const id = c.child(j);
        if (id && id.type === 'identifier') {
          ctx.imports.push({
            localName: textOf(id, ctx.source),
            importedName: '*',
            moduleSpecifier,
            kind: isType ? 'type' : 'value',
            line,
            col,
          });
          break;
        }
      }
    }
  }
  if (!sawNamed) {
    // `export * from 'x'` — no local binding, but record a wildcard so
    // downstream tooling sees the re-export relationship.
    ctx.imports.push({
      localName: '*',
      importedName: '*',
      moduleSpecifier,
      kind: isType ? 'type' : 'value',
      line,
      col,
    });
  }
}

export type { Tree };
