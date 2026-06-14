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
 * - Cross-Origin-Opener-Policy / Cross-Origin-Resource-Policy: same-origin (cross-origin isolation)
 */
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
  // NOTE: kept byte-identical with src/middleware/security-headers.ts — drift
  // here silently weakens one of the two servers.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * Build a Content-Security-Policy string (#698).
 *
 * Nonce-based alternative to the static `'unsafe-inline'` style policy. Kept
 * byte-identical with `src/middleware/security-headers.ts` — drift here silently
 * weakens one of the two servers. See that file for the full rationale.
 *
 * @returns the CSP header VALUE.
 */
export function buildContentSecurityPolicy(
  opts: { styleNonce?: string; scriptNonce?: string; allowStyleUnsafeInline?: boolean } = {},
): string {
  const scriptSrc = ['\'self\''];
  if (opts.scriptNonce) scriptSrc.push(`'nonce-${opts.scriptNonce}'`);

  const styleSrc = ['\'self\''];
  if (opts.styleNonce) {
    styleSrc.push(`'nonce-${opts.styleNonce}'`);
  } else if (opts.allowStyleUnsafeInline ?? true) {
    styleSrc.push('\'unsafe-inline\'');
  }

  return `default-src 'self'; script-src ${scriptSrc.join(' ')}; style-src ${styleSrc.join(' ')}`;
}

/**
 * Apply security headers to response.
 * Only sets headers that haven't already been set (caller can override).
 *
 * Pass `opts.styleNonce`/`opts.scriptNonce` to emit a nonce-based CSP for this
 * response instead of the static `'unsafe-inline'` default.
 */
export function applySecurityHeaders(
  res: ServerResponse,
  opts: { styleNonce?: string; scriptNonce?: string } = {},
): void {
  const csp =
    opts.styleNonce || opts.scriptNonce
      ? buildContentSecurityPolicy(opts)
      : SECURITY_HEADERS['Content-Security-Policy'];
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    if (res.getHeader(header)) continue;
    res.setHeader(header, header === 'Content-Security-Policy' ? csp : value);
  }
}
