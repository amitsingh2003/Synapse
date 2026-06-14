import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  external: ['better-sqlite3', 'web-tree-sitter', 'tree-sitter-wasms', 'cli-progress', 'chokidar', '@synapse/core'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
