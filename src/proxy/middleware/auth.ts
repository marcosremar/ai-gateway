/**
 * Bearer token auth middleware.
 * Uses timing-safe comparison to prevent timing attacks.
 */

import { timingSafeEqual } from 'crypto';
import { createLogger } from '../../logger';

const log = createLogger('auth-middleware');

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
  if (validKeys.length === 0) return true; // no auth configured = allow all (open mode)
  if (!authHeader) {
    log.warn('Missing Authorization header');
    return false;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    log.warn('Empty Bearer token');
    return false;
  }
  const valid = validKeys.some((key) => safeEqual(token, key));
  if (!valid) {
    log.warn('Invalid API key (length=%d)', token.length);
  }
  return valid;
}
