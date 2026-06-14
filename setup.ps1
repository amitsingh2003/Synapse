# ============================================================================
# synapse MCP — One-command setup (PowerShell)
#
# Usage:  .\setup.ps1
#         (If blocked by execution policy: Set-ExecutionPolicy -Scope Process Bypass)
#
# Equivalent to setup.bat but with better error handling for PowerShell users.
# ============================================================================

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║   synapse MCP — One-Command Setup             ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ─── Step 1: Check Node.js ─────────────────────────────────────────────────
Write-Host "[1/7] Checking Node.js..." -ForegroundColor Yellow
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "  Node.js not found. Installing via winget..." -ForegroundColor Red
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    Write-Host "  Please restart this terminal and re-run setup.ps1" -ForegroundColor Yellow
    exit 0
}
$nodeVer = (node -e "console.log(parseInt(process.version.slice(1)))" 2>$null)
if ([int]$nodeVer -lt 20) {
    Write-Host "  ERROR: Node.js >= 20 required. Current: $(node --version)" -ForegroundColor Red
    Write-Host "  Upgrade: winget upgrade OpenJS.NodeJS.LTS" -ForegroundColor Yellow
    exit 1
}
Write-Host "  OK — Node.js $(node --version)" -ForegroundColor Green

# ─── Step 2: Check pnpm ────────────────────────────────────────────────────
Write-Host ""
Write-Host "[2/7] Checking pnpm..." -ForegroundColor Yellow
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) {
    Write-Host "  pnpm not found. Installing..." -ForegroundColor Yellow
    try { corepack enable; corepack prepare pnpm@9.12.0 --activate }
    catch { npm install -g pnpm@9 }
}
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) {
    Write-Host "  ERROR: pnpm installation failed. Try: npm install -g pnpm" -ForegroundColor Red
    exit 1
}
Write-Host "  OK — pnpm $(pnpm --version)" -ForegroundColor Green

# ─── Step 3: Install dependencies ──────────────────────────────────────────
Write-Host ""
Write-Host "[3/7] Installing dependencies..." -ForegroundColor Yellow
pnpm install --frozen-lockfile 2>$null
if ($LASTEXITCODE -ne 0) { pnpm install }
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: pnpm install failed." -ForegroundColor Red
    exit 1
}
Write-Host "  OK — Dependencies installed" -ForegroundColor Green

# ─── Step 4: Build ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[4/7] Building packages..." -ForegroundColor Yellow
pnpm -r build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Build failed." -ForegroundColor Red
    exit 1
}
Write-Host "  OK — Build complete" -ForegroundColor Green

# ─── Step 5: Global link ───────────────────────────────────────────────────
Write-Host ""
Write-Host "[5/7] Linking CLI globally..." -ForegroundColor Yellow

# Ensure pnpm global bin dir exists
if (-not $env:PNPM_HOME) {
    Write-Host "  Initializing pnpm global directory..." -ForegroundColor Yellow
    pnpm setup 2>$null | Out-Null
    $env:PNPM_HOME = Join-Path $env:LOCALAPPDATA "pnpm"
    $env:PATH = "$env:PNPM_HOME;$env:PATH"
}

Push-Location "$ScriptDir\packages\cli"
pnpm link --global 2>$null
Pop-Location
Push-Location "$ScriptDir\packages\mcp-server"
pnpm link --global 2>$null
Pop-Location

# Ensure pnpm global bin is on PATH for this session
$globalBin = (pnpm bin -g 2>$null)
if ($globalBin -and ($env:PATH -notlike "*$globalBin*")) {
    $env:PATH = "$globalBin;$env:PATH"
}
Write-Host "  OK — Global commands linked" -ForegroundColor Green

# ─── Step 6: Create .vscode/mcp.json ───────────────────────────────────────
Write-Host ""
Write-Host "[6/7] Creating .vscode/mcp.json..." -ForegroundColor Yellow
$vsDir = Join-Path $ScriptDir ".vscode"
if (-not (Test-Path $vsDir)) { New-Item -ItemType Directory -Path $vsDir -Force | Out-Null }

$mcpJson = @'
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
'@
Set-Content -Path (Join-Path $vsDir "mcp.json") -Value $mcpJson -Encoding UTF8
Write-Host "  OK — .vscode/mcp.json created" -ForegroundColor Green

# ─── Step 7: Verify ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[7/7] Verifying installation..." -ForegroundColor Yellow
$mcpCmd = Get-Command synapse-mcp -ErrorAction SilentlyContinue
if ($mcpCmd) {
    $ver = synapse-mcp --version 2>$null
    Write-Host "  synapse-mcp v$ver" -ForegroundColor Green
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "  ║   Setup complete!                                ║" -ForegroundColor Green
    Write-Host "  ╠══════════════════════════════════════════════════╣" -ForegroundColor Green
    Write-Host "  ║                                                  ║" -ForegroundColor Green
    Write-Host "  ║   Commands available:                            ║" -ForegroundColor Green
    Write-Host "  ║     synapse        — CLI (index, query, etc.)  ║" -ForegroundColor Green
    Write-Host "  ║     synapse-mcp    — MCP server (stdio/http)   ║" -ForegroundColor Green
    Write-Host "  ║                                                  ║" -ForegroundColor Green
    Write-Host "  ║   VS Code:                                       ║" -ForegroundColor Green
    Write-Host "  ║     .vscode/mcp.json is ready.                   ║" -ForegroundColor Green
    Write-Host "  ║     Restart VS Code to activate the MCP server.  ║" -ForegroundColor Green
    Write-Host "  ║                                                  ║" -ForegroundColor Green
    Write-Host "  ║   For OTHER projects, copy .vscode/mcp.json      ║" -ForegroundColor Green
    Write-Host "  ║   to that project's root.                        ║" -ForegroundColor Green
    Write-Host "  ║                                                  ║" -ForegroundColor Green
    Write-Host "  ╚══════════════════════════════════════════════════╝" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "  WARNING: synapse-mcp not found on PATH." -ForegroundColor Yellow
    Write-Host "  Global bin: $globalBin" -ForegroundColor Yellow
    Write-Host "  Add it to your system PATH, then restart VS Code." -ForegroundColor Yellow
}
Write-Host ""
