/**
 * Security headers middleware — applied to all HTTP responses.
 *
 * Fixes Gap #7: Missing security headers (CSP, HSTS, XSS protection, etc.)
 */

import type { ServerResponse } from 'http';

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-XSS-Protection': '1; mode=block',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Cross-origin isolation: prevent the admin UI window/resources from being
  // shared into a cross-origin context (Spectre-class & cross-origin leaks).
  // NOTE: both header copies (src/middleware + server/middleware) must stay in
  // sync — drift here silently weakens one of the two servers.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * Apply security headers to response.
 * Call this before any res.writeHead() or res.end().
 */
export function applySecurityHeaders(res: ServerResponse): void {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    if (!res.getHeader(header)) {
      res.setHeader(header, value);
    }
  }
}
