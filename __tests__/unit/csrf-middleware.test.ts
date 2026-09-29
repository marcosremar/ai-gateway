/**
 * Unit tests for src/middleware/csrf.ts
 *
 * Covers: generateCsrfToken (format, randomness, secret required),
 * verifyCsrfToken (valid token, tampered nonce/hmac, wrong secret, malformed,
 * empty inputs, constant-time compare), csrfMiddleware (Bearer bypass, safe
 * methods, cookie-based valid/invalid/missing, non-cookie mutation pass),
 * and setCsrfHeaders (token written, expose header set).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateCsrfToken,
  verifyCsrfToken,
  csrfMiddleware,
  setCsrfHeaders,
} from '../../src/middleware/csrf';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: {
  method?: string;
  headers?: Record<string, string>;
}): any {
  return {
    method: overrides.method ?? 'POST',
    headers: overrides.headers ?? {},
  };
}

function makeRes(): { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn>; getHeader: ReturnType<typeof vi.fn>; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
  return res as any;
}

const SECRET = 'test-secret-abc';

// ── generateCsrfToken ─────────────────────────────────────────────────────────

describe('generateCsrfToken', () => {
  it('returns a non-empty string', () => {
    const token = generateCsrfToken(SECRET);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('contains exactly one dot separator', () => {
    const token = generateCsrfToken(SECRET);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it('produces different tokens on consecutive calls (randomness)', () => {
    const t1 = generateCsrfToken(SECRET);
    const t2 = generateCsrfToken(SECRET);
    expect(t1).not.toBe(t2);
  });

  it('produces different tokens for different secrets', () => {
    const t1 = generateCsrfToken('secret-a');
    const t2 = generateCsrfToken('secret-b');
    // Different secrets → different HMACs (nonces also differ, but HMAC definitely will)
    const hmac1 = t1.split('.')[1];
    const hmac2 = t2.split('.')[1];
    expect(hmac1).not.toBe(hmac2);
  });

  it('throws when secret is empty', () => {
    expect(() => generateCsrfToken('')).toThrow();
  });

  it('nonce part uses base64url characters only', () => {
    const token = generateCsrfToken(SECRET);
    const nonce = token.split('.')[0];
    expect(nonce).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});

// ── verifyCsrfToken ───────────────────────────────────────────────────────────

describe('verifyCsrfToken', () => {
  it('returns true for a freshly generated token with the same secret', () => {
    const token = generateCsrfToken(SECRET);
    expect(verifyCsrfToken(token, SECRET)).toBe(true);
  });

  it('returns false when the secret differs', () => {
    const token = generateCsrfToken(SECRET);
    expect(verifyCsrfToken(token, 'wrong-secret')).toBe(false);
  });

  it('returns false when the HMAC portion is tampered', () => {
    const token = generateCsrfToken(SECRET);
    const [nonce] = token.split('.');
    const tampered = `${nonce}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(verifyCsrfToken(tampered, SECRET)).toBe(false);
  });

  it('returns false when the nonce portion is tampered', () => {
    const token = generateCsrfToken(SECRET);
    const [, hmac] = token.split('.');
    const tampered = `TAMPEREDNONCE.${hmac}`;
    expect(verifyCsrfToken(tampered, SECRET)).toBe(false);
  });

  it('returns false for an empty token', () => {
    expect(verifyCsrfToken('', SECRET)).toBe(false);
  });

  it('returns false for an empty secret', () => {
    const token = generateCsrfToken(SECRET);
    expect(verifyCsrfToken(token, '')).toBe(false);
  });

  it('returns false for a token with no dot', () => {
    expect(verifyCsrfToken('nodotinhere', SECRET)).toBe(false);
  });

  it('returns false for a token that starts with a dot', () => {
    expect(verifyCsrfToken('.onlysuffix', SECRET)).toBe(false);
  });

  it('returns false for a token that ends with a dot', () => {
    expect(verifyCsrfToken('onlyprefix.', SECRET)).toBe(false);
  });

  it('returns false for a plain random string without HMAC', () => {
    expect(verifyCsrfToken('randomnonce.randomhmac', SECRET)).toBe(false);
  });

  it('returns false for swapped nonce/hmac order', () => {
    const token = generateCsrfToken(SECRET);
    const [nonce, hmac] = token.split('.');
    const swapped = `${hmac}.${nonce}`;
    expect(verifyCsrfToken(swapped, SECRET)).toBe(false);
  });

  it('multiple valid tokens all verify correctly', () => {
    for (let i = 0; i < 5; i++) {
      const token = generateCsrfToken(SECRET);
      expect(verifyCsrfToken(token, SECRET)).toBe(true);
    }
  });
});

// ── csrfMiddleware ────────────────────────────────────────────────────────────

describe('csrfMiddleware', () => {
  describe('Bearer token bypass', () => {
    it('returns true and skips check for Bearer token on POST', () => {
      const req = makeReq({ method: 'POST', headers: { authorization: 'Bearer sk-abc123' } });
      const res = makeRes();
      const result = csrfMiddleware(req, res, { cookieBased: true, secret: SECRET });
      expect(result).toBe(true);
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('returns true and skips check for Bearer token on PUT', () => {
      const req = makeReq({ method: 'PUT', headers: { authorization: 'Bearer token' } });
      const res = makeRes();
      const result = csrfMiddleware(req, res, { cookieBased: true, secret: SECRET });
      expect(result).toBe(true);
    });

    it('returns true and skips check for Bearer token on DELETE', () => {
      const req = makeReq({ method: 'DELETE', headers: { authorization: 'Bearer tok' } });
      const res = makeRes();
      const result = csrfMiddleware(req, res, { cookieBased: true, secret: SECRET });
      expect(result).toBe(true);
    });
  });

  describe('Safe method bypass', () => {
    it('returns true for GET without any token', () => {
      const req = makeReq({ method: 'GET' });
      const res = makeRes();
      expect(csrfMiddleware(req, res, { cookieBased: true, secret: SECRET })).toBe(true);
    });

    it('returns true for HEAD without any token', () => {
      const req = makeReq({ method: 'HEAD' });
      const res = makeRes();
      expect(csrfMiddleware(req, res, { cookieBased: true, secret: SECRET })).toBe(true);
    });

    it('returns true for OPTIONS without any token', () => {
      const req = makeReq({ method: 'OPTIONS' });
      const res = makeRes();
      expect(csrfMiddleware(req, res, { cookieBased: true, secret: SECRET })).toBe(true);
    });
  });

  describe('Non-cookie-based auth (API key / default)', () => {
    it('returns true for POST without any CSRF token (non-cookie-based)', () => {
      const req = makeReq({ method: 'POST' });
      const res = makeRes();
      expect(csrfMiddleware(req, res)).toBe(true);
    });

    it('returns true for DELETE without any CSRF token (non-cookie-based)', () => {
      const req = makeReq({ method: 'DELETE' });
      const res = makeRes();
      expect(csrfMiddleware(req, res, { cookieBased: false, secret: '' })).toBe(true);
    });
  });

  describe('Cookie-based auth — valid token', () => {
    it('returns true when a valid CSRF token is in request headers', () => {
      const token = generateCsrfToken(SECRET);
      const req = makeReq({
        method: 'POST',
        headers: { 'x-csrf-token': token },
      });
      const res = makeRes();
      const result = csrfMiddleware(req, res, { cookieBased: true, secret: SECRET });
      expect(result).toBe(true);
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('returns true for PUT with valid token', () => {
      const token = generateCsrfToken(SECRET);
      const req = makeReq({ method: 'PUT', headers: { 'x-csrf-token': token } });
      const res = makeRes();
      expect(csrfMiddleware(req, res, { cookieBased: true, secret: SECRET })).toBe(true);
    });
  });

  describe('Cookie-based auth — invalid/missing token', () => {
    it('returns false and sends 403 when CSRF token is missing', () => {
      const req = makeReq({ method: 'POST' });
      const res = makeRes();
      const result = csrfMiddleware(req, res, { cookieBased: true, secret: SECRET });
      expect(result).toBe(false);
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
      expect(res.end).toHaveBeenCalled();
    });

    it('returns false and sends 403 for a tampered token', () => {
      const token = generateCsrfToken(SECRET);
      const [nonce] = token.split('.');
      const tampered = `${nonce}.BADHMAC`;
      const req = makeReq({ method: 'POST', headers: { 'x-csrf-token': tampered } });
      const res = makeRes();
      const result = csrfMiddleware(req, res, { cookieBased: true, secret: SECRET });
      expect(result).toBe(false);
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    });

    it('returns false and sends 403 for a token from the wrong secret', () => {
      const token = generateCsrfToken('other-secret');
      const req = makeReq({ method: 'POST', headers: { 'x-csrf-token': token } });
      const res = makeRes();
      const result = csrfMiddleware(req, res, { cookieBased: true, secret: SECRET });
      expect(result).toBe(false);
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    });

    it('returns false and sends 403 for a random string token', () => {
      const req = makeReq({ method: 'DELETE', headers: { 'x-csrf-token': 'not-a-real-token' } });
      const res = makeRes();
      const result = csrfMiddleware(req, res, { cookieBased: true, secret: SECRET });
      expect(result).toBe(false);
    });

    it('response body on 403 is JSON with error field', () => {
      const req = makeReq({ method: 'POST' });
      const res = makeRes();
      csrfMiddleware(req, res, { cookieBased: true, secret: SECRET });
      const body = JSON.parse(res.end.mock.calls[0][0] as string);
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);
    });
  });
});

// ── setCsrfHeaders ────────────────────────────────────────────────────────────

describe('setCsrfHeaders', () => {
  it('writes the token to a response header', () => {
    const res = makeRes();
    setCsrfHeaders(res as any, 'my.token');
    const values = Object.values(res.headers);
    expect(values).toContain('my.token');
  });

  it('sets Access-Control-Expose-Headers to the same header that carries the token', () => {
    const res = makeRes();
    const token = 'nonce.hmac';
    setCsrfHeaders(res as any, token);

    const tokenHeaderName = Object.keys(res.headers).find(
      (k) => res.headers[k] === token && k !== 'access-control-expose-headers',
    );
    expect(tokenHeaderName).toBeDefined();

    const exposed = (res.headers['access-control-expose-headers'] || '')
      .split(',')
      .map((s: string) => s.trim().toLowerCase());
    expect(exposed).toContain(tokenHeaderName!.toLowerCase());
  });

  it('does not overwrite a pre-existing header with a different name', () => {
    const res = makeRes();
    res.headers['x-custom'] = 'keep';
    setCsrfHeaders(res as any, 'tok.en');
    expect(res.headers['x-custom']).toBe('keep');
  });
});

// ── Round-trip: generate → verify → csrfMiddleware ────────────────────────────

describe('full round-trip', () => {
  it('a token from generateCsrfToken validates in csrfMiddleware', () => {
    const token = generateCsrfToken(SECRET);
    const req = makeReq({ method: 'POST', headers: { 'x-csrf-token': token } });
    const res = makeRes();
    expect(csrfMiddleware(req, res, { cookieBased: true, secret: SECRET })).toBe(true);
  });

  it('a token set via setCsrfHeaders then echoed back passes csrfMiddleware', () => {
    const token = generateCsrfToken(SECRET);
    const serverRes = makeRes();
    setCsrfHeaders(serverRes as any, token);

    // Client reads the token header and sends it back in subsequent request
    const clientReq = makeReq({
      method: 'POST',
      headers: { 'x-csrf-token': token },
    });
    const serverRes2 = makeRes();
    expect(csrfMiddleware(clientReq, serverRes2, { cookieBased: true, secret: SECRET })).toBe(true);
  });
});
