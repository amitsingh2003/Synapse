/**
 * Phase 21 — Generic adapter integration tests.
 * Validates that the universal adapter correctly parses Java, C#, C++, and Rust
 * using the declarative language definitions + tree-sitter WASM grammars.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openDatabase,
  indexRepo,
  getAdapterForFile,
  getAdapterById,
  getAllAdapters,
  resolveJavaModule,
  resolveCSharpModule,
  getTierForLanguage,
} from '@synapse/core';
import type { ResolveCtx } from '@synapse/core';

const FIXTURE_BASE = join(__dirname, '..', '..', '..', '..', 'fixtures');

describe('Phase 21 — Generic adapter: language registry', () => {
  it('registers all generic language adapters', () => {
    const all = getAllAdapters();
    // Premium adapters
    expect(getAdapterById('typescript')).toBeTruthy();
    expect(getAdapterById('python')).toBeTruthy();
    expect(getAdapterById('go')).toBeTruthy();
    // Generic adapters
    expect(getAdapterById('java')).toBeTruthy();
    expect(getAdapterById('csharp')).toBeTruthy();
    expect(getAdapterById('cpp')).toBeTruthy();
    expect(getAdapterById('rust')).toBeTruthy();
    expect(getAdapterById('ruby')).toBeTruthy();
    expect(getAdapterById('kotlin')).toBeTruthy();
    expect(getAdapterById('swift')).toBeTruthy();
    expect(getAdapterById('php')).toBeTruthy();
    // Total: 3 premium + 12 generic
    expect(all.length).toBeGreaterThanOrEqual(15);
  });

  it('routes file extensions to correct adapters', () => {
    expect(getAdapterForFile('Main.java')?.id).toBe('java');
    expect(getAdapterForFile('Cart.cs')?.id).toBe('csharp');
    expect(getAdapterForFile('shop.cpp')?.id).toBe('cpp');
    expect(getAdapterForFile('main.rs')?.id).toBe('rust');
    expect(getAdapterForFile('app.rb')?.id).toBe('ruby');
    expect(getAdapterForFile('Main.kt')?.id).toBe('kotlin');
    expect(getAdapterForFile('app.swift')?.id).toBe('swift');
    expect(getAdapterForFile('index.php')?.id).toBe('php');
    expect(getAdapterForFile('main.dart')?.id).toBe('dart');
    expect(getAdapterForFile('Main.scala')?.id).toBe('scala');
    expect(getAdapterForFile('main.zig')?.id).toBe('zig');
    expect(getAdapterForFile('init.lua')?.id).toBe('lua');
    // Premium adapters still take precedence
    expect(getAdapterForFile('app.ts')?.id).toBe('typescript');
    expect(getAdapterForFile('app.py')?.id).toBe('python');
    expect(getAdapterForFile('main.go')?.id).toBe('go');
  });

  it('C/C++ header files route to cpp adapter', () => {
    expect(getAdapterForFile('widget.h')?.id).toBe('cpp');
    expect(getAdapterForFile('lib.hpp')?.id).toBe('cpp');
    expect(getAdapterForFile('core.hxx')?.id).toBe('cpp');
  });
});

describe('Phase 21 — Generic adapter: Java parsing', () => {
  it('extracts classes, methods, and calls from Java source', async () => {
    const adapter = getAdapterById('java')!;
    const source = `
package com.example;

import java.util.List;

public class Cart {
    private List<Product> items;

    public void addProduct(Product p) {
        items.add(p);
    }

    public int getTotal() {
        return items.stream().mapToInt(Product::getPrice).sum();
    }
}
`;
    const result = await adapter.parse(source, 'Cart.java');
    expect(result.language).toBe('java');

    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('Cart');
    expect(names).toContain('addProduct');
    expect(names).toContain('getTotal');

    const classSymbol = result.symbols.find((s) => s.name === 'Cart');
    expect(classSymbol?.kind).toBe('class');

    const methodSymbol = result.symbols.find((s) => s.name === 'addProduct');
    expect(methodSymbol?.kind).toBe('method');

    // Methods should be parented to the class
    expect(methodSymbol?.parentLocalIndex).toBe(classSymbol?.localIndex);

    // Should detect imports
    expect(result.imports.length).toBeGreaterThan(0);

    // Should detect calls
    const callEdges = result.edges.filter((e) => e.kind === 'CALLS');
    expect(callEdges.length).toBeGreaterThan(0);
  });
});

describe('Phase 21 — Generic adapter: C# parsing', () => {
  it('extracts classes, interfaces, and enums from C# source', async () => {
    const adapter = getAdapterById('csharp')!;
    const source = `
using System;
using System.Collections.Generic;

namespace Shop
{
    public class Cart
    {
        private readonly List<Product> _items = new();

        public void AddProduct(Product product)
        {
            _items.Add(product);
        }

        public decimal GetTotal()
        {
            return _items.Sum(p => p.Price);
        }
    }

    public interface IPaymentProcessor
    {
        bool ProcessPayment(decimal amount);
    }

    public enum OrderStatus
    {
        Pending,
        Processing,
        Shipped
    }
}
`;
    const result = await adapter.parse(source, 'Cart.cs');
    expect(result.language).toBe('csharp');

    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('Cart');
    expect(names).toContain('AddProduct');
    expect(names).toContain('GetTotal');
    expect(names).toContain('IPaymentProcessor');
    expect(names).toContain('OrderStatus');

    const ns = result.symbols.find((s) => s.name === 'Shop');
    expect(ns?.kind).toBe('namespace');

    const iface = result.symbols.find((s) => s.name === 'IPaymentProcessor');
    expect(iface?.kind).toBe('interface');

    const enumSym = result.symbols.find((s) => s.name === 'OrderStatus');
    expect(enumSym?.kind).toBe('enum');

    // Should detect using directives
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Phase 21 — Generic adapter: C++ parsing', () => {
  it('extracts namespaces, classes, structs, and functions from C++', async () => {
    const adapter = getAdapterById('cpp')!;
    const source = `
#include <iostream>
#include <vector>

namespace shop {

struct Product {
    std::string name;
    int price;
};

class Cart {
public:
    void add_product(Product p) {
        items_.push_back(p);
    }

    int get_total() const {
        int t = 0;
        for (const auto& i : items_) t += i.price;
        return t;
    }

private:
    std::vector<Product> items_;
};

} // namespace shop

int main() {
    shop::Cart cart;
    cart.add_product({"Apple", 150});
    return 0;
}
`;
    const result = await adapter.parse(source, 'shop.cpp');
    expect(result.language).toBe('cpp');

    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('shop');
    expect(names).toContain('Product');
    expect(names).toContain('Cart');
    expect(names).toContain('main');

    const nsSym = result.symbols.find((s) => s.name === 'shop');
    expect(nsSym?.kind).toBe('namespace');

    const structSym = result.symbols.find((s) => s.name === 'Product');
    expect(structSym?.kind).toBe('struct');

    // Should detect includes
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Phase 21 — Generic adapter: Rust parsing', () => {
  it('extracts structs, traits, functions, and modules from Rust', async () => {
    const adapter = getAdapterById('rust')!;
    const source = `
use std::fmt;

/// A product in the shop.
pub struct Product {
    pub name: String,
    pub price: u32,
}

impl Product {
    pub fn new(name: &str, price: u32) -> Self {
        Product { name: name.to_string(), price }
    }
}

pub trait PaymentProcessor {
    fn process(&self, amount: u32) -> bool;
}

pub fn calculate_total(items: &[Product]) -> u32 {
    items.iter().map(|p| p.price).sum()
}

fn main() {
    let p = Product::new("Apple", 150);
    println!("{}", calculate_total(&[p]));
}
`;
    const result = await adapter.parse(source, 'main.rs');
    expect(result.language).toBe('rust');

    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('Product');
    expect(names).toContain('PaymentProcessor');
    expect(names).toContain('calculate_total');
    expect(names).toContain('main');

    const structSym = result.symbols.find((s) => s.name === 'Product');
    expect(structSym?.kind).toBe('struct');

    const traitSym = result.symbols.find((s) => s.name === 'PaymentProcessor');
    expect(traitSym?.kind).toBe('trait');

    const fnSym = result.symbols.find((s) => s.name === 'calculate_total');
    expect(fnSym?.kind).toBe('function');

    // Should detect use statements
    expect(result.imports.length).toBeGreaterThan(0);

    // Should detect calls
    const calls = result.edges.filter((e) => e.kind === 'CALLS');
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('Phase 21 — Generic adapter: full repo indexing', () => {
  let dbDir: string;

  beforeAll(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'cg-generic-'));
  });

  afterAll(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('indexes the Java fixture completely', async () => {
    const dbPath = join(dbDir, 'java.db');
    const db = openDatabase({ path: dbPath });
    const summary = await indexRepo(db, {
      root: join(FIXTURE_BASE, 'sample-java'),
      concurrency: 1,
    });
    expect(summary.filesIndexed).toBeGreaterThanOrEqual(3);

    const symbols = db.prepare('SELECT name, kind FROM symbols ORDER BY name').all() as {
      name: string;
      kind: string;
    }[];
    const names = symbols.map((s) => s.name);
    expect(names).toContain('Cart');
    expect(names).toContain('Product');
    expect(names).toContain('Main');
    expect(names).toContain('addProduct');
    expect(names).toContain('getTotal');
    expect(names).toContain('getName');
    expect(names).toContain('getPrice');
    db.close();
  });

  it('indexes the C# fixture completely', async () => {
    const dbPath = join(dbDir, 'csharp.db');
    const db = openDatabase({ path: dbPath });
    const summary = await indexRepo(db, {
      root: join(FIXTURE_BASE, 'sample-csharp'),
      concurrency: 1,
    });
    expect(summary.filesIndexed).toBeGreaterThanOrEqual(2);

    const symbols = db.prepare('SELECT name, kind FROM symbols ORDER BY name').all() as {
      name: string;
      kind: string;
    }[];
    const names = symbols.map((s) => s.name);
    expect(names).toContain('Cart');
    expect(names).toContain('Product');
    expect(names).toContain('IPaymentProcessor');
    expect(names).toContain('OrderStatus');
    db.close();
  });

  it('indexes the C++ fixture completely', async () => {
    const dbPath = join(dbDir, 'cpp.db');
    const db = openDatabase({ path: dbPath });
    const summary = await indexRepo(db, {
      root: join(FIXTURE_BASE, 'sample-cpp'),
      concurrency: 1,
    });
    expect(summary.filesIndexed).toBeGreaterThanOrEqual(1);

    const symbols = db.prepare('SELECT name, kind FROM symbols ORDER BY name').all() as {
      name: string;
      kind: string;
    }[];
    const names = symbols.map((s) => s.name);
    expect(names).toContain('Product');
    expect(names).toContain('Cart');
    expect(names).toContain('shop');
    expect(names).toContain('main');
    db.close();
  });

  it('indexes the Rust fixture completely', async () => {
    const dbPath = join(dbDir, 'rust.db');
    const db = openDatabase({ path: dbPath });
    const summary = await indexRepo(db, {
      root: join(FIXTURE_BASE, 'sample-rust'),
      concurrency: 1,
    });
    expect(summary.filesIndexed).toBeGreaterThanOrEqual(1);

    const symbols = db.prepare('SELECT name, kind FROM symbols ORDER BY name').all() as {
      name: string;
      kind: string;
    }[];
    const names = symbols.map((s) => s.name);
    expect(names).toContain('Product');
    expect(names).toContain('Cart');
    expect(names).toContain('PaymentProcessor');
    expect(names).toContain('main');
    db.close();
  });
});

// ─── Helper: build a minimal ResolveCtx from a path list ─────────────────

function makeCtxFromPaths(root: string, paths: string[]): ResolveCtx {
  const filesByPath = new Map<string, number>(paths.map((p, i) => [p, i + 1]));
  return { root, filesByPath };
}

// ─── Java module resolution ───────────────────────────────────────────────

describe('Java module resolution (Tier 1 promotion)', () => {
  it('java and csharp are now Tier 1', () => {
    expect(getTierForLanguage('java')).toBe(1);
    expect(getTierForLanguage('csharp')).toBe(1);
  });

  it('java adapter has resolveModule', () => {
    const adapter = getAdapterById('java')!;
    expect(typeof adapter.resolveModule).toBe('function');
  });

  it('resolves exact class import at repo root', () => {
    const ctx = makeCtxFromPaths('/repo', [
      'com/example/shop/Cart.java',
      'com/example/shop/Product.java',
    ]);
    expect(resolveJavaModule('com.example.shop.Cart', '', ctx))
      .toBe('com/example/shop/Cart.java');
  });

  it('resolves class under Maven src/main/java source root', () => {
    const ctx = makeCtxFromPaths('/repo', [
      'src/main/java/com/example/shop/Cart.java',
      'src/main/java/com/example/shop/Product.java',
    ]);
    expect(resolveJavaModule('com.example.shop.Cart', '', ctx))
      .toBe('src/main/java/com/example/shop/Cart.java');
  });

  it('resolves wildcard import to first file in package', () => {
    const ctx = makeCtxFromPaths('/repo', [
      'src/main/java/com/example/shop/Cart.java',
      'src/main/java/com/example/shop/Product.java',
    ]);
    const result = resolveJavaModule('com.example.shop.*', '', ctx);
    expect(result).toMatch(/com\/example\/shop\/.+\.java$/);
  });

  it('resolves static import by stripping the method segment', () => {
    const ctx = makeCtxFromPaths('/repo', [
      'src/main/java/com/example/Utils.java',
    ]);
    expect(resolveJavaModule('static com.example.Utils.formatDate', '', ctx))
      .toBe('src/main/java/com/example/Utils.java');
  });

  it('returns null for external (JDK / Maven) imports', () => {
    const ctx = makeCtxFromPaths('/repo', ['src/main/java/com/example/Cart.java']);
    expect(resolveJavaModule('java.util.List', '', ctx)).toBeNull();
    expect(resolveJavaModule('org.springframework.web.bind.annotation.RestController', '', ctx)).toBeNull();
  });

  it('resolves via suffix search when source root is non-standard', () => {
    const ctx = makeCtxFromPaths('/repo', [
      'modules/billing/java/com/example/billing/Invoice.java',
    ]);
    expect(resolveJavaModule('com.example.billing.Invoice', '', ctx))
      .toBe('modules/billing/java/com/example/billing/Invoice.java');
  });
});

// ─── C# module resolution ────────────────────────────────────────────────

describe('C# module resolution (Tier 1 promotion)', () => {
  it('csharp adapter has resolveModule', () => {
    const adapter = getAdapterById('csharp')!;
    expect(typeof adapter.resolveModule).toBe('function');
  });

  it('resolves namespace.Class to a .cs file at repo root', () => {
    const ctx = makeCtxFromPaths('/repo', [
      'Shop/Services/EmailService.cs',
      'Shop/Models/Product.cs',
    ]);
    expect(resolveCSharpModule('Shop.Services.EmailService', '', ctx))
      .toBe('Shop/Services/EmailService.cs');
  });

  it('resolves namespace.Class under src/ source root', () => {
    const ctx = makeCtxFromPaths('/repo', [
      'src/Shop/Services/EmailService.cs',
    ]);
    expect(resolveCSharpModule('Shop.Services.EmailService', '', ctx))
      .toBe('src/Shop/Services/EmailService.cs');
  });

  it('resolves namespace-only import to first .cs in directory', () => {
    const ctx = makeCtxFromPaths('/repo', [
      'Shop/Services/EmailService.cs',
      'Shop/Services/SmsService.cs',
    ]);
    const result = resolveCSharpModule('Shop.Services', '', ctx);
    expect(result).toMatch(/Shop\/Services\/.+\.cs$/);
  });

  it('returns null for System / BCL namespaces not in the repo', () => {
    const ctx = makeCtxFromPaths('/repo', ['Shop/Cart.cs']);
    expect(resolveCSharpModule('System', '', ctx)).toBeNull();
    expect(resolveCSharpModule('System.Collections.Generic', '', ctx)).toBeNull();
    expect(resolveCSharpModule('System.Linq', '', ctx)).toBeNull();
  });

  it('resolves via suffix search when source root is non-standard', () => {
    const ctx = makeCtxFromPaths('/repo', [
      'modules/payments/MyApp/Payments/Invoice.cs',
    ]);
    expect(resolveCSharpModule('MyApp.Payments.Invoice', '', ctx))
      .toBe('modules/payments/MyApp/Payments/Invoice.cs');
  });
});
