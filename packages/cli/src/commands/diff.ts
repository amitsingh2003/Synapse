/**
 * CLI command: synapse diff <base> [head]
 *
 * Shows changed public APIs between two git refs.
 * Useful for PR review: "what public interfaces changed?"
 */

import { diffApis, type DiffResult } from '@synapse/core';
import { resolve } from 'node:path';

export interface DiffCmdOptions {
  base: string;
  head?: string;
  root?: string;
  kinds?: string;
  publicOnly?: boolean;
  json?: boolean;
}

export async function runDiff(opts: DiffCmdOptions): Promise<number> {
  const root = resolve(opts.root ?? '.');

  process.stdout.write(`Comparing APIs: ${opts.base}...${opts.head ?? 'working tree'}\n`);

  const result = await diffApis({
    root,
    base: opts.base,
    head: opts.head,
    kinds: opts.kinds?.split(','),
    publicOnly: opts.publicOnly ?? true,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }

  formatResult(result);
  return result.changes.length > 0 ? 0 : 0;
}

function formatResult(result: DiffResult): void {
  if (result.filesChanged.length === 0) {
    process.stdout.write('No changed files between refs.\n');
    return;
  }

  process.stdout.write(`\nFiles changed: ${result.filesChanged.length}\n`);

  if (result.changes.length === 0) {
    process.stdout.write('No public API changes detected.\n');
    process.stdout.write(`(${result.durationMs}ms)\n`);
    return;
  }

  process.stdout.write(`API changes: ${result.changes.length}\n\n`);

  const removed = result.changes.filter((c) => c.change === 'removed');
  const modified = result.changes.filter((c) => c.change === 'modified');
  const added = result.changes.filter((c) => c.change === 'added');

  if (removed.length > 0) {
    process.stdout.write('── Removed ──\n');
    for (const c of removed) {
      process.stdout.write(`  - ${c.kind} ${c.name} (${c.file}:${c.line})\n`);
      if (c.oldSignature) process.stdout.write(`    was: ${c.oldSignature}\n`);
    }
    process.stdout.write('\n');
  }

  if (modified.length > 0) {
    process.stdout.write('── Modified ──\n');
    for (const c of modified) {
      process.stdout.write(`  ~ ${c.kind} ${c.name} (${c.file}:${c.line})\n`);
      if (c.oldSignature) process.stdout.write(`    - ${c.oldSignature}\n`);
      if (c.newSignature) process.stdout.write(`    + ${c.newSignature}\n`);
    }
    process.stdout.write('\n');
  }

  if (added.length > 0) {
    process.stdout.write('── Added ──\n');
    for (const c of added) {
      process.stdout.write(`  + ${c.kind} ${c.name} (${c.file}:${c.line})\n`);
      if (c.newSignature) process.stdout.write(`    ${c.newSignature}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(`(${result.durationMs}ms)\n`);
}
