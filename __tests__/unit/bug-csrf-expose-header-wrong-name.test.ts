/**
 * Bug: setCsrfHeaders writes the token to the response header named
 * `csrf-token` (the CSRF_COOKIE constant) but the
 * Access-Control-Expose-Headers value points at `X-CSRF-Token` (the
 * CSRF_HEADER constant — used for INCOMING request headers, not outgoing
 * response headers). Cross-origin SPAs that try to read the token from
 * the response cannot, because the actually-sent header is not in the
 * exposed-headers allowlist. Result: CSRF protection is broken for
 * cross-origin clients — they can't acquire a valid token to send back.
 */
import { describe, it, expect } from 'vitest';
import { setCsrfHeaders } from '../../src/middleware/csrf';

describe('setCsrfHeaders — exposes the actually-set header', () => {
  it('Access-Control-Expose-Headers names the same header that carries the token', () => {
    const headers: Record<string, string> = {};
    const fakeRes = {
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    } as any;
    setCsrfHeaders(fakeRes, 'abc.def');

    // Find which header carries the token (must exist).
    const tokenHeaderName = Object.keys(headers).find(
      (k) => headers[k] === 'abc.def' && k !== 'access-control-expose-headers',
    );
    expect(tokenHeaderName).toBeDefined();

    // The exposed-headers list must include the token header so cross-origin
    // SPAs can read it. CORS matches by exact header name in the
    // comma-separated list, not by substring.
    const exposed = (headers['access-control-expose-headers'] || '')
      .split(',').map((s) => s.trim().toLowerCase());
    expect(exposed).toContain(tokenHeaderName!.toLowerCase());
  });
});
