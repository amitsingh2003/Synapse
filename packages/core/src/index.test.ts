import { describe, it, expect } from 'vitest';
import { ping, CORE_VERSION } from './index.js';

describe('@synapse/core smoke test', () => {
  it('ping returns pong', () => {
    expect(ping()).toBe('pong');
  });

  it('exposes a CORE_VERSION string', () => {
    expect(typeof CORE_VERSION).toBe('string');
  });
});
