@echo off
setlocal EnableDelayedExpansion

:: ============================================================================
:: synapse MCP — One-command setup for Windows
::
:: Usage:  .\setup.bat
::
:: What it does:
::   1. Checks Node.js >= 20 (installs via winget if missing)
::   2. Checks pnpm (installs via corepack if missing)
::   3. Installs dependencies (pnpm install)
::   4. Builds all packages
::   5. Globally links the CLI (synapse + synapse-mcp on PATH)
::   6. Creates .vscode/mcp.json so VS Code picks up the MCP server
::   7. Verifies installation
::
:: After setup, ANY workspace can use synapse by copying .vscode/mcp.json
:: or running:  synapse-mcp --root <path-to-your-repo>
:: ============================================================================

echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║   synapse MCP — One-Command Setup             ║
echo  ╚══════════════════════════════════════════════════╝
echo.

:: ─── Step 1: Check Node.js ─────────────────────────────────────────────────
echo [1/7] Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   Node.js not found. Installing via winget...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo   ERROR: Failed to install Node.js. Please install manually from https://nodejs.org
        exit /b 1
    )
    echo   Node.js installed. You may need to restart this terminal.
    echo   Please close this terminal, open a new one, and re-run setup.bat
    exit /b 0
)

:: Check Node.js version >= 20
for /f "tokens=1 delims=v." %%a in ('node --version') do set NODE_MAJOR=%%a
for /f "tokens=2 delims=v." %%a in ('node --version') do set NODE_MAJOR=%%a
node -e "if(parseInt(process.version.slice(1))<20){process.exit(1)}" >nul 2>&1
if %errorlevel% neq 0 (
    echo   ERROR: Node.js >= 20 required. Current: 
    node --version
    echo   Please update: winget upgrade OpenJS.NodeJS.LTS
    exit /b 1
)
echo   OK — Node.js found
node --version

:: ─── Step 2: Check pnpm ────────────────────────────────────────────────────
echo.
echo [2/7] Checking pnpm...
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo   pnpm not found. Installing via corepack...
    corepack enable
    corepack prepare pnpm@9.12.0 --activate
    where pnpm >nul 2>&1
    if %errorlevel% neq 0 (
        echo   Trying npm install...
        npm install -g pnpm@9
        if %errorlevel% neq 0 (
            echo   ERROR: Failed to install pnpm. Please install manually: npm i -g pnpm
            exit /b 1
        )
    )
)
echo   OK — pnpm found
pnpm --version

:: ─── Step 3: Install dependencies ──────────────────────────────────────────
echo.
echo [3/7] Installing dependencies...
cd /d "%~dp0"
pnpm install --frozen-lockfile 2>nul || pnpm install
if %errorlevel% neq 0 (
    echo   ERROR: pnpm install failed.
    exit /b 1
)
echo   OK — Dependencies installed

:: ─── Step 4: Build all packages ────────────────────────────────────────────
echo.
echo [4/7] Building packages...
pnpm -r build
if %errorlevel% neq 0 (
    echo   ERROR: Build failed. Check errors above.
    exit /b 1
)
echo   OK — Build complete

:: ─── Step 5: Global link ───────────────────────────────────────────────────
echo.
echo [5/7] Linking CLI globally (synapse + synapse-mcp)...

:: Ensure pnpm global bin dir exists (required for pnpm link --global)
if not defined PNPM_HOME (
    echo   Initializing pnpm global directory...
    pnpm setup >nul 2>&1
    :: Set PNPM_HOME for this session
    set "PNPM_HOME=%LOCALAPPDATA%\pnpm"
    set "PATH=!PNPM_HOME!;!PATH!"
)

cd /d "%~dp0\packages\cli"
pnpm link --global 2>nul
cd /d "%~dp0\packages\mcp-server"
pnpm link --global 2>nul
cd /d "%~dp0"

:: Verify the commands are available
where synapse-mcp >nul 2>&1
if %errorlevel% neq 0 (
    echo   NOTE: synapse-mcp not on PATH yet.
    echo   Adding pnpm global bin to PATH for this session...
    for /f "tokens=*" %%p in ('pnpm bin -g') do set "PATH=%%p;!PATH!"
)
echo   OK — Global commands linked

:: ─── Step 6: Create .vscode/mcp.json ───────────────────────────────────────
echo.
echo [6/7] Creating .vscode/mcp.json...
if not exist "%~dp0.vscode" mkdir "%~dp0.vscode"

:: Write the mcp.json for this workspace
(
echo {
echo   "servers": {
echo     "synapse": {
echo       "type": "stdio",
echo       "command": "synapse-mcp",
echo       "args": ["--root", "${workspaceFolder}"],
echo       "env": {}
echo     }
echo   }
echo }
) > "%~dp0.vscode\mcp.json"
echo   OK — .vscode/mcp.json created

:: ─── Step 7: Verify ────────────────────────────────────────────────────────
echo.
echo [7/7] Verifying installation...
where synapse-mcp >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   WARNING: synapse-mcp is not on PATH.
    echo   You may need to restart your terminal or add pnpm's global bin:
    for /f "tokens=*" %%p in ('pnpm bin -g') do echo     %%p
    echo.
    echo   Add this to your system PATH, then re-open VS Code.
) else (
    echo   synapse-mcp --version:
    synapse-mcp --version 2>nul || echo   (version flag pending)
    echo.
    echo   ╔══════════════════════════════════════════════════╗
    echo   ║   Setup complete!                                ║
    echo   ╠══════════════════════════════════════════════════╣
    echo   ║                                                  ║
    echo   ║   Commands available:                            ║
    echo   ║     synapse        — CLI (index, query, etc.)  ║
    echo   ║     synapse-mcp    — MCP server (stdio/http)   ║
    echo   ║                                                  ║
    echo   ║   VS Code:                                       ║
    echo   ║     .vscode/mcp.json is ready.                   ║
    echo   ║     Restart VS Code to activate the MCP server.  ║
    echo   ║                                                  ║
    echo   ║   For OTHER projects, copy .vscode/mcp.json      ║
    echo   ║   to that project's root.                        ║
    echo   ║                                                  ║
    echo   ╚══════════════════════════════════════════════════╝
)

echo.
pause
