import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, indexRepo, resolveReferences } from '@synapse/core';
import { run } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'fixtures', 'sample-shopping-app');

let tmpRoot: string;
let stdout: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cg-phase6-'));
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('configure', () => {
  it('writes .synapse/config.json and prints a claude snippet by default', async () => {
    const code = await run(['configure', tmpRoot]);
    expect(code).toBe(0);
    const cfgPath = join(tmpRoot, '.synapse', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(cfg.version).toBe(1);
    expect(cfg.db).toBe('.synapse/graph.db');
    expect(stdout).toContain('MCP client snippet (claude)');
    expect(stdout).toContain('"mcpServers"');
    expect(stdout).toContain('synapse-mcp'.length ? 'mcp-server' : '');
  });

  it('--print does not write the config file', async () => {
    const code = await run(['configure', tmpRoot, '--print', '--client', 'cursor']);
    expect(code).toBe(0);
    expect(existsSync(join(tmpRoot, '.synapse', 'config.json'))).toBe(false);
    expect(stdout).toContain('MCP client snippet (cursor)');
  });

  it('reports an existing config without overwriting', async () => {
    await run(['configure', tmpRoot]);
    stdout = '';
    const code = await run(['configure', tmpRoot]);
    expect(code).toBe(0);
    expect(stdout).toContain('already exists');
  });
});

describe('doctor', () => {
  it('FAILs when the DB is missing', async () => {
    const code = await run(['doctor', tmpRoot]);
    expect(code).toBe(1);
    expect(stdout).toContain('[FAIL]');
    expect(stdout).toContain('graph database');
    expect(stdout).toContain('summary: FAIL');
  });

  it('passes against a freshly indexed repo', async () => {
    const dbPath = join(tmpRoot, '.synapse', 'graph.db');
    const db = openDatabase({ path: dbPath });
    await indexRepo(db, { root: FIXTURE, concurrency: 2 });
    resolveReferences(db, { root: FIXTURE });
    db.close();

    const code = await run(['doctor', tmpRoot, '--db', dbPath]);
    expect(code).toBe(0);
    expect(stdout).toContain('[ ok ] graph database');
    expect(stdout).not.toContain('[FAIL]');
  });
});
