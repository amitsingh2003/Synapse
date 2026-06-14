import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIgnoreStack } from './ignoreStack.js';

let dir: string | null = null;

afterEach(() => {
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    dir = null;
  }
});

function makeRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'cg-ignore-'));
  dir = d;
  return d;
}

describe('ignoreStack', () => {
  it('honours the root .gitignore', () => {
    const root = makeRoot();
    writeFileSync(join(root, '.gitignore'), 'dist/\n*.log\n');
    const ig = createIgnoreStack({ root, skipGlobal: true });
    expect(ig.ignores('dist/foo.js', false)).toBe(true);
    expect(ig.ignores('app.log', false)).toBe(true);
    expect(ig.ignores('src/app.ts', false)).toBe(false);
  });

  it('layers .synapseignore on top of .gitignore', () => {
    const root = makeRoot();
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    writeFileSync(join(root, '.synapseignore'), 'fixtures/\n');
    const ig = createIgnoreStack({ root, skipGlobal: true });
    expect(ig.ignores('fixtures/sample.ts', false)).toBe(true);
    expect(ig.ignores('dist/x.js', false)).toBe(true);
  });

  it('honours nested .gitignore inside subdirectories', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'pkg', 'src'), { recursive: true });
    writeFileSync(join(root, 'pkg', '.gitignore'), 'generated/\n');
    mkdirSync(join(root, 'pkg', 'generated'), { recursive: true });
    const ig = createIgnoreStack({ root, skipGlobal: true });
    ig.addNested(join(root, 'pkg'));
    expect(ig.ignores('pkg/generated/auto.ts', false)).toBe(true);
    expect(ig.ignores('pkg/src/real.ts', false)).toBe(false);
    // Patterns in the nested gitignore must NOT leak above their dir.
    expect(ig.ignores('generated/other.ts', false)).toBe(false);
  });

  it('honours .git/info/exclude', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'secret/\n');
    const ig = createIgnoreStack({ root, skipGlobal: true });
    expect(ig.ignores('secret/keys.ts', false)).toBe(true);
  });

  it('accepts extraPatterns at highest precedence', () => {
    const root = makeRoot();
    const ig = createIgnoreStack({
      root,
      skipGlobal: true,
      extraPatterns: ['scratch/'],
    });
    expect(ig.ignores('scratch/temp.ts', false)).toBe(true);
  });
});
