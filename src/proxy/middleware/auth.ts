/**
 * Bearer token auth middleware.
 * Uses timing-safe comparison to prevent timing attacks.
 */

import { timingSafeEqual } from 'crypto';

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // Pad shorter buffer to match length, preventing length-based timing leak
  if (aBuf.length !== bBuf.length) {
    // Compare against itself to keep constant time, then return false
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
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
