/**
 * Phase 22.2 — Text-only "Tier 3" adapter.
 *
 * For files without an AST grammar (Markdown, JSON, YAML, TOML, SQL, .env,
 * config files, etc.) we still want them registered in the index so they
 * can be:
 *   - listed by `list_files`
 *   - found by `search_symbols` (we emit a synthetic file-name symbol)
 *   - retrieved by `get_source`
 *   - included in semantic / hybrid search via their content
 *
 * No AST is built, no calls/edges/imports are extracted — just one symbol
 * representing the file itself.
 */
import type Parser from 'web-tree-sitter';
import type { LanguageAdapter } from './types.js';
import type { ParseResult } from '../parser/extract.js';
import { basename } from 'node:path';

export interface TextLanguageDef {
  /** Display id (stored in DB) */
  id: string;
  /** File extensions (with leading dot) */
  extensions: readonly string[];
  /** Vendor directories to skip */
  vendorDirs?: readonly string[];
}

const TEXT_LANGUAGES: TextLanguageDef[] = [
  { id: 'markdown', extensions: ['.md', '.markdown', '.mdx'] },
  { id: 'json', extensions: ['.json', '.jsonc', '.json5'] },
  { id: 'yaml', extensions: ['.yml', '.yaml'] },
  { id: 'toml', extensions: ['.toml'] },
  { id: 'sql', extensions: ['.sql'] },
  { id: 'xml', extensions: ['.xml', '.xsd', '.xsl'] },
  { id: 'html', extensions: ['.html', '.htm'] },
  { id: 'css', extensions: ['.css', '.scss', '.sass', '.less'] },
  { id: 'ini', extensions: ['.ini', '.cfg', '.conf'] },
  { id: 'env', extensions: ['.env'] },
  { id: 'dockerfile', extensions: ['.dockerfile'] },
  { id: 'gitignore', extensions: ['.gitignore', '.npmignore', '.dockerignore'] },
  { id: 'text', extensions: ['.txt', '.text', '.log'] },
  { id: 'graphql', extensions: ['.graphql', '.gql'] },
  { id: 'protobuf', extensions: ['.proto'] },
  { id: 'csv', extensions: ['.csv', '.tsv'] },
];

export const ALL_TEXT_LANGUAGES = TEXT_LANGUAGES;

/**
 * Create a no-AST adapter that registers files and emits one synthetic
 * "file" symbol so they show up in search / list / get_source.
 */
export function createTextAdapter(def: TextLanguageDef): LanguageAdapter {
  return {
    id: def.id,
    extensions: def.extensions,
    vendorDirs: def.vendorDirs ?? [],
    resolveExts: [...def.extensions],
    indexFiles: [],

    async loadGrammar(): Promise<Parser.Language> {
      // Text adapters don't parse — never called in practice because parse()
      // below short-circuits. Throw so misuse is obvious.
      throw new Error(`Text adapter '${def.id}' has no grammar`);
    },

    async parse(source: string, filePath: string): Promise<ParseResult> {
      // Emit a single synthetic "module" symbol representing the file.
      // Line span covers the entire file so get_source works as expected.
      const lines = source.split('\n');
      const fileName = basename(filePath);
      const lineCount = lines.length;
      return {
        language: def.id,
        symbols: [
          {
            localIndex: 0,
            parentLocalIndex: null,
            name: fileName,
            kind: 'module',
            start_line: 1,
            end_line: lineCount,
            start_col: 0,
            end_col: lines[lines.length - 1]?.length ?? 0,
            signature: lines[0]?.slice(0, 200) ?? '',
            doc: null,
          },
        ],
        edges: [],
        imports: [],
      };
    },
  };
}
