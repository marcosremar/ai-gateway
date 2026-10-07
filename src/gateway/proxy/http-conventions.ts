/**
 * Wire conventions shared by every route of the proxy (API audit 2026-10-07): the error `type` a status maps to, the
 * request id a caller may send, and the CORS lists a browser client needs to call and read the gateway.
 */

import { randomUUID } from 'crypto';

/**
 * OpenAI-style error type of an HTTP status. Before, every proxy-level error said `server_error` — a 401 or a 429
 * read like a gateway bug to a client that branches on `type`.
 */
export function errorTypeForStatus(status: number): string {
  switch (status) {
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 413: return 'request_too_large';
    case 429: return 'rate_limit_error';
    default: return status >= 400 && status < 500 ? 'invalid_request_error' : 'server_error';
  }
}

/** A caller's `X-Request-Id` is echoed in headers and logs: only up to 128 chars of `[A-Za-z0-9_.-]`. */
const REQUEST_ID_RE = /^[\w.-]{1,128}$/;

/** The caller's request id when it is safe to echo, else a fresh UUID. */
export function requestIdOf(header: string | string[] | undefined): string {
  return typeof header === 'string' && REQUEST_ID_RE.test(header) ? header : randomUUID();
}

export const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
export const CORS_ALLOW_HEADERS = [
  'Content-Type', 'Authorization', 'X-API-Key', 'X-App', 'X-Request-Id', 'X-Aigw-Wait', 'X-Gateway-No-Wake',
].join(', ');
/** Response headers a browser client may read (CORS hides every non-safelisted one otherwise). */
export const CORS_EXPOSE_HEADERS = [
  'X-Gateway-Provider', 'X-Gateway-Fallback', 'X-Gateway-Fallback-From', 'X-Gateway-Model-Catalog-Warnings',
  'X-STT-Filtered', 'X-STT-Raw-Length', 'Retry-After', 'X-Request-Id',
].join(', ');
