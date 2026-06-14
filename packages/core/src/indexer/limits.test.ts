import { describe, it, expect } from 'vitest';
import { applyParseCaps, MAX_SYMBOLS_PER_FILE, MAX_EDGES_PER_FILE } from './limits.js';

describe('Phase 22.3 — per-file caps', () => {
  it('does not truncate when under the cap', () => {
    const parsed = {
      symbols: Array.from({ length: 5 }, (_, i) => ({
        localIndex: i,
        parentLocalIndex: null,
      })),
      edges: Array.from({ length: 3 }, () => ({ sourceLocalIndex: 0 })),
    };
    const r = applyParseCaps(parsed);
    expect(r.symbolsCapped).toBe(false);
    expect(r.edgesCapped).toBe(false);
    expect(parsed.symbols.length).toBe(5);
    expect(parsed.edges.length).toBe(3);
  });

  it('truncates symbols beyond MAX_SYMBOLS_PER_FILE', () => {
    const parsed = {
      symbols: Array.from({ length: MAX_SYMBOLS_PER_FILE + 50 }, (_, i) => ({
        localIndex: i,
        parentLocalIndex: null,
      })),
      edges: [],
    };
    const r = applyParseCaps(parsed);
    expect(r.symbolsCapped).toBe(true);
    expect(r.originalSymbolCount).toBe(MAX_SYMBOLS_PER_FILE + 50);
    expect(parsed.symbols.length).toBe(MAX_SYMBOLS_PER_FILE);
  });

  it('drops edges whose source was truncated away', () => {
    const parsed = {
      symbols: Array.from({ length: MAX_SYMBOLS_PER_FILE + 10 }, (_, i) => ({
        localIndex: i,
        parentLocalIndex: null,
      })),
      // 3 dangling + 2 valid edges
      edges: [
        { sourceLocalIndex: MAX_SYMBOLS_PER_FILE + 5 },
        { sourceLocalIndex: MAX_SYMBOLS_PER_FILE + 6 },
        { sourceLocalIndex: 1 },
        { sourceLocalIndex: null },
        { sourceLocalIndex: MAX_SYMBOLS_PER_FILE + 7 },
      ],
    };
    applyParseCaps(parsed);
    expect(parsed.edges.length).toBe(2);
    for (const e of parsed.edges) {
      expect(
        e.sourceLocalIndex === null || e.sourceLocalIndex < MAX_SYMBOLS_PER_FILE,
      ).toBe(true);
    }
  });

  it('caps edges beyond MAX_EDGES_PER_FILE', () => {
    const parsed = {
      symbols: [{ localIndex: 0, parentLocalIndex: null }],
      edges: Array.from({ length: MAX_EDGES_PER_FILE + 100 }, () => ({
        sourceLocalIndex: 0,
      })),
    };
    const r = applyParseCaps(parsed);
    expect(r.edgesCapped).toBe(true);
    expect(parsed.edges.length).toBe(MAX_EDGES_PER_FILE);
  });
});
