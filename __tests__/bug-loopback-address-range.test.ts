/**
 * Regression test: isLoopbackAddress must accept all 127.x.x.x addresses
 * (the full 127.0.0.0/8 range per RFC 1122), not just 127.0.0.1.
 *
 * Bug: Both ws-server.ts and http-api-server.ts define isLoopbackAddress()
 * as:
 *   address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
 *
 * This rejects legitimate loopback addresses like 127.0.0.2, which are
 * valid per RFC 1122. In practice, local proxies, VPNs, and container
 * networking can bind to addresses in the 127.0.0.0/8 range.
 *
 * When GATEWAY_API_KEY is not set, authorizeHttpRequest() falls back to
 * loopback-only access. A client on 127.0.0.2 would be denied.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// authorizeHttpRequest is exported from http-api-server.ts
import { authorizeHttpRequest } from '../server/ws/http-api-server';

describe('authorizeHttpRequest loopback detection', () => {
  const originalKey = process.env.GATEWAY_API_KEY;
  const originalKeys = process.env.GATEWAY_API_KEYS;

  beforeEach(() => {
    delete process.env.GATEWAY_API_KEY;
    delete process.env.GATEWAY_API_KEYS;
  });

  afterEach(() => {
    if (originalKey) process.env.GATEWAY_API_KEY = originalKey;
    else delete process.env.GATEWAY_API_KEY;
    if (originalKeys) process.env.GATEWAY_API_KEYS = originalKeys;
    else delete process.env.GATEWAY_API_KEYS;
  });

  it('should allow 127.0.0.1 (standard loopback)', () => {
    const result = authorizeHttpRequest('GET', '/v1/models', null, '127.0.0.1');
    expect(result.ok).toBe(true);
  });

  it('should allow 127.0.0.2 (RFC 1122 loopback)', () => {
    const result = authorizeHttpRequest('GET', '/v1/models', null, '127.0.0.2');
    expect(result.ok).toBe(true);
  });

  it('should allow 127.255.255.255 (upper bound of loopback range)', () => {
    const result = authorizeHttpRequest('GET', '/v1/models', null, '127.255.255.255');
    expect(result.ok).toBe(true);
  });

  it('should allow 127.1.1.1 (mid-range loopback)', () => {
    const result = authorizeHttpRequest('GET', '/v1/models', null, '127.1.1.1');
    expect(result.ok).toBe(true);
  });

  it('should allow ::1 (IPv6 loopback)', () => {
    const result = authorizeHttpRequest('GET', '/v1/models', null, '::1');
    expect(result.ok).toBe(true);
  });

  it('should allow ::ffff:127.0.0.2 (IPv4-mapped IPv6 loopback)', () => {
    const result = authorizeHttpRequest('GET', '/v1/models', null, '::ffff:127.0.0.2');
    expect(result.ok).toBe(true);
  });

  it('should deny 10.0.0.1 (private but not loopback)', () => {
    const result = authorizeHttpRequest('GET', '/v1/models', null, '10.0.0.1');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('should deny 192.168.1.1 (private but not loopback)', () => {
    const result = authorizeHttpRequest('GET', '/v1/models', null, '192.168.1.1');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('should deny 8.8.8.8 (public IP)', () => {
    const result = authorizeHttpRequest('GET', '/v1/models', null, '8.8.8.8');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});
