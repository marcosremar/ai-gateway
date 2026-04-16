import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAuth } from '../src/proxy/middleware/auth';

describe('validateAuth', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('allows when no keys configured', () => {
    expect(validateAuth(undefined, [])).toBe(true);
    expect(validateAuth('Bearer token', [])).toBe(true);
  });

  it('rejects missing Authorization header', () => {
    expect(validateAuth(undefined, ['key1'])).toBe(false);
  });

  it('rejects empty Bearer token', () => {
    expect(validateAuth('Bearer ', ['key1'])).toBe(false);
    expect(validateAuth('Bearer', ['key1'])).toBe(false);
  });

  it('accepts valid Bearer token', () => {
    expect(validateAuth('Bearer my-secret-key', ['my-secret-key'])).toBe(true);
  });

  it('rejects invalid Bearer token', () => {
    expect(validateAuth('Bearer wrong-key', ['my-secret-key'])).toBe(false);
  });

  it('accepts any matching key from the list', () => {
    expect(validateAuth('Bearer key2', ['key1', 'key2', 'key3'])).toBe(true);
  });

  it('handles case-insensitive Bearer prefix', () => {
    expect(validateAuth('bearer my-secret-key', ['my-secret-key'])).toBe(true);
    expect(validateAuth('BEARER my-secret-key', ['my-secret-key'])).toBe(true);
  });

  it('rejects tokens of different lengths (timing-safe)', () => {
    expect(validateAuth('Bearer short', ['a-very-long-key'])).toBe(false);
  });

  it('logs warning on invalid key', () => {
    validateAuth('Bearer wrong', ['correct']);
    expect(console.warn).toHaveBeenCalledWith('Invalid API key');
  });
});
