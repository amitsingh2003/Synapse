# Contributing to Synapse

Thank you for contributing! This guide covers the development workflow and, most importantly, how to **add a new language adapter**.

## Quick Start

```bash
# Clone and install
git clone <repo-url> && cd synapse
pnpm install

# Build all packages
pnpm -r build

# Run tests
pnpm -r test

# Watch mode (single package)
cd packages/core && pnpm test:watch
```

## Architecture

```
packages/
├── core/          # Indexing engine, parser, DB, embeddings
├── mcp-server/    # MCP JSON-RPC server + HTTP transport
└── cli/           # Command-line interface
fixtures/          # Test fixture repos
```

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add Rust language adapter
fix(mcp-server): handle empty symbol names gracefully
test(core): add property tests for Go parser
docs: update CONTRIBUTING.md with new recipe
```

Scopes: `core`, `mcp-server`, `cli`, `action`, `deps`

## Adding a Language Adapter

This is a step-by-step recipe for adding support for a new programming language.

### 1. Create the adapter file

Create `packages/core/src/languages/<lang>.ts`:

```typescript
import type { LanguageAdapter, ParsedFile, ParsedSymbol } from './types.js';
import { loadGrammar } from '../parser/grammarLoader.js';

export const rustAdapter: LanguageAdapter = {
  id: 'rust',
  extensions: ['.rs'],
  vendorDirs: ['target'],
  resolveExts: ['.rs'],
  indexFiles: [],

  async loadGrammar() {
    return loadGrammar('rust');
  },

  parse(source: string, filePath: string): ParsedFile {
    // Use tree-sitter queries to extract symbols.
    // See typescript.ts for the pattern.
    const symbols: ParsedSymbol[] = [];
    // ... tree-sitter walk logic ...
    return { symbols, imports: [] };
  },

  // Optional: custom module resolution
  resolveModule(specifier: string, fromFile: string, root: string) {
    // Return resolved relative path or undefined
    return undefined;
  },
};
```

### 2. Register the adapter

In `packages/core/src/languages/index.ts`, add:

```typescript
import { rustAdapter } from './rust.js';

export const ADAPTERS: LanguageAdapter[] = [
  typescriptAdapter,
  pythonAdapter,
  goAdapter,
  rustAdapter,  // ← add here
];
```

### 3. Add the tree-sitter WASM grammar

Place the grammar at `packages/core/grammars/tree-sitter-rust.wasm`.

To generate it:
```bash
# Install tree-sitter-cli
npm install -g tree-sitter-cli

# Clone the grammar repo
git clone https://github.com/tree-sitter/tree-sitter-rust
cd tree-sitter-rust

# Build WASM
tree-sitter build --wasm
cp tree-sitter-rust.wasm /path/to/synapse/packages/core/grammars/
```

### 4. Add a test fixture

Create `fixtures/sample-<lang>-app/` with a small representative project:

```
fixtures/sample-rust-app/
├── src/
│   ├── main.rs
│   ├── lib.rs
│   └── utils.rs
└── Cargo.toml
```

The fixture should exercise:
- Functions (exported and private)
- Structs/classes
- Methods
- Imports/use statements
- Cross-file references

### 5. Write tests

Create `packages/core/src/languages/rust.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { rustAdapter } from './rust.js';

describe('Rust adapter', () => {
  it('parses functions', () => {
    const result = rustAdapter.parse(
      'pub fn hello(name: &str) -> String { format!("Hello, {}", name) }',
      'src/main.rs',
    );
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('hello');
    expect(result.symbols[0]!.kind).toBe('function');
  });

  it('parses structs with methods', () => {
    const source = `
      pub struct Point { x: f64, y: f64 }
      impl Point {
        pub fn new(x: f64, y: f64) -> Self { Self { x, y } }
        pub fn distance(&self, other: &Point) -> f64 { /* ... */ 0.0 }
      }
    `;
    const result = rustAdapter.parse(source, 'src/point.rs');
    const names = result.symbols.map(s => s.name);
    expect(names).toContain('Point');
    expect(names).toContain('new');
    expect(names).toContain('distance');
  });
});
```

### 6. Integration test

Add a test that indexes the full fixture:

```typescript
it('indexes sample-rust-app end-to-end', async () => {
  const db = openDatabase({ path: ':memory:' });
  const summary = await indexRepo(db, { root: RUST_FIXTURE, concurrency: 2 });
  expect(summary.filesIndexed).toBeGreaterThan(0);
  expect(summary.symbolCount).toBeGreaterThan(0);
  db.close();
});
```

### 7. Update documentation

- Add the language to the README's "Supported Languages" section
- Add the adapter to `packages/core/package.json` description
- Update `.synapse/config.json` schema if the adapter has custom options

## Key Design Principles

1. **Adapters are pure** — they receive source text and return structured data
2. **No runtime dependencies** — grammars are WASM, loaded lazily
3. **Graceful degradation** — parse errors produce partial results, never crash
4. **Deterministic** — same input always produces same output
5. **Tested at every level** — unit (adapter), integration (indexRepo), snapshot (MCP tools)

## PR Checklist

- [ ] New adapter implements `LanguageAdapter` interface
- [ ] WASM grammar included in `packages/core/grammars/`
- [ ] Test fixture created in `fixtures/`
- [ ] Unit tests pass: `pnpm -r test`
- [ ] Build passes: `pnpm -r build`
- [ ] Snapshot tests updated: `pnpm -r test -- -u` (if shapes changed)
- [ ] CONTRIBUTING.md or README updated if applicable

## Development Tips

- Use `pnpm exec vitest run <pattern>` to run specific test files
- Use `--reporter=verbose` for detailed output
- Property tests use `fast-check` — seed is fixed for reproducibility
- The `--json` flag on CLI commands is useful for debugging output shapes
