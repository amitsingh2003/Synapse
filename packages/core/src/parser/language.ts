/**
 * Phase 12+13: `Language` is any string (whatever an adapter declares as
 * its `id`). Built-in adapters today are `'typescript'`, `'python'`, `'go'`.
 *
 * The legacy TS-family grammar tag (`'typescript' | 'tsx' | 'javascript'`)
 * is preserved internally as `SubLanguage` so the existing tree-sitter
 * runtime keeps working unchanged for sub-grammar dispatch.
 *
 * `detectLanguage(path)` returns the per-file language tag stored in
 * `files.language`. For TS this is the sub-grammar id (`typescript`/`tsx`/
 * `javascript`). For other languages it's the adapter id (`python`, `go`).
 */
export type Language = string;
export type SubLanguage = 'typescript' | 'tsx' | 'javascript';

const EXT_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.jsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  // Phase 21 — generic adapter languages
  '.java': 'java',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.cc': 'cpp',
  '.c': 'c',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.hh': 'cpp',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.gemspec': 'ruby',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.php': 'php',
  '.phtml': 'php',
  '.dart': 'dart',
  '.scala': 'scala',
  '.sc': 'scala',
  '.zig': 'zig',
  '.lua': 'lua',
  // Phase 22.1 — long-tail languages
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.elm': 'elm',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.sol': 'solidity',
  '.m': 'objc',
  '.mm': 'objc',
  '.vue': 'vue',
  '.res': 'rescript',
  '.resi': 'rescript',
  // Phase 22.2 — tier-3 text-only languages (no AST, indexed for FTS/semantic)
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.json': 'json',
  '.jsonc': 'json',
  '.json5': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.sql': 'sql',
  '.xml': 'xml',
  '.xsd': 'xml',
  '.xsl': 'xml',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.env': 'env',
  '.dockerfile': 'dockerfile',
  '.gitignore': 'gitignore',
  '.npmignore': 'gitignore',
  '.dockerignore': 'gitignore',
  '.txt': 'text',
  '.text': 'text',
  '.log': 'text',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.csv': 'csv',
  '.tsv': 'csv',
};

export function detectLanguage(path: string): Language | null {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  return EXT_MAP[ext] ?? null;
}
