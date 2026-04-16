/**
 * Tests for constants module.
 */

import { describe, it, expect } from 'vitest';
import { PROXY, SECURITY } from '../../src/constants';

describe('Constants', () => {
  it('should have proxy defaults', () => {
    expect(PROXY.MAX_BODY_SIZE).toBeGreaterThan(0);
    expect(PROXY.DEFAULT_PORT).toBe(4000);
  });

  it('should have security defaults', () => {
    expect(SECURITY.TOKEN_EXPIRY_MS).toBeGreaterThan(0);
    expect(SECURITY.MAX_REQUEST_SIZE_MB).toBeGreaterThan(0);
  });
});
