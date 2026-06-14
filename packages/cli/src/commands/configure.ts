import { resolve } from 'node:path';
import { DEFAULT_CONFIG, readConfig, writeConfig, configPath } from '../config.js';

export interface ConfigureOpts {
  root?: string;
  dbPath?: string;
  /** Which MCP client snippet to print: 'claude' | 'cursor' | 'generic'. */
  client?: string;
  /** Skip writing the config file (just print MCP snippet). */
  printOnly?: boolean;
}

/**
 * Phase 6 onboarding: writes `.synapse/config.json` if missing and prints
 * a ready-to-paste MCP client configuration snippet.
 */
export function runConfigure(opts: ConfigureOpts): number {
  const root = resolve(opts.root ?? process.cwd());
  const dbRel = opts.dbPath ?? DEFAULT_CONFIG.db!;
  const dbAbs = resolve(root, dbRel);
  const client = (opts.client ?? 'claude').toLowerCase();

  if (!opts.printOnly) {
    const existing = readConfig(root);
    if (existing) {
      process.stdout.write(`config already exists: ${configPath(root)}\n`);
    } else {
      const cfg = { ...DEFAULT_CONFIG, root, db: dbRel };
      const p = writeConfig(root, cfg);
      process.stdout.write(`wrote ${p}\n`);
    }
  }

  process.stdout.write(`\nMCP client snippet (${client}):\n\n`);
  process.stdout.write(renderMcpSnippet(client, root, dbAbs));
  process.stdout.write('\n');
  return 0;
}

function renderMcpSnippet(client: string, root: string, dbAbs: string): string {
  const entry = {
    command: 'node',
    args: [
      // Best-guess path; in a real install this would be the global
      // `synapse-mcp` bin. We point at the workspace dist by default and
      // mention the alternative below.
      resolve(root, 'packages/mcp-server/dist/bin.js'),
      '--db',
      dbAbs,
      '--root',
      root,
    ],
  };

  if (client === 'claude') {
    // Claude Desktop config lives at:
    //   %APPDATA%\Claude\claude_desktop_config.json (Windows)
    //   ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
    return JSON.stringify({ mcpServers: { synapse: entry } }, null, 2) + '\n';
  }
  if (client === 'cursor') {
    // Cursor reads ~/.cursor/mcp.json with the same shape as Claude.
    return JSON.stringify({ mcpServers: { synapse: entry } }, null, 2) + '\n';
  }
  // generic
  return JSON.stringify({ synapse: entry }, null, 2) + '\n';
}
