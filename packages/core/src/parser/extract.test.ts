import { describe, it, expect } from 'vitest';
import { parseSource } from './extract.js';

const SAMPLE = `
import type { Product } from './product.js';

export class Cart {
  private lines = new Map<string, Product>();

  addItem(item: Product): void {
    this.lines.set(item.id, item);
  }

  removeItem(id: string): void {
    this.lines.delete(id);
  }
}

export function makeCart(): Cart {
  const c = new Cart();
  return c;
}
`;

describe('parseSource (typescript)', () => {
  it('finds the class, methods, function, and import', async () => {
    const { symbols } = await parseSource(SAMPLE, 'typescript');

    const byKind = (k: string) => symbols.filter((s) => s.kind === k).map((s) => s.name);
    expect(byKind('class')).toContain('Cart');
    expect(byKind('method')).toEqual(expect.arrayContaining(['addItem', 'removeItem']));
    expect(byKind('function')).toContain('makeCart');
    expect(byKind('import')).toContain('./product.js');
  });

  it('attaches methods to their class via parentLocalIndex', async () => {
    const { symbols } = await parseSource(SAMPLE, 'typescript');
    const cart = symbols.find((s) => s.name === 'Cart' && s.kind === 'class');
    const addItem = symbols.find((s) => s.name === 'addItem' && s.kind === 'method');
    expect(cart).toBeDefined();
    expect(addItem).toBeDefined();
    expect(addItem!.parentLocalIndex).toBe(cart!.localIndex);
  });

  it('emits CALLS edges for method invocations', async () => {
    const { edges } = await parseSource(SAMPLE, 'typescript');
    const calls = edges.filter((e) => e.kind === 'CALLS').map((e) => e.target_name);
    expect(calls).toEqual(expect.arrayContaining(['set', 'delete']));
  });

  it('emits an IMPORTS edge', async () => {
    const { edges } = await parseSource(SAMPLE, 'typescript');
    expect(edges.some((e) => e.kind === 'IMPORTS' && e.target_name === './product.js')).toBe(true);
  });
});
