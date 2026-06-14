<div align="center">

# 🔍 Synapse

### Your codebase. Fully understood. Zero waste.

**The structural code intelligence layer that makes AI assistants dramatically more accurate, efficient, and useful on real-world codebases.**

[![Tests](https://img.shields.io/badge/tests-261%20passing-brightgreen?style=flat-square)](.)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](.)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](.)
[![MCP](https://img.shields.io/badge/MCP-26%20tools-blueviolet?style=flat-square)](.)
[![Languages](https://img.shields.io/badge/languages-43-orange?style=flat-square)](.)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](.)

</div>

---

## 😤 The Problem

You have a large codebase. Your AI assistant doesn't.

Every time you start a new conversation — with Claude, Cursor, or any other AI — it starts **completely blind**. It has no idea what `CartService` does, who calls `validateEmail`, or whether there's a circular import hiding in your auth module. So you do what everyone does:

> You paste files. Lots of files.

And the problems stack up fast:

| Problem | Real Cost |
|---------|-----------|
| **Hallucinated symbol names** | AI invents functions that don't exist — you burn time chasing ghosts |
| **Pasting entire files for context** | 500-line files sent when you need 20 lines — tokens wasted, latency added |
| **Repeating architecture every session** | "Here's how our auth works…" — again, every time |
| **No dependency awareness** | AI can't know what breaking `getUser()` cascades into without being told |
| **Wrong answers at scale** | Beyond ~3 files, accuracy collapses without structured context |
| **No history awareness** | AI can't tell you who changed a function or why without git context |

The bigger your codebase, the worse all of this gets.

---

## 💡 The Solution

**Synapse indexes your entire codebase into a local SQLite graph** — every symbol, every call edge, every import, every embedding — and serves it to your AI through a **Model Context Protocol (MCP) server** with 26 precise tools.

Instead of pasting files, your AI *asks* for exactly what it needs:

```
AI: "What does CartService depend on?"

Without Synapse           │  With Synapse
────────────────────────────┼──────────────────────────────────
Developer manually locates  │  AI calls outgoing_calls("CartService")
and pastes cart.ts (400     │  Gets: 6 precise edges, file:line
lines) + cartService.ts     │  locations, resolved targets
(280 lines) into context    │  — in ~1 KB, under 100ms
~15,000 tokens consumed     │  ~300 tokens consumed
```

The result: **AI that works from ground truth, not guesswork.**

---

## 📉 Token Consumption — The Numbers

This is the core business case. Token costs are real. Context limits are real. Latency from giant prompts is real.

### Before Synapse

```
Developer asks: "Refactor CartService to support multiple currencies"

Step 1: Find relevant files (manual, ~5 min)
Step 2: Paste cart.ts          → ~8,000 tokens
Step 3: Paste cartService.ts   → ~6,000 tokens
Step 4: Paste product.ts       → ~4,000 tokens
Step 5: Explain dependencies   → ~1,000 tokens
                               ─────────────────
Total context load:             ~19,000 tokens
                               (before AI even responds)
```

### After Synapse

```
AI uses Synapse tools automatically:

explore_symbol("CartService")     → ~400 tokens  (definition + callers + callees)
find_references("CartService")    → ~200 tokens  (who depends on it)
get_source("cart.ts", 45, 92)     → ~300 tokens  (only the relevant lines)
outgoing_calls("CartService")     → ~150 tokens  (exact dependencies)
                                  ─────────────────
Total context load:                ~1,050 tokens
```

> **That's an 18× reduction in token consumption for this query.**
> At scale — across a team, across hundreds of sessions — this compounds into thousands of dollars saved per month.

### Why targeted queries beat file-pasting

| Scenario | File-paste tokens | Synapse tokens | Reduction |
|----------|:-----------------:|:----------------:|:---------:|
| Find where a function is defined | ~5,000 (whole file) | ~50 (`find_symbol`) | **100×** |
| Understand a class's dependencies | ~15,000 (3 files) | ~600 (`explore_symbol`) | **25×** |
| Check who uses an API | ~20,000 (search manually) | ~200 (`find_references`) | **100×** |
| Trace a call chain 3 levels deep | ~40,000 (many files) | ~800 (`call_hierarchy`) | **50×** |
| Find a bug by pattern | ~30,000 (manual search) | ~400 (`grep_code`) | **75×** |

---

## 🎯 Why Synapse

### ✅ Ground truth, not guesswork

Synapse reads your actual parsed AST. Every symbol location, every call edge, every import binding comes from the real code — not from a language model's training data. **No hallucinated function names. No wrong file paths. No invented APIs.**

### ✅ AI that understands your architecture

The call graph tells the full story: what calls what, what imports what, what's dead, what's a hub. Your AI can answer architectural questions — circular imports, dependency chains, hub identification — that are impossible without this structure.

### ✅ Works across your entire codebase, instantly

43 languages. Every file indexed. Cross-file references resolved. Semantic search via local embeddings. Whether your repo has 100 files or 100,000, the AI always has an index — not a partial, hallucinated memory.

### ✅ Fully local — zero data exposure

Everything runs on your machine. The SQLite database lives in your repo. No code is sent to any server. Embedding inference runs locally via Transformers.js. This matters for enterprise codebases, proprietary code, and compliance requirements.

### ✅ Persistent intelligence

Index once. Query forever. The incremental indexer detects file changes via xxhash and only re-parses what changed. Your AI doesn't need a "warm-up" monologue about your codebase every session — the graph is always ready.

### ✅ Compatible with any MCP client

Works with Claude Desktop, Cursor, VS Code, and any editor that supports MCP. One index, any client.

---

## 🚀 Quick Start

```bash
# 1. Install
git clone <repo-url> && cd synapse
./setup.sh          # macOS / Linux
./setup.ps1         # Windows

# 2. Index your project (one time, incremental after that)
synapse init /path/to/your/repo

# 3. Connect to your AI client
synapse configure /path/to/your/repo

# 4. (Optional) Enable semantic search — 23 MB one-time download
synapse embed /path/to/your/repo

# Done. Open your AI client and ask about your code.
```

---

## 🛠️ Tech Stack

<table>
<tr><th>Layer</th><th>Technology</th><th>Why This Choice</th></tr>
<tr>
  <td><strong>Runtime</strong></td>
  <td>Node.js 20+ · TypeScript 5</td>
  <td>Native ESM, strong typing, broad ecosystem compatibility</td>
</tr>
<tr>
  <td><strong>Database</strong></td>
  <td>SQLite · better-sqlite3 · WAL mode</td>
  <td>Zero-dependency, file-local, concurrent reads, FTS5 built-in</td>
</tr>
<tr>
  <td><strong>Parsing</strong></td>
  <td>tree-sitter + language grammars</td>
  <td>Incremental AST parsing for 43 languages, production-grade</td>
</tr>
<tr>
  <td><strong>Protocol</strong></td>
  <td>@modelcontextprotocol/sdk</td>
  <td>Official MCP SDK — stdio + HTTP Streamable transport</td>
</tr>
<tr>
  <td><strong>Embeddings</strong></td>
  <td>@xenova/transformers (Transformers.js)</td>
  <td>Run ONNX models locally in Node.js — no Python, no server</td>
</tr>
<tr>
  <td><strong>Structural search</strong></td>
  <td>@ast-grep/napi</td>
  <td>AST-aware code pattern matching — understands code, not just text</td>
</tr>
<tr>
  <td><strong>Fast grep</strong></td>
  <td>ripgrep (rg) — streaming via spawn()</td>
  <td>Rust + SIMD + parallel I/O; async streaming, non-blocking, no buffer cap</td>
</tr>
<tr>
  <td><strong>Security scan</strong></td>
  <td>semgrep</td>
  <td>OWASP Top 10, secrets, language-specific rule packs</td>
</tr>
<tr>
  <td><strong>Full-text search</strong></td>
  <td>SQLite FTS5 (trigram tokenizer)</td>
  <td>Sub-millisecond symbol lookup and grep pre-filtering in the same DB</td>
</tr>
<tr>
  <td><strong>Change detection</strong></td>
  <td>xxhash</td>
  <td>Near-zero-cost file change detection — skips unchanged files instantly</td>
</tr>
<tr>
  <td><strong>Monorepo build</strong></td>
  <td>pnpm workspaces + tsup</td>
  <td>Fast installs, isolated packages, ESM-first bundling</td>
</tr>
<tr>
  <td><strong>Testing</strong></td>
  <td>Vitest — 261 tests, 30 files</td>
  <td>Native ESM support, fast hot reload, snapshot testing</td>
</tr>
<tr>
  <td><strong>Containers</strong></td>
  <td>Docker (Node 22 slim, multi-stage)</td>
  <td>Minimal attack surface, non-root runtime user</td>
</tr>
<tr>
  <td><strong>CI/CD</strong></td>
  <td>GitHub Actions</td>
  <td>Index on push, hash-based DB cache, PR API diff comments</td>
</tr>
</table>

---

## 📦 Installation

**Requirements:** Node.js ≥ 20, pnpm 9.12+

<details>
<summary><strong>macOS / Linux</strong></summary>

```bash
git clone <repo-url>
cd synapse
./setup.sh
```

</details>

<details>
<summary><strong>Windows (PowerShell)</strong></summary>

```powershell
git clone <repo-url>
cd synapse
./setup.ps1
```

</details>

<details>
<summary><strong>Windows (Batch)</strong></summary>

```bat
git clone <repo-url>
cd synapse
setup.bat
```

</details>

The setup script handles everything: verifies Node ≥ 20, installs pnpm 9.12 via corepack, builds all packages, links `synapse` + `synapse-mcp` globally, and writes `.vscode/mcp.json`.

<details>
<summary><strong>Manual VS Code / MCP client config</strong></summary>

```json
{
  "servers": {
    "synapse": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${workspaceFolder}/packages/mcp-server/dist/bin.js",
        "--root", "${workspaceFolder}",
        "--db",  "${workspaceFolder}/.synapse/graph.db"
      ]
    }
  }
}
```

</details>

---

## 💻 CLI Reference

```
synapse <command> [options]
```

| Command | Description |
|---------|-------------|
| `init [root]` | 🏗️  Index a repo — skips unchanged files via xxhash |
| `reindex [root]` | 🔄  Force full re-index (ignores hash cache) |
| `watch [root]` | 👁️  Incremental indexer — re-parses files on save |
| `embed [root]` | 🧠  Generate vector embeddings for semantic search |
| `configure [root]` | ⚙️  Write config + MCP client snippets |
| `doctor [root]` | 🩺  Diagnose Node, DB, MCP binary |
| `compact` | 🗜️  VACUUM + ANALYZE the DB |
| `diff <base> [head]` | 📊  Changed public APIs between git refs |
| `import-scip <file>` | 📥  Ingest a SCIP JSON index |
| `query <name>` | 🔎  Look up symbols by name |
| `refs <name>` | 📌  Every reference to a symbol |
| `stats` | 📈  File / symbol / edge counts |
| `ping` | ✅  Sanity check |

<details>
<summary><strong>Global flags</strong></summary>

| Flag | Default | Description |
|------|---------|-------------|
| `--db <path>` | `./.synapse/graph.db` | Override DB path |
| `--concurrency <n>` | `8` | Parallel file workers (init/reindex) |
| `--languages <csv>` | all | Restrict to specific adapter IDs |
| `--debounce <ms>` | `250` | Watch mode debounce window |
| `--skip-initial` | — | Watch: skip up-front full-repo index |
| `--client <name>` | — | configure: `claude`, `cursor`, or `generic` |
| `--print` | — | configure: print snippet only, skip writing |
| `--limit <n>` | — | query/refs: max results |
| `--json` | — | stats: emit JSON |
| `--verbose` | — | init/reindex: print parse-error file paths |

</details>

---

## 🔄 Keeping the Index Fresh — 3 Sync Modes

Synapse has three distinct modes for handling codebase changes. You don't need all three — pick what fits your workflow.

### Mode 1 — `synapse init` (on-demand)

Run once, or re-run whenever you want a manual refresh.

```bash
synapse init /path/to/repo
```

- Computes an **xxhash** for every file on disk
- Compares against stored hashes in SQLite — **skips unchanged files instantly**
- Re-parses AST only for new or modified files
- Run `synapse reindex` instead to force a full re-parse (ignores hash cache)

> Typical re-run on a large repo: a few seconds, not minutes.

---

### Mode 2 — `synapse watch` (live, manual)

Long-running process in a terminal. Keeps the DB warm as you code.

```bash
synapse watch /path/to/repo
```

- Does one full incremental index on startup (same as `init`)
- Then starts a **chokidar** file watcher — reacts to every save/create/delete
- Debounced — rapid saves don't trigger a parse storm (default 250 ms)

What it logs on each event:

```
[+] src/cart.ts        12 sym / 34 edge  (43ms)   ← file changed/added
[-] src/old.ts                                     ← file deleted → symbols removed
[r] resolved 5 imports + 12 edges  (8ms)           ← cross-file references re-resolved
```

Deleted files are **fully cleaned up** — all their symbols are removed and incoming edges are nulled.

---

### Mode 3 — MCP server auto-sync (always-on, zero config)

No command needed. This runs automatically every time the MCP server starts (i.e., when VS Code loads it).

**What it does, in order:**

1. **Lock check** — tries to acquire a file lock. If another MCP instance is already watching → silently backs off (avoids duplicate watchers)
2. **Crash recovery** — if a previous index run crashed mid-way (`indexing=true` left in the manifest) → forces a clean full reindex automatically
3. **HEAD check** — compares the current git `HEAD` to `last_indexed_head` in the DB. If HEAD changed (you pulled, switched branches, rebased) → triggers an incremental reindex before serving any tool calls
4. **Chokidar watcher** — starts the same live watcher as Mode 2 in the background

> This is why you never need to manually re-run `init` after switching branches. The MCP server catches the HEAD change on next startup and reindexes silently.

---

### Which mode should you use?

| Situation | Recommended |
|-----------|-------------|
| First-time setup | `synapse init` |
| Active development session | `synapse watch` |
| Already using the MCP server in VS Code | **nothing** — auto-sync handles it |
| After a large branch switch or rebase | **nothing** — auto-sync detects HEAD change |
| CI / pre-commit hook | `synapse init` |

---

## 🔌 MCP Server

26 tools and 3 resources over **stdio** (default) or **HTTP**.

```bash
# stdio — VS Code / Claude Desktop
node packages/mcp-server/dist/bin.js \
  --root /path/to/repo \
  --db   /path/to/repo/.synapse/graph.db

# HTTP — remote, containerized, or shared deployments
node packages/mcp-server/dist/bin.js \
  --root      /path/to/repo \
  --db        /path/to/repo/.synapse/graph.db \
  --transport http --port 4000 --host 0.0.0.0 \
  --token     "$CODEGRAPH_TOKEN" \
  --redact-paths
```

<details>
<summary><strong>HTTP transport options</strong></summary>

| Flag | Default | Description |
|------|---------|-------------|
| `--transport` | `stdio` | `stdio` or `http` |
| `--port` | `4000` | Listen port |
| `--host` | `127.0.0.1` | Bind address |
| `--token <secret>` | — | Bearer token auth (timing-safe comparison) |
| `--redact-paths` | — | Strip home dir and username from all responses |

- `GET /healthz` → `{ ok: true, sessions: N }`
- Stateful sessions via `mcp-session-id` header
- CORS restricted to localhost when auth is enabled
- Request body limit: 10 MB

</details>

---

## 🧰 MCP Tools (26)

### 🏷️ Symbol Lookup — *Find anything in your codebase instantly*

| Tool | What it answers | Token saving vs. manual |
|------|----------------|------------------------|
| `find_symbol` | Where is `X` defined? File, line, signature | ~100× |
| `get_definition` | Canonical definition of `X` | ~100× |
| `search_symbols` | Which symbols match `auth*`? Wildcard + kind/language/glob filters + "did you mean?" hints | ~50× |
| `list_symbols_in_file` | Everything defined in `src/cart.ts` | ~10× |
| `verify_symbol` | Is this AI-generated reference actually valid? 0–1 confidence score | prevents hallucination loops |

### 🔗 Call Graph — *Understand dependencies without reading files*

| Tool | What it answers | Token saving vs. manual |
|------|----------------|------------------------|
| `find_references` | Who calls / imports / extends `X`? | ~100× |
| `outgoing_calls` | What does `X` depend on? | ~50× |
| `call_hierarchy` | Full BFS traversal — incoming or outgoing, configurable depth | ~1000× |
| `explore_symbol` | Definition + source + callers + callees — **everything in one call** | ~25× |
| `top_symbols` | What are the architectural hubs? (fan-in + fan-out ranking) | unique insight |

### 🔎 Code Search — *Grep smarter, not broader*

| Tool | What it does | Why it saves tokens |
|------|-------------|-------------------|
| `grep_code` | Regex/fixed-string search — ripgrep → FTS5 → disk, auto-fallback | Returns only matches + context, not whole files |
| `structural_search` | AST-pattern: `console.log($ARGS)` matches any formatting | No false positives from comments or strings |
| `hybrid_search` | Exact → FTS5 trigram → fuzzy → semantic — Reciprocal Rank Fusion | Best result without AI guessing where to look |
| `semantic_search` | "function that validates email" — finds by meaning, not name | Eliminates exploratory file-reading |
| `find_imports` | Who imports `"react-query"` or `"./utils/cart"`? | Targeted import graph query |

### 📊 Source & Metrics — *Get exactly the lines you need*

| Tool | Token efficiency |
|------|-----------------|
| `get_source` | Read only the line range that matters — not the whole file |
| `get_stats` | Aggregate counts in ~50 tokens instead of reading the whole DB |
| `index_status` | Health check, drift detection, git HEAD — instant summary |
| `code_metrics` | Per-file complexity — identify hotspots without manual review |
| `find_dead_code` | Remove dead code confidently — no guessing |

### 📜 Git History — *Context that lives outside the code*

| Tool | Value |
|------|-------|
| `git_log` | Why was this function changed? Who touched it last? |
| `git_blame` | Who wrote this line and in what commit? |

### 🏗️ Architecture & Security — *Systemic insight*

| Tool | Value |
|------|-------|
| `detect_cycles` | Find circular imports before they cause runtime bugs (Tarjan's SCC) |
| `reindex_file` | Update one file's graph atomically — no full re-index needed |
| `scan_security` | OWASP Top 10, secrets, language-specific rules via semgrep |
| `read_offloaded` | Auto-retrieve large payloads offloaded beyond the 8 KB threshold |

### 📂 Resources (3)

| URI | Returns |
|-----|---------|
| `synapse://stats` | Repo-wide counts and DB size as JSON |
| `synapse://files` | Every indexed file path, newline-delimited |
| `synapse://status` | Schema version, counts, last-indexed time, drift hint |

---

## 🔍 `grep_code` — Smart Three-Backend Chain

```
  grep_code("pattern")
       │
       ├──► 1. ripgrep (rg)      Rust + SIMD + parallel I/O
       │         ↓ not found / not installed
       ├──► 2. SQLite FTS5       trigram pre-filter → JS regex (no disk I/O)
       │         ↓ no content stored
       └──► 3. Disk scan         readFileSync + JS RegExp (always works)

  All three return: file · line · col · match text · context lines · enclosing symbol
```

The ripgrep backend streams output asynchronously via `spawn()` + readline — **the event loop is never blocked** and there is no memory buffer cap, making it safe for very large repos.

---

## 🧠 Semantic & Hybrid Search

### Default: Transformers.js — 100% local, zero server

```bash
synapse embed /path/to/repo   # ~23 MB one-time download, fully cached after
```

| | |
|-|-|
| **Model** | `Xenova/all-MiniLM-L6-v2` |
| **Dimensions** | 384 |
| **Quantization** | INT8 |
| **Download** | ~23 MB (one-time) |
| **Requires server** | ❌ No |
| **Package** | `@xenova/transformers` (bundled) |

### Alternative: Ollama

```bash
ollama serve
synapse embed /path/to/repo --provider ollama --model nomic-embed-text
```

| | |
|-|-|
| **Default model** | `nomic-embed-text` |
| **URL** | `http://127.0.0.1:11434` |
| **Requires server** | ✅ Yes |

Once embeddings exist, `semantic_search` and `hybrid_search` use them automatically.

---

## 🌐 Language Support

### 🥇 Tier 1 — Full adapters (7 languages)
Symbols · call edges · import resolution · cross-file linking · SCIP-stable IDs

| Language | Extensions |
|----------|------------|
| TypeScript | `.ts` `.tsx` `.mts` `.cts` |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` |
| Python | `.py` `.pyi` |
| Go | `.go` |
| Java | `.java` |
| C# | `.cs` |

### 🥈 Tier 2 — Generic adapters (20 languages)
AST + call tracking · no per-language module resolution

`C++` `Rust` `Ruby` `Kotlin` `Swift` `PHP` `Dart` `Scala` `Zig` `Lua` `Bash` `Elixir` `Elm` `OCaml` `Solidity` `Objective-C` `Vue` `ReScript` and more

### 🥉 Tier 3 — Text-only (16 languages)
File-level symbols · no AST

`Markdown` `JSON` `YAML` `TOML` `SQL` `XML` `HTML` `CSS` `GraphQL` `Protobuf` `.env` `Dockerfile` and more

> **43 languages · 100+ file extensions**

---

## 🗄️ Database Design

SQLite · WAL mode · Schema v9 · Dual connection handles (read-only `db` + write-on-demand `wdb`)

| Table | Purpose |
|-------|---------|
| `files` | Indexed files: path, language, xxhash, mtime, `indexed_at` |
| `symbols` | Definitions: SCIP IDs, kind, line range, signature, doc |
| `edges` | Call/reference edges: `source_id → target_name / target_id`, kind, location |
| `file_imports` | Import bindings: specifier, `resolved_file_id`, `import_kind` (value \| type) |
| `manifest` | Key-value: `schema_version`, `repo_root` |
| `symbols_fts` | FTS5 trigram index for symbol name search |
| `symbol_embeddings` | Dense vectors: `symbol_id`, BLOB, model, `embedded_at` |
| `file_content` | Raw source per file (grep backend 2) |
| `file_content_fts` | FTS5 trigram index for grep pre-filtering |

> **Cross-file edge invariant:** `edges.target_id` has `ON DELETE CASCADE`. Before deleting symbols during reindex, Synapse nulls out incoming cross-file edges first — edges survive, and the resolver re-links them on the next pass.

---

## 🏛️ Architecture

```
┌───────────────────────────────────────────────────────────┐
│                      AI Assistant                          │
│           (Claude · Cursor · any MCP client)               │
│                                                            │
│  "What breaks if I refactor CartService?"                  │
│       ↓ AI calls find_references + call_hierarchy          │
└──────────────────────────┬────────────────────────────────┘
                           │  MCP (stdio or HTTP)
┌──────────────────────────▼────────────────────────────────┐
│                      MCP Server                            │
│    26 tools · 3 resources · 8 KB auto-offload threshold    │
└──────────────────────────┬────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────┐
│                    @synapse/core                         │
│                                                            │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │   Indexer   │  │   Resolver   │  │   Embeddings    │   │
│  │ tree-sitter │  │ cross-file   │  │ Transformers.js │   │
│  │ 43 languages│  │ edges + BFS  │  │   or Ollama     │   │
│  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘   │
│         └───────────────┬┘                   │            │
│                         └───────────────────-┘            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │          SQLite · WAL mode · Schema v9               │  │
│  │  files · symbols · edges · file_imports · manifest   │  │
│  │  symbols_fts · symbol_embeddings                     │  │
│  │  file_content · file_content_fts                     │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

**Design decisions that matter:**

| Decision | Why |
|----------|-----|
| **SCIP-stable symbol IDs** | Portable, path-relative IDs survive file renames |
| **Barrel re-export BFS** | Resolves re-exported names through up to 3 levels of `index.ts` barrel files |
| **Async streaming grep** | `spawn()` + readline — never blocks event loop, no 20 MB buffer cap |
| **Dual DB handles** | Concurrent reads never wait for writes; WAL checkpoint on write close |
| **8 KB offload** | Large responses written to temp files; AI retrieves only if needed — keeps MCP stream lean |
| **xxhash change detection** | Near-zero-cost file diffing — only changed files are re-parsed |

---

## 🔧 External Dependencies

All optional. Synapse degrades gracefully.

| Tool | Used By | Install | Fallback |
|------|---------|---------|---------|
| **ripgrep** (`rg`) | `grep_code` backend 1 | `brew install ripgrep` · `apt install ripgrep` · [releases](https://github.com/BurntSushi/ripgrep/releases) | FTS5 + disk scan |
| **semgrep** | `scan_security` | `pip install semgrep` | Tool returns descriptive error |
| **ast-grep** | `structural_search` | Bundled via `@ast-grep/napi` — no install needed | — |
| **git** | `git_log`, `git_blame` | Must be on PATH | Tools return descriptive error |
| **Ollama** | `embed --provider=ollama` | [ollama.ai](https://ollama.ai) | Use default Transformers.js (no server) |

---

## ⚙️ GitHub Action

Index on every push, comment API diffs on PRs — keep your AI's index always current:

```yaml
- uses: ./
  with:
    languages: typescript,python
    db-path: .synapse/graph.db
    comment-on-pr: true
    base-ref: ${{ github.base_ref }}
```

**Outputs:** `files-indexed` · `symbols-count` · `api-changes` · `db-path`

The DB is cached by source-file hash — incremental runs re-parse only what changed.

---

## 🐳 Docker

```bash
docker build -t synapse .

docker run -p 4000:4000 \
  -v /path/to/repo:/repo:ro \
  -v /path/to/data:/data \
  synapse \
    --db /data/graph.db --root /repo \
    --transport http --host 0.0.0.0 --port 4000 \
    --token "$CODEGRAPH_TOKEN"
```

Multi-stage build (Node 22 slim). Non-root `synapse` user in the runtime stage.

---

## 🧪 Development

```
packages/
  core/        @synapse/core       — indexer, resolver, DB, embeddings
  mcp-server/  @synapse/mcp-server — MCP server, HTTP transport, all 26 tools
  cli/         @synapse/cli        — CLI commands
fixtures/
  sample-shopping-app/               — TypeScript fixture used by all tests
```

```bash
pnpm install           # install dependencies
pnpm -r build          # build all packages
pnpm -r test           # 261 tests across 30 files
pnpm -r test --watch   # watch mode
```

**Test coverage:** indexing · cross-file resolution · all 26 MCP tools · HTTP transport · Bearer auth · path redaction · Transformers.js embeddings · three grep backends · SCIP ingestor · cycle detection

---

<div align="center">

## The Bottom Line

> Without Synapse, your AI is reading your codebase **one pasted file at a time.**
> With Synapse, it queries a **complete, structured graph** — and uses a fraction of the tokens to do it.

**Less context waste. Fewer hallucinations. Faster answers. Better code.**

---

*100% local · No cloud · No telemetry · Works with any MCP client*

</div>
