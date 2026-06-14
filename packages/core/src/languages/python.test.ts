import { describe, it, expect } from 'vitest';
import { PythonAdapter } from './python.js';

const parse = (src: string) => PythonAdapter.parse(src, 'mod.py');

describe('PythonAdapter — parse', () => {
  it('extracts class, method, and function symbols', async () => {
    const src = `
def top_level(x):
    return x + 1

class Cart:
    def __init__(self):
        self.items = []

    def add(self, item):
        self.items.append(item)
`;
    const out = await parse(src);
    const byName = (n: string) => out.symbols.find((s) => s.name === n);
    expect(byName('top_level')?.kind).toBe('function');
    expect(byName('Cart')?.kind).toBe('class');
    expect(byName('__init__')?.kind).toBe('method');
    expect(byName('add')?.kind).toBe('method');
  });

  it('records inheritance via EXTENDS edges', async () => {
    const src = `
class Base:
    pass

class Sub(Base):
    pass
`;
    const out = await parse(src);
    const extends_ = out.edges.filter((e) => e.kind === 'EXTENDS');
    expect(extends_.map((e) => e.target_name)).toContain('Base');
  });

  it('captures `from X import Y` import bindings', async () => {
    const src = `from shop.product import Product\nfrom .cart import Cart as C\n`;
    const out = await parse(src);
    const specs = out.imports.map((i) => `${i.moduleSpecifier}:${i.importedName}->${i.localName}`);
    expect(specs).toContain('shop.product:Product->Product');
    expect(specs).toContain('.cart:Cart->C');
  });

  it('captures bare `import foo.bar` imports', async () => {
    const src = `import os.path\nimport json as J\n`;
    const out = await parse(src);
    const mods = out.imports.map((i) => `${i.moduleSpecifier}->${i.localName}`);
    expect(mods).toContain('os.path->os');
    expect(mods).toContain('json->J');
  });
});

describe('PythonAdapter — resolveModule', () => {
  const filesByPath = new Map<string, number>([
    ['shop/__init__.py', 1],
    ['shop/cart.py', 2],
    ['shop/product.py', 3],
    ['app.py', 4],
  ]);
  const ctx = { root: '/tmp/whatever', filesByPath };

  it('resolves a relative dotted import to a sibling .py', () => {
    const r = PythonAdapter.resolveModule!('.cart', 'shop', ctx);
    expect(r).toBe('shop/cart.py');
  });

  it('resolves an absolute package import to __init__.py', () => {
    const r = PythonAdapter.resolveModule!('shop', '', ctx);
    expect(r).toBe('shop/__init__.py');
  });

  it('resolves an absolute dotted import to the submodule', () => {
    const r = PythonAdapter.resolveModule!('shop.product', '', ctx);
    expect(r).toBe('shop/product.py');
  });

  it('returns null for unknown bare imports', () => {
    expect(PythonAdapter.resolveModule!('numpy', '', ctx)).toBeNull();
  });
});
