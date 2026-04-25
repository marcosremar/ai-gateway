/**
 * CSRF Protection Middleware.
 *
 * Fixes Gap #4: No CSRF protection.
 *
 * For API-only services using Bearer tokens, CSRF risk is low. However,
 * if cookies/sessions are ever added, this provides protection.
 *
 * Usage:
 * ```typescript
 * import { csrfMiddleware, generateCsrfToken } from './csrf';
 *
 * // In request handler:
 * const isValid = csrfMiddleware(req, res);
 * if (!isValid) return; // Response already sent with 403
 * ```
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';

const CSRF_HEADER = 'X-CSRF-Token';
const CSRF_COOKIE = 'csrf-token';

function signNonce(nonce: string, secret: string): string {
  return createHmac('sha256', secret).update(nonce).digest('base64url');
}

/**
 * Generate a CSRF token bound to `secret`. Format: `<nonce>.<hmac>` so
 * verifyCsrfToken can recompute and compare without a server-side store.
 *
 * The previous implementation returned an opaque random string and the
 * verify function compared `token === sha256(secret+token)` — a check that
 * could never succeed. Anyone using the old verify path was effectively
 * rejecting every request.
 */
export function generateCsrfToken(secret: string): string {
  if (!secret) throw new Error('generateCsrfToken: secret is required');
  const nonce = randomBytes(32).toString('base64url');
  return `${nonce}.${signNonce(nonce, secret)}`;
}

/**
 * Verify a CSRF token. Returns true iff the embedded HMAC matches the one
 * we recompute from `secret` over the token's nonce. Constant-time compare
 * to avoid signature-length / byte-by-byte timing leaks.
 */
export function verifyCsrfToken(token: string, secret: string): boolean {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const nonce = token.slice(0, dot);
  const supplied = token.slice(dot + 1);
  const expected = signNonce(nonce, secret);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * CSRF middleware for HTTP requests.
 *
 * Returns true if CSRF check passes, false if response was already sent.
 * For Bearer token APIs, this is a no-op (CSRF not applicable).
 * For cookie/session APIs, this validates the CSRF token.
 */
export function csrfMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  options: { cookieBased: boolean; secret: string } = { cookieBased: false, secret: '' },
): boolean {
  // Skip CSRF check for Bearer token APIs (most common in this codebase)
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return true;
  }

  // Skip for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method || '')) {
    return true;
  }

  // For cookie-based auth, validate CSRF token
  if (options.cookieBased) {
    const token = req.headers[CSRF_HEADER.toLowerCase()] as string;
    if (!token || !verifyCsrfToken(token, options.secret)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CSRF token validation failed' }));
      return false;
    }
  }

  return true;
}

/**
 * Set CSRF token in response headers.
 */
export function setCsrfHeaders(res: ServerResponse, token: string): void {
  res.setHeader(CSRF_COOKIE, token);
  res.setHeader('Access-Control-Expose-Headers', CSRF_HEADER);
}
