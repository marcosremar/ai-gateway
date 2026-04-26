/**
 * API versioning support for AI Gateway.
 *
 * Supports versioned endpoints via URL path or Accept header.
 *
 * @example
 * ```ts
 * // URL path versioning
 * GET /v1/chat/completions   → version 1
 * GET /v2/chat/completions   → version 2
 *
 * // Accept header versioning
 * GET /chat/completions
 * Accept: application/vnd.ai-gateway.v2+json
 * ```
 */

import type { IncomingMessage } from 'http';

export interface ApiVersion {
  major: number;
  minor: number;
  deprecated: boolean;
  sunset?: string; // ISO date
}

/** Supported API versions */
export const API_VERSIONS: Record<string, ApiVersion> = {
  v1: { major: 1, minor: 0, deprecated: false },
  v2: { major: 2, minor: 0, deprecated: false },
};

/**
 * Extract API version from request.
 *
 * Checks:
 * 1. URL path prefix (/v1/, /v2/)
 * 2. Accept header (application/vnd.ai-gateway.v2+json)
 * 3. X-API-Version header
 * 4. Falls back to v1
 */
export function extractVersion(req: IncomingMessage): ApiVersion {
  // 1. URL path
  const path = req.url ?? '';
  const pathMatch = path.match(/^\/v(\d+)\//);
  if (pathMatch) {
    const versionKey = `v${pathMatch[1]}`;
    if (API_VERSIONS[versionKey]) {
      return API_VERSIONS[versionKey];
    }
  }

  // 2. Accept header
  const accept = req.headers.accept ?? '';
  const acceptMatch = accept.match(/application\/vnd\.ai-gateway\.v(\d+)\+json/);
  if (acceptMatch) {
    const versionKey = `v${acceptMatch[1]}`;
    if (API_VERSIONS[versionKey]) {
      return API_VERSIONS[versionKey];
    }
  }

  // 3. X-API-Version header
  const versionHeader = req.headers['x-api-version'];
  if (versionHeader) {
    const versionKey = `v${versionHeader}`;
    if (API_VERSIONS[versionKey]) {
      return API_VERSIONS[versionKey];
    }
  }

  // 4. Default to v1
  return API_VERSIONS.v1;
}

/**
 * Add version headers to response.
 */
export function getVersionHeaders(version: ApiVersion): Record<string, string> {
  const headers: Record<string, string> = {
    'X-API-Version': `${version.major}.${version.minor}`,
  };
  if (version.deprecated) {
    headers.Deprecation = 'true';
    headers.Link = `<https://docs.ai-gateway.dev/migrations/v${version.major}-to-v${version.major + 1}>; rel="deprecation"`;
    // Only emit Sunset when we actually have a date — RFC 8594 requires
    // an HTTP-date value, and empty Sunset headers either crash setHeader
    // (Bun) or confuse clients.
    if (version.sunset) headers.Sunset = version.sunset;
  }
  return headers;
}

/**
 * Check if request is using a deprecated API version.
 */
export function isDeprecatedVersion(req: IncomingMessage): boolean {
  const version = extractVersion(req);
  return version.deprecated;
}

/**
 * Middleware that adds version info to request.
 */
export function versionMiddleware(req: IncomingMessage, next: () => void): void {
  const version = extractVersion(req);
  (req as unknown as Record<string, unknown>)['apiVersion'] = version;
  next();
}
