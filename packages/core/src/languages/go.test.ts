import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoAdapter, _clearGoModuleCache } from './go.js';

const parse = (src: string) => GoAdapter.parse(src, 'pkg/file.go');

describe('GoAdapter — parse', () => {
  it('extracts struct, interface, function, and method symbols', async () => {
    const src = `
package shop

type Cart struct {
    Items []string
}

type Adder interface {
    Add(s string)
}

func New() *Cart { return &Cart{} }

func (c *Cart) Add(s string) {
    c.Items = append(c.Items, s)
}
`;
    const out = await parse(src);
    const byName = (n: string) => out.symbols.find((s) => s.name === n);
    expect(byName('Cart')?.kind).toBe('struct');
    expect(byName('Adder')?.kind).toBe('interface');
    expect(byName('New')?.kind).toBe('function');
    expect(byName('Add')?.kind).toBe('method');
  });

  it('captures import declarations including aliases', async () => {
    const src = `
package main

import (
    "fmt"
    m "example.com/sample/shop"
)
`;
    const out = await parse(src);
    const mods = out.imports.map((i) => `${i.moduleSpecifier}->${i.localName}`);
    expect(mods).toContain('fmt->fmt');
    expect(mods).toContain('example.com/sample/shop->m');
  });
});

describe('GoAdapter — resolveModule (via go.mod)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'go-adapter-'));
    writeFileSync(join(root, 'go.mod'), 'module example.com/sample\n\ngo 1.22\n');
    _clearGoModuleCache();
  });

  it('resolves an import inside the module to a .go file', () => {
    const filesByPath = new Map<string, number>([
      ['main.go', 1],
      ['shop/cart.go', 2],
      ['shop/product.go', 3],
      ['shop/cart_test.go', 4],
    ]);
    const r = GoAdapter.resolveModule!('example.com/sample/shop', '', { root, filesByPath });
    expect(r).toBeDefined();
    expect(['shop/cart.go', 'shop/product.go']).toContain(r!);
    expect(r).not.toBe('shop/cart_test.go');
  });

  it('returns null for imports outside the module', () => {
    const filesByPath = new Map<string, number>([['main.go', 1]]);
    const r = GoAdapter.resolveModule!('fmt', '', { root, filesByPath });
    expect(r).toBeNull();
  });

  it('returns null when no .go file matches the subpath', () => {
    const filesByPath = new Map<string, number>([['main.go', 1]]);
    const r = GoAdapter.resolveModule!('example.com/sample/missing', '', { root, filesByPath });
    expect(r).toBeNull();
  });
});
