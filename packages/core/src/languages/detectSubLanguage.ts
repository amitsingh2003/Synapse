import type { SubLanguage } from '../parser/language.js';

/**
 * Map a file extension to the specific tree-sitter sub-grammar within the
 * TypeScript family. Defaults to `typescript` for unknown extensions claimed
 * by the adapter (callers gate by extension before invoking).
 */
export function detectSubLanguage(filePath: string): SubLanguage {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'typescript';
  const ext = lower.slice(dot);
  switch (ext) {
    case '.tsx':
    case '.jsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.ts':
    case '.mts':
    case '.cts':
    default:
      return 'typescript';
  }
}
