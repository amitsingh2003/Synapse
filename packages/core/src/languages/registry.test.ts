import { describe, it, expect } from 'vitest';
import {
  getAdapterForFile,
  getAllAdapters,
  getTierForLanguage,
  groupByTier,
  TypeScriptAdapter,
} from './index.js';

describe('LanguageAdapter registry', () => {
  it('returns the TypeScript adapter for every TS-family extension', () => {
    for (const ext of TypeScriptAdapter.extensions) {
      const got = getAdapterForFile(`/tmp/foo${ext}`);
      expect(got, `expected adapter for ${ext}`).toBe(TypeScriptAdapter);
    }
  });

  it('returns null for unknown extensions', () => {
    expect(getAdapterForFile('/tmp/foo.unknownext')).toBeNull();
    expect(getAdapterForFile('/tmp/foo')).toBeNull();
  });

  it('lists at least one registered adapter', () => {
    const all = getAllAdapters();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.some((a) => a.id === 'typescript')).toBe(true);
  });

  it('TypeScript adapter exposes resolution config', () => {
    expect(TypeScriptAdapter.resolveExts).toContain('.ts');
    expect(TypeScriptAdapter.indexFiles).toContain('index.ts');
    expect(TypeScriptAdapter.vendorDirs).toContain('node_modules');
  });

  it('TypeScript adapter can parse a trivial source string', async () => {
    const result = await TypeScriptAdapter.parse(
      'export function hi(): string { return "hi"; }',
      '/tmp/sample.ts',
    );
    const fn = result.symbols.find((s) => s.name === 'hi');
    expect(fn).toBeDefined();
    expect(fn?.kind).toBe('function');
  });
});

describe('Phase 22.4 — tier classification', () => {
  it('classifies premium adapters as tier 1', () => {
    expect(getTierForLanguage('typescript')).toBe(1);
    expect(getTierForLanguage('tsx')).toBe(1);
    expect(getTierForLanguage('javascript')).toBe(1);
    expect(getTierForLanguage('python')).toBe(1);
    expect(getTierForLanguage('go')).toBe(1);
  });

  it('classifies java and csharp as tier 1 (module resolution promoted)', () => {
    expect(getTierForLanguage('java')).toBe(1);
    expect(getTierForLanguage('csharp')).toBe(1);
  });

  it('classifies generic adapters as tier 2', () => {
    for (const id of ['rust', 'cpp', 'ruby', 'kotlin', 'swift', 'php', 'scala']) {
      expect(getTierForLanguage(id)).toBe(2);
    }
  });

  it('classifies text adapters as tier 3', () => {
    for (const id of ['markdown', 'json', 'yaml', 'toml', 'sql', 'html', 'css', 'env']) {
      expect(getTierForLanguage(id)).toBe(3);
    }
  });

  it('groupByTier sums and partitions correctly', () => {
    const result = groupByTier({
      typescript: 10,
      python: 5,
      rust: 3,
      java: 2,
      markdown: 8,
      json: 4,
    });
    expect(result.tier1).toBe(17);
    expect(result.tier2).toBe(3);
    expect(result.tier3).toBe(12);
    expect(result.byTier[1]).toEqual({ typescript: 10, python: 5, java: 2 });
    expect(result.byTier[2]).toEqual({ rust: 3 });
    expect(result.byTier[3]).toEqual({ markdown: 8, json: 4 });
  });

  it('handles empty input', () => {
    const result = groupByTier({});
    expect(result.tier1).toBe(0);
    expect(result.tier2).toBe(0);
    expect(result.tier3).toBe(0);
  });
});
