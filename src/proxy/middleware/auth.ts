/**
 * Bearer token auth middleware.
 * Uses timing-safe comparison to prevent timing attacks.
 */

import { timingSafeEqual } from 'crypto';

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function validateAuth(authHeader: string | undefined, validKeys: string[]): boolean {
  if (validKeys.length === 0) return true; // no auth configured
  if (!authHeader) {
    console.warn('[auth] Missing Authorization header');
    return false;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    console.warn('[auth] Empty Bearer token');
    return false;
  }
  const valid = validKeys.some((key) => safeEqual(token, key));
  if (!valid) {
    console.warn('[auth] Invalid API key (length=%d)', token.length);
  }
  return valid;
}
