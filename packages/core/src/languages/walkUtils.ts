import type Parser from 'web-tree-sitter';
import type { ExtractedSymbol, ExtractedEdge, ImportBinding } from '../parser/extract.js';
import type { NewSymbol, SymbolKind } from '../db/queries.js';

type Node = Parser.SyntaxNode;

/**
 * Shared scratch space used by the per-language walkers in this folder.
 * The TS walker (in `parser/extract.ts`) predates this file and has its own
 * variant — keep these helpers minimal so they stay drop-in for Python/Go.
 */
export interface BuilderCtx {
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
  imports: ImportBinding[];
  source: string;
}

export function makeCtx(source: string): BuilderCtx {
  return { symbols: [], edges: [], imports: [], source };
}

export function textOf(node: Node, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

/** First line of the declaration, trimmed — adequate as a signature. */
export function signatureOf(node: Node, source: string): string {
  const slice = source.slice(node.startIndex, node.endIndex);
  const firstLine = slice.split('\n', 1)[0] ?? '';
  return firstLine.trim().slice(0, 200);
}

/**
 * Emit a symbol and return its `localIndex`. Pass `parentLocalIndex` to wire
 * it under a parent (e.g. method under a class). Imports + other top-level
 * synthetic rows pass `null`.
 */
export function emitSymbol(
  ctx: BuilderCtx,
  parentLocalIndex: number | null,
  base: NewSymbol,
): number {
  const localIndex = ctx.symbols.length;
  ctx.symbols.push({ ...base, localIndex, parentLocalIndex });
  return localIndex;
}

/** Build a `NewSymbol` from a name-bearing node + its enclosing declaration. */
export function symbolFrom(
  nameNode: Node,
  fullNode: Node,
  kind: SymbolKind,
  source: string,
): NewSymbol {
  return {
    name: textOf(nameNode, source),
    kind,
    start_line: fullNode.startPosition.row + 1,
    end_line: fullNode.endPosition.row + 1,
    start_col: fullNode.startPosition.column,
    end_col: fullNode.endPosition.column,
    signature: signatureOf(fullNode, source),
    doc: null,
  };
}

/**
 * Iterative depth-first traversal. The visitor returns the `localIndex` of
 * any symbol emitted for this node so children become parented to it; return
 * `null` to keep the current parent.
 */
export function walk(
  root: Node,
  visit: (node: Node, parentLocalIndex: number | null) => number | null | void,
): void {
  const stack: { node: Node; parent: number | null }[] = [{ node: root, parent: null }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    const next = visit(node, parent);
    const childParent = typeof next === 'number' ? next : parent;
    // Push children in reverse so they're visited in source order.
    for (let i = node.childCount - 1; i >= 0; i--) {
      const c = node.child(i);
      if (c) stack.push({ node: c, parent: childParent });
    }
  }
}
