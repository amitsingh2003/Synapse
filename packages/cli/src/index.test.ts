import { describe, it, expect, vi, beforeEach } from 'vitest';
import { run } from './index.js';

describe('@synapse/cli', () => {
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });
  });

  it('--version prints a version and exits 0', async () => {
    const code = await run(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help prints help text', async () => {
    const code = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('synapse');
  });

  it('no args prints help', async () => {
    const code = await run([]);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
  });

  it('ping calls into @synapse/core', async () => {
    const code = await run(['ping']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('pong');
  });

  it('unknown command exits 1 and writes to stderr', async () => {
    const code = await run(['nope']);
    expect(code).toBe(1);
    expect(stderr).toContain('unknown command');
  });
});
