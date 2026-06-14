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
 * Build a Content-Security-Policy string (#698).
 *
 * The default `SECURITY_HEADERS['Content-Security-Policy']` ships
 * `style-src 'self' 'unsafe-inline'` because the admin UI currently emits inline
 * styles. `'unsafe-inline'` defeats CSP's protection against injected styles. The
 * proper fix is nonce-based styles: emit `<style nonce="…">`/`<link nonce>` with a
 * per-response random nonce and reference that nonce in the policy.
 *
 * This is the opt-in builder for callers ready to plumb a nonce through their
 * templates. Pass `{ styleNonce }` to get `style-src 'self' 'nonce-…'` (NO
 * `'unsafe-inline'`); pass `{ scriptNonce }` likewise for scripts. With no
 * nonces it reproduces the current default verbatim, so the static constant is
 * left untouched and back-compatible.
 *
 * @returns the CSP header VALUE (assign to `Content-Security-Policy`).
 */
export function buildContentSecurityPolicy(
  opts: { styleNonce?: string; scriptNonce?: string; allowStyleUnsafeInline?: boolean } = {},
): string {
  const scriptSrc = ['\'self\''];
  if (opts.scriptNonce) scriptSrc.push(`'nonce-${opts.scriptNonce}'`);

  const styleSrc = ['\'self\''];
  if (opts.styleNonce) {
    // A nonce REPLACES 'unsafe-inline' — keeping both would let the browser fall
    // back to unsafe-inline (CSP3 ignores nonces when unsafe-inline is present in
    // a directive that a non-nonce-aware browser parses). So nonce ⇒ no unsafe.
    styleSrc.push(`'nonce-${opts.styleNonce}'`);
  } else if (opts.allowStyleUnsafeInline ?? true) {
    // Preserve the legacy default unless the caller explicitly opts out.
    styleSrc.push('\'unsafe-inline\'');
  }

  return `default-src 'self'; script-src ${scriptSrc.join(' ')}; style-src ${styleSrc.join(' ')}`;
}

/**
 * Apply security headers to response.
 * Call this before any res.writeHead() or res.end().
 *
 * When `opts.cspNonce` (style or script) is provided, the per-response CSP is
 * rebuilt with that nonce (dropping `'unsafe-inline'` for the directive that got
 * a nonce) instead of the static `'unsafe-inline'` default.
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
