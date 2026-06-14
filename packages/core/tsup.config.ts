import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  external: ['better-sqlite3', 'web-tree-sitter', 'tree-sitter-wasms', 'chokidar', 'xxhash-wasm', 'ignore', 'piscina', 'cli-progress'],
});
