import type { ServerResponse } from 'http';

/**
 * Security headers applied to all responses.
 *
 * Headers:
 * - X-Content-Type-Options: nosniff (prevent MIME sniffing)
 * - X-Frame-Options: DENY (prevent clickjacking)
 * - Strict-Transport-Security: max-age=31536000; includeSubDomains (HSTS)
 * - X-XSS-Protection: 1; mode=block (XSS filter)
 * - Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' (restrict resource loading)
 * - Referrer-Policy: strict-origin-when-cross-origin (control referrer info)
 * - Permissions-Policy: restrict browser features
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-XSS-Protection': '1; mode=block',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * Apply security headers to response.
 * Only sets headers that haven't already been set (caller can override).
 */
export function applySecurityHeaders(res: ServerResponse): void {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    if (!res.getHeader(header)) {
      res.setHeader(header, value);
    }
  }
}
