#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# synapse MCP — One-command setup for macOS / Linux
#
# Usage:  chmod +x setup.sh && ./setup.sh
#
# What it does:
#   1. Checks Node.js >= 20 (guides installation if missing)
#   2. Checks pnpm (installs via corepack if missing)
#   3. Installs dependencies (pnpm install)
#   4. Builds all packages
#   5. Globally links the CLI (synapse + synapse-mcp on PATH)
#   6. Creates .vscode/mcp.json so VS Code picks up the MCP server
#   7. Verifies installation
#
# After setup, ANY workspace can use synapse by copying .vscode/mcp.json
# or running:  synapse-mcp --root <path-to-your-repo>
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║   synapse MCP — One-Command Setup             ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Check Node.js ─────────────────────────────────────────────────
echo "[1/7] Checking Node.js..."
if ! command -v node &>/dev/null; then
    echo "  ERROR: Node.js not found."
    echo "  Install Node.js >= 20:"
    echo "    macOS:  brew install node@20"
    echo "    Ubuntu: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    echo "    nvm:    nvm install 20"
    exit 1
fi

NODE_MAJOR=$(node -e "console.log(parseInt(process.version.slice(1)))")
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "  ERROR: Node.js >= 20 required. Current: $(node --version)"
    echo "  Upgrade: nvm install 20 / brew upgrade node"
    exit 1
fi
echo "  OK — Node.js $(node --version)"

# ─── Step 2: Check pnpm ────────────────────────────────────────────────────
echo ""
echo "[2/7] Checking pnpm..."
if ! command -v pnpm &>/dev/null; then
    echo "  pnpm not found. Installing via corepack..."
    corepack enable 2>/dev/null || true
    corepack prepare pnpm@9.12.0 --activate 2>/dev/null || npm install -g pnpm@9
fi
if ! command -v pnpm &>/dev/null; then
    echo "  ERROR: pnpm installation failed. Try: npm install -g pnpm"
    exit 1
fi
echo "  OK — pnpm $(pnpm --version)"

# ─── Step 3: Install dependencies ──────────────────────────────────────────
echo ""
echo "[3/7] Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
echo "  OK — Dependencies installed"

# ─── Step 4: Build all packages ────────────────────────────────────────────
echo ""
echo "[4/7] Building packages..."
pnpm -r build
echo "  OK — Build complete"

# ─── Step 5: Global link ───────────────────────────────────────────────────
echo ""
echo "[5/7] Linking CLI globally (synapse + synapse-mcp)..."

# Ensure pnpm global bin dir exists
if ! pnpm bin -g &>/dev/null; then
    echo "  Initializing pnpm global directory..."
    pnpm setup 2>/dev/null || true
    export PNPM_HOME="${HOME}/.local/share/pnpm"
    export PATH="$PNPM_HOME:$PATH"
fi

cd "$SCRIPT_DIR/packages/cli"
pnpm link --global 2>/dev/null || true
cd "$SCRIPT_DIR/packages/mcp-server"
pnpm link --global 2>/dev/null || true
cd "$SCRIPT_DIR"
echo "  OK — Global commands linked"

# ─── Step 6: Create .vscode/mcp.json ───────────────────────────────────────
echo ""
echo "[6/7] Creating .vscode/mcp.json..."
mkdir -p "$SCRIPT_DIR/.vscode"
cat > "$SCRIPT_DIR/.vscode/mcp.json" << 'EOF'
{
  "servers": {
    "synapse": {
      "type": "stdio",
      "command": "synapse-mcp",
      "args": ["--root", "${workspaceFolder}"],
      "env": {}
    }
  }
}
EOF
echo "  OK — .vscode/mcp.json created"

# ─── Step 7: Verify ────────────────────────────────────────────────────────
echo ""
echo "[7/7] Verifying installation..."
if command -v synapse-mcp &>/dev/null; then
    echo "  synapse-mcp: $(command -v synapse-mcp)"
    echo ""
    echo "  ╔══════════════════════════════════════════════════╗"
    echo "  ║   Setup complete!                                ║"
    echo "  ╠══════════════════════════════════════════════════╣"
    echo "  ║                                                  ║"
    echo "  ║   Commands available:                            ║"
    echo "  ║     synapse        — CLI (index, query, etc.)  ║"
    echo "  ║     synapse-mcp    — MCP server (stdio/http)   ║"
    echo "  ║                                                  ║"
    echo "  ║   VS Code:                                       ║"
    echo "  ║     .vscode/mcp.json is ready.                   ║"
    echo "  ║     Restart VS Code to activate the MCP server.  ║"
    echo "  ║                                                  ║"
    echo "  ║   For OTHER projects, copy .vscode/mcp.json      ║"
    echo "  ║   to that project's root.                        ║"
    echo "  ║                                                  ║"
    echo "  ╚══════════════════════════════════════════════════╝"
else
    GLOBAL_BIN=$(pnpm bin -g 2>/dev/null || echo "~/.local/share/pnpm")
    echo ""
    echo "  WARNING: synapse-mcp not on PATH."
    echo "  Add to your shell profile:"
    echo "    export PATH=\"$GLOBAL_BIN:\$PATH\""
    echo ""
    echo "  Then restart your terminal and VS Code."
fi
echo ""
