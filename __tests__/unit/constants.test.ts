/**
 * Tests for constants module.
 */

import { describe, it, expect } from 'vitest';
import { PROXY, SECURITY, TIMEOUTS } from '../../src/constants';

describe('Constants', () => {
  it('should have proxy defaults', () => {
    expect(PROXY.MAX_BODY_SIZE).toBeGreaterThan(0);
    expect(PROXY.PORT).toBe(4000);
  });

  it('should have security defaults', () => {
    expect(SECURITY.MAX_LOGIN_ATTEMPTS).toBeGreaterThan(0);
    expect(SECURITY.TOKEN_EXPIRY_MS).toBeGreaterThan(0);
  });

  it('should have timeout defaults', () => {
    expect(TIMEOUTS.PROVIDER_DEFAULT_MS).toBeGreaterThan(0);
    expect(TIMEOUTS.GPU_BOOT_MS).toBeGreaterThan(0);
  });
});
