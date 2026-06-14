# Phase 17.6 — Containerised synapse MCP server
#
# Multi-stage build:
#  1. `builder` — install all workspace deps with pnpm and run `pnpm -r build`.
#                 Includes Python + build-essential so better-sqlite3 native
#                 bindings compile.
#  2. `runtime` — slim Node image with only the built artifacts and
#                 production dependencies (better-sqlite3 + MCP SDK + wasm
#                 grammars). Listens on HTTP by default; the operator
#                 supplies a graph DB via a bind mount.
#
# Usage:
#   docker build -t synapse .
#   docker run --rm -p 4000:4000 \
#       -v /path/to/repo:/repo:ro \
#       -v /path/to/synapse:/data \
#       synapse --db /data/graph.db --root /repo \
#                 --transport http --host 0.0.0.0 --port 4000 \
#                 --token "$CODEGRAPH_TOKEN"
#
# Then point your client at http://<host>:4000/mcp with
#   Authorization: Bearer $CODEGRAPH_TOKEN

# -----------------------------------------------------------------------------
# 1) Builder
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

# Tools needed to compile better-sqlite3 + clone tree-sitter grammars.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /build

# Copy lockfile + workspace manifests first for layer cacheability.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json        packages/core/package.json
COPY packages/mcp-server/package.json  packages/mcp-server/package.json
COPY packages/cli/package.json         packages/cli/package.json

RUN pnpm install --frozen-lockfile

# Copy sources and build all workspace packages.
COPY tsconfig.base.json ./
COPY packages ./packages
COPY fixtures ./fixtures

RUN pnpm -r build

# Prune dev deps so we can copy only the runtime closure.
RUN pnpm -r --prod deploy /out/core        --filter @synapse/core \
 && pnpm -r --prod deploy /out/mcp-server  --filter @synapse/mcp-server \
 && pnpm -r --prod deploy /out/cli         --filter @synapse/cli

# -----------------------------------------------------------------------------
# 2) Runtime
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="synapse"
LABEL org.opencontainers.image.description="Local-first code intelligence MCP server"
LABEL org.opencontainers.image.source="https://example.invalid/synapse"

# Run as non-root.
RUN groupadd --system synapse \
 && useradd  --system --gid synapse --home-dir /home/synapse --create-home synapse

WORKDIR /app

COPY --from=builder --chown=synapse:synapse /out/mcp-server /app/mcp-server
COPY --from=builder --chown=synapse:synapse /out/cli        /app/cli
COPY --from=builder --chown=synapse:synapse /out/core       /app/core

USER synapse

# Default HTTP port; override with --port at runtime.
EXPOSE 4000

# `--host 0.0.0.0` so the listener is reachable outside the container.
# The DB path is left for the operator to supply via `-v /data:/data` and
# `--db /data/graph.db`. Healthcheck pings /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/mcp-server/dist/bin.js"]
CMD ["--transport", "http", "--host", "0.0.0.0", "--port", "4000"]
