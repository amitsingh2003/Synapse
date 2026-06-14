import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTsProject,
  resolveViaTsPaths,
  resolveViaWorkspace,
  _clearTsProjectCache,
} from './tsProject.js';

function writeJson(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

describe('TsProject — tsconfig paths + workspaces', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tsproj-'));
    _clearTsProjectCache();
  });

  it('reads compilerOptions.paths and baseUrl', () => {
    writeJson(join(root, 'tsconfig.json'), {
      compilerOptions: {
        baseUrl: './src',
        paths: { '@app/*': ['./*'], '@shared': ['./shared/index.ts'] },
      },
    });
    const project = loadTsProject(root);
    expect(project.baseUrl).toContain('src');
    expect(project.paths.length).toBe(2);
    const candidates = resolveViaTsPaths(project, '@app/foo/bar', root);
    expect(candidates[0]).toMatch(/src[/\\]foo[/\\]bar/);
  });

  it('honors a tsconfig extends chain', () => {
    writeJson(join(root, 'tsconfig.base.json'), {
      compilerOptions: { baseUrl: '.', paths: { '@a/*': ['packages/a/src/*'] } },
    });
    writeJson(join(root, 'tsconfig.json'), {
      extends: './tsconfig.base.json',
      compilerOptions: { paths: { '@b/*': ['packages/b/src/*'] } },
    });
    const project = loadTsProject(root);
    const patterns = project.paths.map((p) => p.pattern).sort();
    expect(patterns).toEqual(['@a/*', '@b/*']);
  });

  it('strips JSONC comments and trailing commas', () => {
    writeFileSync(
      join(root, 'tsconfig.json'),
      `{
        // a line comment
        "compilerOptions": {
          /* block */
          "baseUrl": ".",
          "paths": { "@x/*": ["x/*"], },
        },
      }`,
    );
    const project = loadTsProject(root);
    expect(project.paths.length).toBe(1);
  });

  it('discovers pnpm/yarn/npm workspace packages', () => {
    writeJson(join(root, 'package.json'), { name: 'host', workspaces: ['packages/*'] });
    mkdirSync(join(root, 'packages', 'lib-a'), { recursive: true });
    mkdirSync(join(root, 'packages', 'lib-b'), { recursive: true });
    writeJson(join(root, 'packages', 'lib-a', 'package.json'), {
      name: '@scope/lib-a',
      main: './dist/index.js',
      module: './dist/index.mjs',
    });
    writeJson(join(root, 'packages', 'lib-b', 'package.json'), {
      name: '@scope/lib-b',
      exports: { '.': { import: './src/index.ts' } },
    });
    const project = loadTsProject(root);
    expect(project.workspacePackages.map((p) => p.name).sort()).toEqual([
      '@scope/lib-a',
      '@scope/lib-b',
    ]);

    const a = resolveViaWorkspace(project, '@scope/lib-a', root);
    // Prefers `module` over `main`.
    expect(a).toMatch(/packages\/lib-a\/dist\/index\.mjs/);

    const b = resolveViaWorkspace(project, '@scope/lib-b', root);
    expect(b).toMatch(/packages\/lib-b\/src\/index\.ts/);
  });

  it('resolves exports subpath patterns', () => {
    writeJson(join(root, 'package.json'), { name: 'host', workspaces: ['pkg'] });
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeJson(join(root, 'pkg', 'package.json'), {
      name: 'multi',
      exports: {
        '.': './index.js',
        './feature/*': './src/feature/*.ts',
      },
    });
    const project = loadTsProject(root);
    const resolved = resolveViaWorkspace(project, 'multi/feature/alpha', root);
    expect(resolved).toMatch(/pkg\/src\/feature\/alpha\.ts/);
  });
});
