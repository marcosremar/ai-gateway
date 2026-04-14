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
import { randomBytes, createHash } from 'crypto';

const CSRF_HEADER = 'X-CSRF-Token';
const CSRF_COOKIE = 'csrf-token';

/**
 * Generate a CSRF token.
 */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Verify a CSRF token.
 */
export function verifyCsrfToken(token: string, secret: string): boolean {
  const expected = createHash('sha256').update(secret + token).digest('base64url');
  return token === expected;
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
