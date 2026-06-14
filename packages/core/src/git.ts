/**
 * Lightweight git utilities used by the auto-sync system.
 *
 * All functions use the `git` executable rather than reading `.git/HEAD`
 * directly so they work correctly with:
 *   - Normal repos
 *   - Git worktrees (.git is a file pointer, not a directory)
 *   - Detached HEAD state
 *   - Shallow clones
 *   - Repos where git is not installed (return null gracefully)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run a git command in `cwd` with a 5-second timeout.
 * Returns trimmed stdout, or null on any error (no git, not a repo, etc.).
 */
async function gitExec(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 5_000,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Return the current HEAD commit SHA (40 hex chars) for the repo rooted at
 * `root`, or null when the directory is not a git repo, git is not on PATH,
 * the repo has no commits yet, or any other error occurs.
 */
export async function getCurrentHead(root: string): Promise<string | null> {
  return gitExec(['rev-parse', 'HEAD'], root);
}
