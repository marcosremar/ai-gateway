/**
 * Provider error normalization (#371).
 *
 * REST provider clients throw errors inconsistently: some set a numeric
 * `.status` field (Minimax), others embed the code in the message string
 * (Deepgram: `Error("[deepgram] HTTP 429")`). The fallback layer's
 * `extractStatus` papers over this with a message regex, but that is fragile
 * (a 429 in the *body text* would be mis-parsed). This module gives every REST
 * provider one helper to throw an error that always carries a real `.status`,
 * so downstream classification (retry / move-on / 5xx) is reliable.
 */

/** An Error guaranteed to carry a numeric `.status` field. */
export interface ProviderError extends Error {
  /** HTTP-equivalent status code. */
  status: number;
  /** Original provider id, for logging/metrics. */
  provider?: string;
  /** Provider-specific error code (e.g. `model_not_found`), if any. */
  code?: string;
}

/** Type guard: does this value carry a usable numeric `.status`? */
export function hasStatus(err: unknown): err is { status: number } {
  return (
    !!err &&
    typeof err === 'object' &&
    typeof (err as { status?: unknown }).status === 'number'
  );
}

/**
 * Best-effort extraction of an HTTP status from an arbitrary error.
 *
 * Order of preference:
 *   1. `err.status` (already-normalized providers)
 *   2. `err.response.status` (fetch/axios-style)
 *   3. first 4xx/5xx token in `err.message` (legacy message-embedded providers)
 *
 * Returns null when nothing parseable is found.
 */
export function extractStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  if (typeof e.status === 'number') return e.status;
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp && typeof resp.status === 'number') return resp.status;
  const msg = typeof e.message === 'string' ? e.message : '';
  const match = msg.match(/\b([45]\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Build a normalized {@link ProviderError} that always carries a real numeric
 * `.status`. Use in every REST provider's non-OK branch instead of throwing a
 * bare `Error("HTTP 429")`.
 *
 * @param provider provider id (e.g. `'deepgram'`)
 * @param status   HTTP status code
 * @param message  human-readable detail (already truncated by the caller)
 * @param code     optional provider-specific error code
 */
export function makeProviderError(
  provider: string,
  status: number,
  message: string,
  code?: string,
): ProviderError {
  const err = new Error(`[${provider}] HTTP ${status}: ${message}`) as ProviderError;
  err.status = status;
  err.provider = provider;
  if (code) err.code = code;
  return err;
}

/**
 * Coerce any thrown value into a {@link ProviderError} with a numeric `.status`.
 *
 * If the error already carries a status (directly, via `.response`, or via a
 * message token) that value is preserved; otherwise `fallbackStatus` (default
 * 502 — bad upstream) is applied. The original message is kept.
 */
export function normalizeProviderError(
  provider: string,
  err: unknown,
  fallbackStatus = 502,
): ProviderError {
  const status = extractStatus(err) ?? fallbackStatus;
  const message = err instanceof Error ? err.message : String(err);
  const normalized = (err instanceof Error ? err : new Error(message)) as ProviderError;
  normalized.status = status;
  if (!normalized.provider) normalized.provider = provider;
  return normalized;
}
