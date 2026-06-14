/**
 * Universal authentication middleware for all endpoints.
 *
 * Fixes: #351-385 (missing auth on endpoints)
 *
 * Usage:
 * ```ts
 * import { requireAuth, requireRole } from './auth-middleware';
 *
 * // In any handler:
 * const auth = requireAuth(req);
 * if (!auth.ok) return sendError(res, 401, auth.error);
 *
 * // Role-based:
 * const auth = requireRole(req, 'admin');
 * if (!auth.ok) return sendError(res, 403, 'Insufficient permissions');
 * ```
 */

import { IncomingMessage, ServerResponse } from 'http';

export interface AuthResult {
  ok: boolean;
  apiKey?: string;
  role?: string;
  error?: string;
  statusCode?: number;
}

export interface AuthConfig {
  /** Valid API keys (or function to validate) */
  validKeys: Set<string> | ((key: string) => boolean);
  /** API key header name (default: 'Authorization') */
  headerName?: string;
  /** API key query param name (fallback) */
  queryParamName?: string;
  /** Bearer token prefix (default: 'Bearer ') */
  bearerPrefix?: string;
  /** Allow missing auth in development mode */
  allowDevBypass?: boolean;
}

/**
 * Extract API key from request (header or query param).
 */
function extractApiKey(req: IncomingMessage, config: AuthConfig): string | null {
  const headerName = config.headerName ?? 'Authorization';

  // Try header
  const authHeader = req.headers[headerName.toLowerCase()] as string | undefined;
  if (authHeader) {
    const prefix = config.bearerPrefix ?? 'Bearer ';
    if (authHeader.startsWith(prefix)) {
      return authHeader.slice(prefix.length);
    }
    // Reject non-Bearer auth schemes when a prefix is required. Previously
    // any malformed `Authorization: ...` was returned verbatim as the key,
    // accepting `Authorization: Basic xyz` or arbitrary values matching a
    // configured key. Only fall through to query param.
  }

  // Try query param
  if (config.queryParamName && req.url) {
    const url = new URL(req.url, 'http://localhost');
    const key = url.searchParams.get(config.queryParamName);
    if (key) return key;
  }

  return null;
}

/**
 * Validate an API key against the configured valid keys.
 */
function validateApiKey(key: string, config: AuthConfig): boolean {
  if (typeof config.validKeys === 'function') {
    return config.validKeys(key);
  }
  return config.validKeys.has(key);
}

/**
 * Require authentication on any endpoint.
 *
 * @example
 * ```ts
 * const auth = requireAuth(req, { validKeys: apiKeys });
 * if (!auth.ok) {
 *   res.writeHead(auth.statusCode ?? 401);
 *   return res.end(JSON.stringify({ error: auth.error }));
 * }
 * ```
 */
export function requireAuth(
  req: IncomingMessage,
  config: AuthConfig,
): AuthResult {
  // Dev bypass (optional)
  if (config.allowDevBypass && process.env.NODE_ENV === 'development') {
    return { ok: true, apiKey: 'dev-bypass', role: 'dev' };
  }

  const apiKey = extractApiKey(req, config);
  if (!apiKey) {
    return {
      ok: false,
      error: 'Authentication required. Provide API key via Authorization header or query param.',
      statusCode: 401,
    };
  }

  if (!validateApiKey(apiKey, config)) {
    return {
      ok: false,
      error: 'Invalid API key',
      statusCode: 403,
    };
  }

  return { ok: true, apiKey };
}

/**
 * Role-based access control check.
 */
export function requireRole(
  req: IncomingMessage,
  role: string,
  config: AuthConfig & { roleMap?: Map<string, string> },
): AuthResult {
  const auth = requireAuth(req, config);
  if (!auth.ok) return auth;

  const userRole = config.roleMap?.get(auth.apiKey!) ?? 'user';
  const roleHierarchy: Record<string, number> = {
    admin: 3,
    operator: 2,
    user: 1,
    readonly: 0,
  };

  const userLevel = roleHierarchy[userRole] ?? 0;
  const requiredLevel = roleHierarchy[role];

  // If the required role is not recognized, deny access rather than
  // defaulting to level 0 (which would grant any authenticated user access).
  if (requiredLevel === undefined || userLevel < requiredLevel) {
    return {
      ok: false,
      error: `Insufficient permissions. Required: ${role}, your role: ${userRole}`,
      statusCode: 403,
    };
  }

  return { ...auth, role: userRole };
}

/**
 * Send auth error response.
 */
export function sendAuthError(res: ServerResponse, result: AuthResult): void {
  res.writeHead(result.statusCode ?? 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: result.error,
    code: result.statusCode === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
  }));
}

/**
 * Require and validate auth in one call. Throws on failure.
 */
export function useAuth(req: IncomingMessage, config: AuthConfig): { apiKey: string } {
  const result = requireAuth(req, config);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return { apiKey: result.apiKey! };
}
