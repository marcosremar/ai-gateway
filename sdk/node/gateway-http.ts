/**
 * One HTTP exchange of GatewayClient: timeout combined with the caller's signal, retry of idempotent calls on
 * connection errors, typed errors. No Node-only API (runs in Node, Bun and browsers).
 *
 * Abort semantics (explicit, tested):
 *   - the caller's own signal aborted → the call rejects with `signal.reason` (an `AbortError` DOMException by
 *     default), never retried, never a GatewayError;
 *   - the call's timeout fired → `GatewayError` code `timeout` (`unreachable: true` when no response header arrived).
 */

import type { FetchLike, Served } from './gateway-types';

export class GatewayError extends Error {
  readonly status: number;
  /** The gateway's `error.code` / `error.type` (`provider_unavailable`, `invalid_request_error`, …), else derived. */
  readonly code: string;
  readonly path: string;
  readonly served: Served | null;
  /** `Retry-After` in seconds, when sent. */
  readonly retryAfterSec: number | null;
  /**
   * The gateway itself could not be reached: connection/DNS error, timeout before the first byte, or a 502/503/504
   * that is not the gateway's own JSON error (proxy/edge failure, gateway restarting). A gateway `503
   * provider_unavailable` is NOT unreachable: the gateway is alive and already tried every provider.
   */
  readonly unreachable: boolean;
  /** `gateway` or the provider called directly (`openrouter`, `groq`). */
  readonly origin: string;
  /** Parsed error body (JSON or text). */
  readonly details: unknown;

  constructor(init: {
    message: string; status?: number; code: string; path: string; served?: Served | null; retryAfterSec?: number | null;
    unreachable?: boolean; origin?: string; details?: unknown; cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'GatewayError';
    this.status = init.status ?? 0;
    this.code = init.code;
    this.path = init.path;
    this.served = init.served ?? null;
    this.retryAfterSec = init.retryAfterSec ?? null;
    this.unreachable = init.unreachable ?? false;
    this.origin = init.origin ?? 'gateway';
    this.details = init.details;
  }
}

export function servedFrom(headers: Headers): Served {
  return {
    provider: headers.get('x-gateway-provider'),
    fallback: headers.get('x-gateway-fallback'),
    fallbackFrom: headers.get('x-gateway-fallback-from'),
  };
}

const STATUS_CODES: Record<number, string> = {
  400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed',
  409: 'conflict', 413: 'too_large', 429: 'rate_limited', 503: 'unavailable',
};

/** Reads a non-2xx response into a GatewayError (gateway shapes `{error:{message,type,code}}` and `{error:"…"}`). */
async function errorFrom(res: Response, path: string, origin = 'gateway'): Promise<GatewayError> {
  let text = '';
  try { text = await res.text(); } catch { /* body unreadable */ }
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const ownError = err !== undefined && err !== null;
  const obj = typeof err === 'object' && err ? err as { message?: unknown; code?: unknown; type?: unknown } : null;
  const message = typeof err === 'string' ? err
    : typeof obj?.message === 'string' ? obj.message
      : text.trim().slice(0, 300) || `HTTP ${res.status}`;
  const named = [obj?.code, obj?.type].find(v => typeof v === 'string' && v) as string | undefined;
  const warming = (body as { status?: unknown } | null)?.status === 'warming';
  const code = named ?? (warming ? 'warming' : STATUS_CODES[res.status] ?? `http_${res.status}`);
  const retry = Number(res.headers.get('retry-after'));
  return new GatewayError({
    message: `${origin === 'gateway' ? 'gateway' : origin} ${res.status} on ${path}: ${message}`,
    status: res.status, code, path, origin, details: body,
    served: origin === 'gateway' ? servedFrom(res.headers) : null,
    retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : null,
    // An edge/proxy failure has no gateway JSON error: the gateway itself is down or restarting.
    unreachable: origin === 'gateway' && [502, 503, 504].includes(res.status) && !ownError,
  });
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ConnectionRefused', 'ConnectionClosed', 'FailedToOpenSocket',
]);

/** fetch rejects with a TypeError on network failure (WHATWG); Node/Bun also expose a code. */
function isConnectionError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const code = (err as { code?: unknown } | null)?.code ?? ((err as { cause?: { code?: unknown } } | null)?.cause?.code);
  return typeof code === 'string' && CONNECTION_CODES.has(code);
}

/** AbortSignal.any with a fallback for older runtimes. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any.call(AbortSignal, signals);
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctl.abort(s.reason); break; }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

const RETRY_BACKOFF_MS = [200, 600];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

interface ExchangeSpec {
  fetch: FetchLike;
  url: string;
  /** For messages and errors (the path without host). */
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: BodyInit;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Retry on connection errors (idempotent calls only). */
  retries: number;
  origin?: string;
}

/**
 * Sends the request and hands a 2xx response to `read`, still under the timeout (a buffered `read` reads the body
 * there; a streaming `read` returns at once, so the timeout covers the headers only). Non-2xx → GatewayError.
 */
export async function exchange<R>(spec: ExchangeSpec, read: (res: Response) => Promise<R>): Promise<R> {
  const origin = spec.origin ?? 'gateway';
  for (let attempt = 0; ; attempt++) {
    const timer = new AbortController();
    let headersIn = false;
    const t = spec.timeoutMs > 0 ? setTimeout(() => timer.abort(new Error('timeout')), spec.timeoutMs) : null;
    const signal = spec.signal ? anySignal([spec.signal, timer.signal]) : timer.signal;
    try {
      const res = await spec.fetch(spec.url, { method: spec.method, headers: spec.headers, body: spec.body, signal });
      headersIn = true;
      if (!res.ok) throw await errorFrom(res, spec.path, origin);
      return await read(res);
    } catch (err) {
      if (spec.signal?.aborted) throw spec.signal.reason ?? err;
      if (timer.signal.aborted) {
        throw new GatewayError({
          message: `${origin} timed out after ${spec.timeoutMs} ms on ${spec.path}${headersIn ? ' (reading the body)' : ''}`,
          code: 'timeout', path: spec.path, origin, unreachable: !headersIn, cause: err,
        });
      }
      if (err instanceof GatewayError) throw err;
      if (!headersIn && isConnectionError(err)) {
        if (attempt < spec.retries) { await sleep(RETRY_BACKOFF_MS[attempt] ?? 600, spec.signal); continue; }
        throw new GatewayError({
          message: `${origin} unreachable on ${spec.path}: ${(err as Error).message ?? String(err)}`,
          code: 'network', path: spec.path, origin, unreachable: true, cause: err,
        });
      }
      throw new GatewayError({ message: `${origin} ${spec.path}: ${(err as Error)?.message ?? String(err)}`, code: 'bad_response', path: spec.path, origin, cause: err });
    } finally {
      if (t) clearTimeout(t);
    }
  }
}

/** Errors while reading a streamed body (after `exchange` returned): caller abort stays the caller's reason. */
export function streamError(err: unknown, path: string, callerSignal: AbortSignal | undefined, origin = 'gateway'): unknown {
  if (callerSignal?.aborted) return callerSignal.reason ?? err;
  if (err instanceof GatewayError) return err;
  return new GatewayError({ message: `${origin} stream broke on ${path}: ${(err as Error)?.message ?? String(err)}`, code: 'stream_error', path, origin, cause: err });
}
