/**
 * Bug: maskApiKey() shows too many characters for keys length 9-15.
 *
 * Implementation: `${key.slice(0, 4)}***${key.slice(-4)}` always exposes
 * the first 4 + last 4 = 8 chars regardless of total length. For a
 * 9-char key, that's 8/9 chars in plaintext — only ONE character is
 * actually masked. For 10-12 chars the leak is 80%+. The function is
 * supposed to be a privacy-preserving log/display helper.
 *
 * Fix: when key.length is too short for safe masking (< 12 chars),
 * collapse to "***". When 12+, keep the prefix/suffix scheme.
 */
import { describe, it, expect } from 'vitest';
import { maskApiKey } from '../../src/middleware/sanitization';

describe('maskApiKey — short-key safety', () => {
  it('does NOT expose 8 of 9 characters for a 9-char key', () => {
    const key = 'abc123xyz';
    const masked = maskApiKey(key);
    // Count alphanumeric chars from the original visible in the masked output.
    const visibleChars = [...masked].filter((c) => key.includes(c)).length;
    // No more than half of the original should be exposed.
    expect(visibleChars).toBeLessThanOrEqual(Math.floor(key.length / 2));
  });

  it('keeps the prefix/suffix scheme intact for sufficiently long keys', () => {
    const key = 'sk-1234567890abcdefghij';
    const masked = maskApiKey(key);
    expect(masked).toBe('sk-1***ghij');
  });

  it('returns *** for keys of length 8 or less', () => {
    expect(maskApiKey('abc12345')).toBe('***');
    expect(maskApiKey('a')).toBe('***');
    expect(maskApiKey('')).toBe('***');
  });
});
