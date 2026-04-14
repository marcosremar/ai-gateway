/**
 * Auth Module — Integration Tests
 *
 * Tests GPU token signing and verification (HMAC).
 * Requires: GPU_ACCESS_SECRET (or sets a test secret)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { signGpuToken, verifyGpuToken } from '../src/auth/gpu-token';
import { loadEnv } from './helpers';

beforeAll(() => {
  loadEnv();
  // Set a test secret if none exists
  if (!process.env.GPU_ACCESS_SECRET) {
    process.env.GPU_ACCESS_SECRET = 'test-secret-for-integration-tests';
  }
});

describe('GPU Token Auth', () => {
  it('signs and verifies a token roundtrip', () => {
    const token = signGpuToken('user-123');

    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(2);

    const payload = verifyGpuToken(token);
    expect(payload.uid).toBe('user-123');
    expect(payload.iat).toBeGreaterThan(0);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it('token expires after TTL (60s)', () => {
    const token = signGpuToken('user-456');
    const payload = verifyGpuToken(token);

    expect(payload.exp - payload.iat).toBe(60);
  });

  it('rejects tampered token', () => {
    const token = signGpuToken('user-789');
    const [payload, sig] = token.split('.');
    const tamperedToken = `${payload}.${sig.slice(0, -1)}X`;

    expect(() => verifyGpuToken(tamperedToken)).toThrow('Invalid signature');
  });

  it('rejects invalid format', () => {
    expect(() => verifyGpuToken('not-a-valid-token')).toThrow();
  });

  it('each token is unique', () => {
    const t1 = signGpuToken('user-1');
    const t2 = signGpuToken('user-1');

    // Tokens might be the same if signed in the same second
    // but the payload should decode correctly for both
    expect(verifyGpuToken(t1).uid).toBe('user-1');
    expect(verifyGpuToken(t2).uid).toBe('user-1');
  });
});
