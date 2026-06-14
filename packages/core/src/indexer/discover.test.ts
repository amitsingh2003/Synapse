import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverFiles } from './discover.js';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-discover-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'foo'), { recursive: true });
  mkdirSync(join(root, 'generated'), { recursive: true });

  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'b.tsx'), 'export const b = <div/>;\n');
  writeFileSync(join(root, 'src', 'c.js'), 'export const c = 1;\n');
  writeFileSync(join(root, 'src', 'README.md'), '# nope\n'); // unsupported lang
  writeFileSync(join(root, 'node_modules', 'foo', 'bad.ts'), 'export const bad = 1;\n');
  writeFileSync(join(root, 'generated', 'gen.ts'), 'export const gen = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'generated/\n');
  return root;
}

describe('discoverFiles', () => {
  it('finds supported sources, honours .gitignore and skips node_modules', async () => {
    const root = makeRepo();
    const files = await discoverFiles({ root });
    const rels = files.map((f) => f.relPath).sort();
    // Phase 22.2 — `.gitignore` and `.md` are now tier-3 text-indexed.
    expect(rels).toEqual([
      '.gitignore',
      'src/README.md',
      'src/a.ts',
      'src/b.tsx',
      'src/c.js',
    ]);
  });

  it('computes a stable xxhash per file', async () => {
    const root = makeRepo();
    const first = await discoverFiles({ root });
    const second = await discoverFiles({ root });
    const h1 = first.find((f) => f.relPath === 'src/a.ts')!.xxhash;
    const h2 = second.find((f) => f.relPath === 'src/a.ts')!.xxhash;
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]+$/);
  });
});
