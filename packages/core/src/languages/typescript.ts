import type Parser from 'web-tree-sitter';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve as pathResolve, join, normalize, sep } from 'node:path';
import { loadLanguage } from '../parser/runtime.js';
import { parseSource } from '../parser/extract.js';
import { detectSubLanguage } from './detectSubLanguage.js';
import type { LanguageAdapter, ResolveCtx } from './types.js';
import type { ParseResult } from '../parser/extract.js';
import { loadTsProject, resolveViaTsPaths, resolveViaWorkspace } from './tsProject.js';

const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'] as const;

/**
 * The TypeScript-family adapter: covers `.ts`, `.tsx`, `.mts`, `.cts`,
 * `.js`, `.mjs`, `.cjs`, `.jsx`. Internally three tree-sitter grammars
 * (`typescript`, `tsx`, `javascript`) back this single logical adapter —
 * `loadGrammar` and `parse` dispatch by file extension.
 *
 * Phase 13: `resolveModule` now lives on the adapter, replicating the
 * relative-path + ext-probing logic that previously lived in `resolve.ts`.
 */
export const TypeScriptAdapter: LanguageAdapter = {
  id: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'],
  vendorDirs: ['node_modules'],
  resolveExts: RESOLVE_EXTS,
  indexFiles: INDEX_FILES,

  async loadGrammar(filePath: string): Promise<Parser.Language> {
    return loadLanguage(detectSubLanguage(filePath));
  },

  async parse(source: string, filePath: string): Promise<ParseResult> {
    return parseSource(source, detectSubLanguage(filePath));
  },

  resolveModule(spec: string, fromDir: string, ctx: ResolveCtx): string | null {
    // Phase 14.1 / 14.2 / 14.3 — try tsconfig paths, workspace packages, then
    // bare baseUrl. Each returns repo-relative path candidates we then probe
    // for a file match (with extension fallback / index.* expansion).
    if (!spec.startsWith('.') && !isAbsolute(spec)) {
      const project = loadTsProject(ctx.root);

      const wsHit = resolveViaWorkspace(project, spec, ctx.root);
      if (wsHit && ctx.filesByPath.has(wsHit)) return wsHit;
      if (wsHit) {
        const probed = probeCandidate(wsHit, ctx);
        if (probed) return probed;
        // Package entry points to compiled dist/ output — try the source src/ equivalent.
        if (wsHit.includes('/dist/')) {
          const srcHit = wsHit.replace('/dist/', '/src/');
          const probedSrc = probeCandidate(srcHit, ctx);
          if (probedSrc) return probedSrc;
        }
      }

      for (const cand of resolveViaTsPaths(project, spec, ctx.root)) {
        const probed = probeCandidate(cand, ctx);
        if (probed) return probed;
      }
      return null;
    }

    const joined = normRel(join(fromDir, spec));
    const stripped = joined.replace(/\.(?:js|jsx|mjs|cjs)$/, '');

    if (ctx.filesByPath.has(joined)) return joined;
    if (ctx.filesByPath.has(stripped)) return stripped;

    for (const ext of RESOLVE_EXTS) {
      const candidate = stripped + ext;
      if (ctx.filesByPath.has(candidate)) return candidate;
    }

    const absJoined = pathResolve(ctx.root, joined);
    const absStripped = pathResolve(ctx.root, stripped);
    if (safeIsDir(absStripped) || safeIsDir(absJoined)) {
      const dir = safeIsDir(absStripped) ? stripped : joined;
      for (const idx of INDEX_FILES) {
        const candidate = normRel(join(dir, idx));
        if (ctx.filesByPath.has(candidate)) return candidate;
      }
    }
    return null;
  },
};

/**
 * Given a repo-relative candidate path (with or without extension), probe
 * `filesByPath` for an exact match, an extension-stripped match, every
 * `.ts/.tsx/.js/.jsx/...` candidate, and a `/index.*` expansion.
 */
function probeCandidate(candidate: string, ctx: ResolveCtx): string | null {
  const norm = normRel(candidate);
  if (ctx.filesByPath.has(norm)) return norm;
  const stripped = norm.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  if (stripped !== norm && ctx.filesByPath.has(stripped)) return stripped;
  for (const ext of RESOLVE_EXTS) {
    const c = stripped + ext;
    if (ctx.filesByPath.has(c)) return c;
  }
  for (const idx of INDEX_FILES) {
    const c = normRel(join(stripped, idx));
    if (ctx.filesByPath.has(c)) return c;
  }
  return null;
}

function normRel(p: string): string {
  return normalize(p).split(sep).join('/').replace(/\/$/, '');
}

function safeIsDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
