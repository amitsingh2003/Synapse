import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, collectStats, SCHEMA_VERSION, getManifestValue } from '@synapse/core';
import { DEFAULT_CONFIG, readConfig, configPath } from '../config.js';

export interface DoctorOpts {
  root?: string;
  dbPath?: string;
}

type Status = 'ok' | 'warn' | 'error';
interface Check {
  name: string;
  status: Status;
  detail: string;
}

/**
 * `synapse doctor` — health check for an installation. Exits non-zero if
 * any 'error' check fails so it can be wired into CI.
 */
export function runDoctor(opts: DoctorOpts): number {
  const root = resolve(opts.root ?? process.cwd());
  const cfg = readConfig(root);
  const dbRel = opts.dbPath ?? cfg?.db ?? DEFAULT_CONFIG.db!;
  const dbPath = resolve(root, dbRel);

  const checks: Check[] = [];

  // Node version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node version',
    status: nodeMajor >= 20 ? 'ok' : 'error',
    detail: `node ${process.versions.node} (need >= 20)`,
  });

  // Config file
  checks.push(
    cfg
      ? { name: 'config file', status: 'ok', detail: configPath(root) }
      : {
          name: 'config file',
          status: 'warn',
          detail: `missing — run \`synapse configure\` to create ${configPath(root)}`,
        },
  );

  // DB existence + readability
  if (!existsSync(dbPath)) {
    checks.push({
      name: 'graph database',
      status: 'error',
      detail: `not found at ${dbPath} — run \`synapse init\``,
    });
  } else {
    try {
      const db = openDatabase({ path: dbPath, readonly: true });
      try {
        const s = collectStats(db);
        const detail = `${dbPath} (${s.files} files / ${s.symbols} symbols / ${s.edges} edges)`;
        checks.push({
          name: 'graph database',
          status: s.files > 0 ? 'ok' : 'warn',
          detail: s.files > 0 ? detail : `${detail} — empty, run \`synapse init\``,
        });

        // Phase 10: schema version + repo_root sanity
        const schemaVer = getManifestValue(db, 'schema_version') ?? '(unset)';
        checks.push({
          name: 'schema version',
          status: String(SCHEMA_VERSION) === schemaVer ? 'ok' : 'warn',
          detail: `db schema=${schemaVer}, cli expects=${SCHEMA_VERSION}`,
        });
        const repoRoot = getManifestValue(db, 'repo_root');
        checks.push({
          name: 'repo root',
          status: repoRoot ? 'ok' : 'warn',
          detail: repoRoot ?? '(unset — re-run `synapse init` to populate)',
        });
      } finally {
        db.close();
      }
    } catch (err) {
      checks.push({
        name: 'graph database',
        status: 'error',
        detail: `cannot open ${dbPath}: ${(err as Error).message}`,
      });
    }
  }

  // MCP server bin
  const mcpBin = resolve(root, 'packages/mcp-server/dist/bin.js');
  if (existsSync(mcpBin) && statSync(mcpBin).isFile()) {
    checks.push({ name: 'mcp-server bin', status: 'ok', detail: mcpBin });
  } else {
    checks.push({
      name: 'mcp-server bin',
      status: 'warn',
      detail: `${mcpBin} not found — run \`pnpm build\` or install @synapse/mcp-server globally`,
    });
  }

  // Render
  process.stdout.write(`synapse doctor\n  root: ${root}\n\n`);
  for (const c of checks) {
    const tag = c.status === 'ok' ? '[ ok ]' : c.status === 'warn' ? '[warn]' : '[FAIL]';
    process.stdout.write(`  ${tag} ${c.name.padEnd(16)} ${c.detail}\n`);
  }

  const hasError = checks.some((c) => c.status === 'error');
  const hasWarn = checks.some((c) => c.status === 'warn');
  process.stdout.write(
    `\nsummary: ${hasError ? 'FAIL' : hasWarn ? 'WARN' : 'OK'} ` +
      `(${checks.filter((c) => c.status === 'ok').length}/${checks.length} ok)\n`,
  );
  return hasError ? 1 : 0;
}
