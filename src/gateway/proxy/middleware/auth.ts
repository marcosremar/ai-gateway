/**
 * Bearer token auth middleware.
 * Uses timing-safe comparison to prevent timing attacks.
 */

import { timingSafeEqual } from 'crypto';
import { createLogger } from '../../../logger';

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

/**
 * Validate a Bearer token against the configured API keys using a timing-safe comparison.
 *
 * Uses `crypto.timingSafeEqual` to prevent timing attacks that could leak
 * partial key information. When `validKeys` is empty, auth is disabled
 * (open mode) and all requests are allowed through.
 *
 * @param authHeader - The `Authorization` header value from the incoming request (e.g. "Bearer abc123")
 * @param validKeys - Array of valid API keys to check against
 * @returns `true` if the token matches any key, or if no keys are configured (open mode)
 *
 * @example
 * ```typescript
 * const isValid = validateAuth(req.headers.authorization, config.apiKeys);
 * if (!isValid) {
 *   res.writeHead(401);
 *   res.end('Unauthorized');
 * }
 * ```
 */
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
