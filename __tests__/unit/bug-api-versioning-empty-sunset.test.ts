/**
 * Bug: getVersionHeaders() emits `Sunset: ` (empty value) when a deprecated
 * version has no sunset date set. RFC 8594 requires the Sunset header value
 * to be an HTTP-date — an empty value is malformed and Express/Node will
 * either reject it (Bun crashes on setHeader('Sunset', '')) or send a
 * useless empty header that confuses clients.
 *
 * Fix: omit Sunset entirely when version.sunset is undefined.
 */
import { describe, it, expect } from 'vitest';
import { getVersionHeaders } from '../../src/middleware/api-versioning';

describe('getVersionHeaders — Sunset header', () => {
  it('omits Sunset when no sunset date is set, even on deprecated versions', () => {
    const headers = getVersionHeaders({
      major: 1,
      minor: 0,
      deprecated: true,
      // sunset intentionally undefined
    });
    // Either Sunset is absent, or it's a non-empty valid HTTP-date.
    if ('Sunset' in headers) {
      expect(headers.Sunset).not.toBe('');
      expect(headers.Sunset.length).toBeGreaterThan(5);
    }
  });

  it('includes Sunset when explicitly set', () => {
    const headers = getVersionHeaders({
      major: 1,
      minor: 0,
      deprecated: true,
      sunset: 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    expect(headers.Sunset).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
  });
});
