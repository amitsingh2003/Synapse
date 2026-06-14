import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  external: [
    'better-sqlite3',
    'web-tree-sitter',
    'tree-sitter-wasms',
    'chokidar',
    'cli-progress',
    '@synapse/core',
    '@modelcontextprotocol/sdk',
    'zod',
    '@ast-grep/napi',
  ],
});
