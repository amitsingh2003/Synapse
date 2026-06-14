import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import Parser from 'web-tree-sitter';
import type { SubLanguage } from './language.js';

type TsLanguage = Parser.Language;

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, TsLanguage>();

/** Initialize the web-tree-sitter WASM runtime exactly once. */
export async function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  await initPromise;
}

/**
 * Logical grammar name → on-disk wasm file. Add a new entry whenever a new
 * `LanguageAdapter` is introduced. Callers should normally go through the
 * adapter rather than this module directly.
 */
const GRAMMAR_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  // Phase 21 — generic adapter grammars
  java: 'tree-sitter-java.wasm',
  c_sharp: 'tree-sitter-c_sharp.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  c: 'tree-sitter-c.wasm',
  rust: 'tree-sitter-rust.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  swift: 'tree-sitter-swift.wasm',
  php: 'tree-sitter-php.wasm',
  dart: 'tree-sitter-dart.wasm',
  scala: 'tree-sitter-scala.wasm',
  zig: 'tree-sitter-zig.wasm',
  lua: 'tree-sitter-lua.wasm',
  // Phase 22.1 — expanded grammar coverage (long tail)
  bash: 'tree-sitter-bash.wasm',
  elixir: 'tree-sitter-elixir.wasm',
  elm: 'tree-sitter-elm.wasm',
  ocaml: 'tree-sitter-ocaml.wasm',
  solidity: 'tree-sitter-solidity.wasm',
  ql: 'tree-sitter-ql.wasm',
  rescript: 'tree-sitter-rescript.wasm',
  objc: 'tree-sitter-objc.wasm',
  vue: 'tree-sitter-vue.wasm',
};

function grammarPath(name: string): string {
  const file = GRAMMAR_FILES[name];
  if (!file) throw new Error(`No bundled tree-sitter grammar for "${name}"`);
  return require.resolve(`tree-sitter-wasms/out/${file}`);
}

/**
 * Load (and cache) a tree-sitter Language by logical grammar name.
 * Accepts the TS-family `SubLanguage` alias as well as any other grammar id
 * declared in `GRAMMAR_FILES` (e.g. `'python'`, `'go'`).
 */
export async function loadLanguage(lang: SubLanguage | string): Promise<TsLanguage> {
  const cached = languageCache.get(lang);
  if (cached) return cached;
  await initParser();
  const bytes = await readFile(grammarPath(lang));
  const loaded = await Parser.Language.load(bytes);
  languageCache.set(lang, loaded);
  return loaded;
}

/** Create a parser already configured for the requested grammar. */
export async function createParser(lang: SubLanguage | string): Promise<Parser> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/**
 * Phase 16.3 — eagerly load every bundled grammar so the first call to
 * `parseSource` doesn't pay the WASM compile + I/O cost. Safe to call
 * multiple times (loadLanguage is cached). Failures for individual
 * grammars are swallowed; the missing one will fall back to lazy load.
 */
export async function preWarmParsers(): Promise<{ loaded: string[]; failed: string[] }> {
  await initParser();
  const loaded: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    Object.keys(GRAMMAR_FILES).map(async (name) => {
      try {
        await loadLanguage(name);
        loaded.push(name);
      } catch {
        failed.push(name);
      }
    }),
  );
  return { loaded, failed };
}

export type { TsLanguage };
