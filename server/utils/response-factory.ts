/**
 * Centralized HTTP response factory.
 *
 * Fixes: #135, #136, #152-165 (duplicated response patterns)
 *
 * Usage:
 * ```ts
 * import { sendJson, sendError, sendStream } from './response-factory';
 *
 * // Success:
 * sendJson(res, { data: result });
 *
 * // Error:
 * sendError(res, 400, 'Invalid input', 'VALIDATION_ERROR');
 *
 * // With request ID:
 * sendJson(res, { data }, { requestId: 'abc-123' });
 * ```
 */

import { ServerResponse } from 'http';

export interface ResponseOptions {
  /** Request ID for tracing */
  requestId?: string;
  /** Additional headers */
  headers?: Record<string, string>;
  /** CORS origin */
  corsOrigin?: string;
}

/**
 * Standard error response format.
 */
export interface ErrorResponse {
  error: string;
  code?: string;
  message: string;
  statusCode: number;
  requestId?: string;
}

/**
 * Standard success response format.
 */
export interface SuccessResponse<T> {
  data: T;
  requestId?: string;
  timestamp: string;
}

/**
 * Common headers applied to all responses.
 */
const COMMON_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/**
 * Send a JSON response.
 */
export function sendJson<T>(
  res: ServerResponse,
  data: T,
  options: ResponseOptions = {},
): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...COMMON_HEADERS,
    ...options.headers,
  };

  if (options.requestId) {
    headers['X-Request-Id'] = options.requestId;
  }

  if (options.corsOrigin) {
    headers['Access-Control-Allow-Origin'] = options.corsOrigin;
  }

  const body: SuccessResponse<T> = {
    data,
    requestId: options.requestId,
    timestamp: new Date().toISOString(),
  };

  res.writeHead(200, headers);
  res.end(JSON.stringify(body));
}

/**
 * Send an error response.
 *
 * @example
 * ```ts
 * sendError(res, 400, 'Invalid input', 'VALIDATION_ERROR', { requestId });
 * ```
 */
export function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  code?: string,
  options: ResponseOptions = {},
): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...COMMON_HEADERS,
    ...options.headers,
  };

  if (options.requestId) {
    headers['X-Request-Id'] = options.requestId;
  }

  const body: ErrorResponse = {
    error: code ?? 'ERROR',
    code,
    message,
    statusCode,
    requestId: options.requestId,
  };

  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
}

/**
 * Send a bad request error (400).
 */
export function sendBadRequest(
  res: ServerResponse,
  message: string,
  options?: ResponseOptions,
): void {
  sendError(res, 400, message, 'BAD_REQUEST', options);
}

/**
 * Send an unauthorized error (401).
 */
export function sendUnauthorized(
  res: ServerResponse,
  message = 'Authentication required',
  options?: ResponseOptions,
): void {
  sendError(res, 401, message, 'UNAUTHORIZED', options);
}

/**
 * Send a forbidden error (403).
 */
export function sendForbidden(
  res: ServerResponse,
  message = 'Insufficient permissions',
  options?: ResponseOptions,
): void {
  sendError(res, 403, message, 'FORBIDDEN', options);
}

/**
 * Send a not found error (404).
 */
export function sendNotFound(
  res: ServerResponse,
  resource: string,
  options?: ResponseOptions,
): void {
  sendError(res, 404, `${resource} not found`, 'NOT_FOUND', options);
}

/**
 * Send a rate limited error (429).
 */
export function sendRateLimited(
  res: ServerResponse,
  retryAfterMs?: number,
  options?: ResponseOptions,
): void {
  const headers = retryAfterMs
    ? { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) }
    : undefined;

  sendError(
    res,
    429,
    'Rate limit exceeded',
    'RATE_LIMITED',
    { ...options, headers },
  );
}

/**
 * Send an internal server error (500).
 */
export function sendInternalServerError(
  res: ServerResponse,
  message = 'Internal server error',
  options?: ResponseOptions,
): void {
  sendError(res, 500, message, 'INTERNAL_ERROR', options);
}

/**
 * Handle a request with automatic error handling.
 *
 * @example
 * ```ts
 * await handleRequest(req, res, async () => {
 *   const data = await processData(req.body);
 *   return data;
 * });
 * ```
 */
export async function handleRequest<T>(
  _req: unknown,
  res: ServerResponse,
  fn: () => Promise<T>,
  options: ResponseOptions = {},
): Promise<void> {
  try {
    const data = await fn();
    sendJson(res, data, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendInternalServerError(res, message, options);
  }
}
