import { describe, it, expect } from 'vitest';

function hashUserId(userId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

describe('FNV-1a hash function (load-balancer)', () => {
  it('is deterministic — same input always produces same output', () => {
    const h1 = hashUserId('user-123');
    const h2 = hashUserId('user-123');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = hashUserId('user-1');
    const h2 = hashUserId('user-2');
    expect(h1).not.toBe(h2);
  });

  it('returns a non-negative 32-bit unsigned integer', () => {
    const h = hashUserId('test-user');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xFFFFFFFF);
    expect(Number.isInteger(h)).toBe(true);
  });

  it('handles empty string', () => {
    const h = hashUserId('');
    expect(h).toBe(2166136261 >>> 0);
  });

  it('handles single character', () => {
    const h = hashUserId('a');
    expect(typeof h).toBe('number');
    expect(h).toBeGreaterThanOrEqual(0);
  });

  it('handles very long user IDs', () => {
    const longId = 'x'.repeat(10000);
    const h = hashUserId(longId);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(h)).toBe(true);
  });

  it('handles unicode characters', () => {
    const h = hashUserId('user-日本語-🚀');
    expect(typeof h).toBe('number');
    expect(h).toBeGreaterThanOrEqual(0);
  });

  it('produces good distribution across modulo buckets', () => {
    const buckets = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5000; i++) {
      buckets[hashUserId(`user-${i}`) % 5]++;
    }
    expect(buckets.every(b => b > 800 && b < 1200)).toBe(true);
  });

  it('matches known FNV-1a values for regression guard', () => {
    expect(hashUserId('')).toBe(2166136261 >>> 0);
    const h1 = hashUserId('a');
    expect(h1).toMatchSnapshot('fnv1a-a');
  });
});
