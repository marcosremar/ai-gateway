/**
 * Bearer token auth middleware.
 */

export function validateAuth(authHeader: string | undefined, validKeys: string[]): boolean {
  if (validKeys.length === 0) return true; // no auth required
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '');
  return validKeys.includes(token);
}
