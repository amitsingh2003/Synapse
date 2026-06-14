/**
 * Phase 19.3 — LangGraph SynapseRetriever node.
 *
 * A retriever adapter that auto-picks the best synapse MCP tool based
 * on the query intent. Can be used as a LangGraph node, a LangChain retriever,
 * or a standalone utility.
 *
 * Usage with LangGraph (Python interop via JSON-RPC / HTTP):
 *   The MCP server already exposes all tools via JSON-RPC.
 *   This module provides a TypeScript-native retriever for Node.js agents.
 *
 * Usage:
 * ```ts
 * import { SynapseRetriever } from '@synapse/core';
 *
 * const retriever = new SynapseRetriever(db, { embeddingProvider });
 * const docs = await retriever.retrieve("how does auth work?");
 * ```
 */

import type { Database as DB } from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { hybridSearch, type HybridHit } from '../embeddings/search.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RetrievedDocument {
  /** Symbol name */
  name: string;
  /** Symbol kind */
  kind: string;
  /** File path */
  file: string;
  /** Line number */
  line: number;
  /** Signature if available */
  signature: string | null;
  /** Relevance score (0–1) */
  score: number;
  /** Which retrieval method found this */
  source: string;
}

export interface RetrieverOptions {
  /** Embedding provider for semantic search (optional). */
  embeddingProvider?: EmbeddingProvider | null;
  /** Max documents to return (default 10). */
  k?: number;
  /** Restrict to specific symbol kinds. */
  kinds?: string[];
  /** File glob filter. */
  fileGlob?: string;
}

// ─── Intent Classification ─────────────────────────────────────────────────

type QueryIntent = 'exact' | 'definition' | 'references' | 'semantic' | 'hybrid';

/**
 * Simple heuristic intent classifier.
 * For production use, an LLM would classify the intent.
 */
function classifyIntent(query: string): QueryIntent {
  const q = query.toLowerCase().trim();

  // Exact match: looks like a symbol name (PascalCase, camelCase, snake_case).
  if (/^[A-Z][a-zA-Z0-9]*$/.test(query) || /^[a-z][a-zA-Z0-9_]*$/.test(query)) {
    return 'exact';
  }

  // Natural language / semantic — longer queries go to hybrid/semantic first.
  if (q.split(/\s+/).length >= 5) {
    return 'semantic';
  }

  // Definition request (short: "where is X", "definition of X").
  if (/\b(where is|definition of|source of)\b/.test(q)) {
    return 'definition';
  }

  // Reference request.
  if (/\b(who (calls|uses|imports)|references to|callers of|usages of)\b/.test(q)) {
    return 'references';
  }

  // Default: hybrid (combines all strategies).
  return 'hybrid';
}

// ─── Retriever ─────────────────────────────────────────────────────────────

/**
 * SynapseRetriever — auto-picks the best retrieval strategy based on query.
 *
 * Integrates with LangGraph / LangChain via the standard `retrieve()` method.
 */
export class SynapseRetriever {
  private readonly db: DB;
  private readonly provider: EmbeddingProvider | null;
  private readonly defaultK: number;

  constructor(db: DB, opts: RetrieverOptions = {}) {
    this.db = db;
    this.provider = opts.embeddingProvider ?? null;
    this.defaultK = opts.k ?? 10;
  }

  /**
   * Retrieve relevant code symbols for a query.
   * Auto-classifies intent and picks the best strategy.
   */
  async retrieve(query: string, opts?: Partial<RetrieverOptions>): Promise<RetrievedDocument[]> {
    const k = opts?.k ?? this.defaultK;
    const intent = classifyIntent(query);

    switch (intent) {
      case 'exact':
        return this.exactLookup(query, k, opts);
      case 'definition':
        return this.definitionSearch(query, k, opts);
      case 'references':
        return this.referenceSearch(query, k, opts);
      case 'semantic':
      case 'hybrid':
      default:
        return this.hybridRetrieve(query, k, opts);
    }
  }

  /**
   * Get the classified intent for a query (for debugging/logging).
   */
  classifyIntent(query: string): QueryIntent {
    return classifyIntent(query);
  }

  private async exactLookup(
    query: string,
    k: number,
    _opts?: Partial<RetrieverOptions>,
  ): Promise<RetrievedDocument[]> {
    const rows = this.db
      .prepare(
        `SELECT s.name, s.kind, s.signature, s.start_line, f.path AS file
         FROM symbols s JOIN files f ON s.file_id = f.id
         WHERE s.name = ?
         LIMIT ?`,
      )
      .all(query, k) as Array<{ name: string; kind: string; signature: string | null; start_line: number; file: string }>;

    return rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.start_line,
      signature: r.signature,
      score: 1.0,
      source: 'exact',
    }));
  }

  private async definitionSearch(
    query: string,
    k: number,
    opts?: Partial<RetrieverOptions>,
  ): Promise<RetrievedDocument[]> {
    // Extract potential symbol name from the query.
    const nameMatch = query.match(/(?:definition of|find|locate|source of)\s+(\w+)/i);
    const name = nameMatch?.[1] ?? query.split(/\s+/).pop() ?? query;
    return this.exactLookup(name, k, opts);
  }

  private async referenceSearch(
    query: string,
    k: number,
    _opts?: Partial<RetrieverOptions>,
  ): Promise<RetrievedDocument[]> {
    // Extract potential symbol name from the query.
    const nameMatch = query.match(/(?:calls|uses|imports|references to|callers of|usages of)\s+(\w+)/i);
    const name = nameMatch?.[1] ?? query.split(/\s+/).pop() ?? query;

    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.name, s.kind, s.signature, s.start_line, f.path AS file
         FROM edges e
         JOIN symbols s ON s.id = e.source_id
         JOIN files f ON s.file_id = f.id
         WHERE e.target_name = ?
         LIMIT ?`,
      )
      .all(name, k) as Array<{ name: string; kind: string; signature: string | null; start_line: number; file: string }>;

    return rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.start_line,
      signature: r.signature,
      score: 0.9,
      source: 'references',
    }));
  }

  private async hybridRetrieve(
    query: string,
    k: number,
    opts?: Partial<RetrieverOptions>,
  ): Promise<RetrievedDocument[]> {
    const result = await hybridSearch(this.db, this.provider, {
      query,
      k,
      kind: opts?.kinds?.[0],
      fileGlob: opts?.fileGlob,
    });

    return result.hits.map((h: HybridHit) => ({
      name: h.name,
      kind: h.kind,
      file: h.file,
      line: h.line,
      signature: h.signature,
      score: h.score,
      source: h.source,
    }));
  }
}
