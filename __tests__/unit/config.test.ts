/**
 * Tests for config module.
 */

import { describe, it, expect } from 'vitest';
import { getConfig, resetConfig } from '../../src/config';

describe('Config', () => {
  it('should load config from env', () => {
    resetConfig();
    const config = getConfig();
    expect(config).toBeDefined();
    expect(config.port).toBeDefined();
  });
});
