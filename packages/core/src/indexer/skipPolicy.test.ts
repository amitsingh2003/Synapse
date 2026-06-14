import { describe, it, expect } from 'vitest';
import { shouldSkipDir, shouldSkipPath, isKnownCodeExtension } from './skipPolicy.js';

describe('skipPolicy', () => {
  it('skips common ecosystem directories by basename', () => {
    expect(shouldSkipDir('node_modules')).toBe(true);
    expect(shouldSkipDir('.git')).toBe(true);
    expect(shouldSkipDir('__pycache__')).toBe(true);
    expect(shouldSkipDir('target')).toBe(true); // rust / jvm
    expect(shouldSkipDir('vendor')).toBe(true); // go
    expect(shouldSkipDir('.terraform')).toBe(true);
    expect(shouldSkipDir('.synapse')).toBe(true);
  });

  it('matches wildcard patterns', () => {
    expect(shouldSkipDir('myproject.egg-info')).toBe(true);
    expect(shouldSkipDir('App.xcodeproj')).toBe(true);
    expect(shouldSkipDir('Workspace.xcworkspace')).toBe(true);
  });

  it('does not skip ordinary names', () => {
    expect(shouldSkipDir('src')).toBe(false);
    expect(shouldSkipDir('lib')).toBe(false);
    expect(shouldSkipDir('utils')).toBe(false);
  });

  it('detects hard-skip segments in a path (cross-platform separators)', () => {
    expect(shouldSkipPath('/repo/node_modules/foo/bar.ts')).toBe(true);
    expect(shouldSkipPath('C:\\repo\\.git\\HEAD')).toBe(true);
    expect(shouldSkipPath('/repo/src/utils/x.ts')).toBe(false);
  });

  it('flags known but unsupported code extensions', () => {
    expect(isKnownCodeExtension('foo.py')).toBe(true);
    expect(isKnownCodeExtension('foo.rs')).toBe(true);
    expect(isKnownCodeExtension('foo.md')).toBe(false);
    expect(isKnownCodeExtension('foo')).toBe(false);
  });
});
