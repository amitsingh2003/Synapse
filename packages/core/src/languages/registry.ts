import type { LanguageAdapter } from './types.js';
import { TypeScriptAdapter } from './typescript.js';
import { PythonAdapter } from './python.js';
import { GoAdapter } from './go.js';
import { ALL_GENERIC_LANGUAGES, createGenericAdapter } from './generic.js';
import { ALL_TEXT_LANGUAGES, createTextAdapter } from './text.js';

/**
 * Adapter registry. Built-in adapters (TypeScript, Python, Go) register on
 * module load; additional adapters can be added via `registerAdapter`.
 *
 * Lookup is by file extension (lowercase, leading dot). First adapter wins
 * — registration order determines precedence if two adapters ever claim the
 * same extension (none do today).
 */
const adapters: LanguageAdapter[] = [];
const byExtension = new Map<string, LanguageAdapter>();
const byId = new Map<string, LanguageAdapter>();

export function registerAdapter(adapter: LanguageAdapter): void {
  adapters.push(adapter);
  byId.set(adapter.id, adapter);
  for (const ext of adapter.extensions) {
    const key = ext.toLowerCase();
    if (!byExtension.has(key)) byExtension.set(key, adapter);
  }
}

export function getAdapterForFile(path: string): LanguageAdapter | null {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return byExtension.get(lower.slice(dot)) ?? null;
}

export function getAdapterById(id: string): LanguageAdapter | null {
  return byId.get(id) ?? null;
}

export function getAllAdapters(): readonly LanguageAdapter[] {
  return adapters;
}

/**
 * Phase 22.4 — Indexing tier classification.
 *
 * - Tier 1: hand-tuned adapter with module resolution and full extract.ts
 *   walker (TypeScript/TSX/JavaScript, Python, Go).
 * - Tier 2: generic declarative adapter with AST symbols + call tracking
 *   but no per-language module resolution (Java, Rust, C++, etc.).
 * - Tier 3: text-only registration — no AST, file appears in search/list
 *   and contributes to FTS / semantic search (Markdown, JSON, YAML, …).
 *
 * The classification drives `index_status` reporting so users can see at a
 * glance how their codebase is being analysed.
 */
export type IndexTier = 1 | 2 | 3;

const TIER_1_IDS: ReadonlySet<string> = new Set(['typescript', 'tsx', 'javascript', 'python', 'go', 'java', 'csharp']);
const TIER_3_IDS: ReadonlySet<string> = new Set(ALL_TEXT_LANGUAGES.map((d) => d.id));

export function getTierForLanguage(languageId: string): IndexTier {
  if (TIER_1_IDS.has(languageId)) return 1;
  if (TIER_3_IDS.has(languageId)) return 3;
  return 2;
}

/** Group a per-language count map into a tier breakdown. */
export function groupByTier(
  counts: Readonly<Record<string, number>>,
): { tier1: number; tier2: number; tier3: number; byTier: Record<IndexTier, Record<string, number>> } {
  const byTier: Record<IndexTier, Record<string, number>> = { 1: {}, 2: {}, 3: {} };
  let tier1 = 0;
  let tier2 = 0;
  let tier3 = 0;
  for (const [lang, n] of Object.entries(counts)) {
    const tier = getTierForLanguage(lang);
    byTier[tier][lang] = n;
    if (tier === 1) tier1 += n;
    else if (tier === 2) tier2 += n;
    else tier3 += n;
  }
  return { tier1, tier2, tier3, byTier };
}

/** Test hook — wipe the registry so a custom set can be installed. */
export function _resetRegistry(): void {
  adapters.length = 0;
  byExtension.clear();
  byId.clear();
}

// Bootstrap built-in adapters.
// Premium adapters (with module resolution) take precedence.
registerAdapter(TypeScriptAdapter);
registerAdapter(PythonAdapter);
registerAdapter(GoAdapter);

// Phase 21 — Register generic adapters for all remaining languages.
// These provide symbol extraction + call tracking without custom module resolution.
for (const def of ALL_GENERIC_LANGUAGES) {
  registerAdapter(createGenericAdapter(def));
}

// Phase 22.2 — Register text-only "tier 3" adapters last.
// They handle docs, configs, and data files that have no AST grammar
// but should still be indexed for full-text and semantic search.
for (const def of ALL_TEXT_LANGUAGES) {
  registerAdapter(createTextAdapter(def));
}
