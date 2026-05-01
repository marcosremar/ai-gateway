/**
 * Request coalescer: deduplicates identical in-flight requests.
 *
 * If two identical requests arrive within milliseconds, only one hits the
 * upstream provider. The second waits for the first's result.
 *
 * Uses a SHA-256 hash of the request body as the dedup key.
 */

import { createHash } from 'crypto';

// ─── Lightweight standalone coalescer ────────────────────────────────────────
// Simple function-based coalescer for use outside the proxy (e.g. in pipelines).
// If two identical requests (by key) arrive while the first is still in-flight,
// the second gets the same promise instead of making a duplicate API call.

const inflightRequests = new Map<string, Promise<unknown>>();

/**
 * In-flight request deduplication: if two identical requests arrive while the
 * first is still pending, return the same promise for both.
 */
export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflightRequests.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflightRequests.delete(key));
  inflightRequests.set(key, p);
  return p;
}

/** Number of in-flight coalesced requests (for monitoring) */
export function coalesceInflightCount(): number {
  return inflightRequests.size;
}

// ─── Class-based coalescer (for proxy routes) ────────────────────────────────

export class RequestCoalescer {
  private inflight = new Map<string, { promise: Promise<unknown>; timestamp: number }>();
  private static readonly STALE_MS = 30_000; // Clean up entries older than 30s

  /**
   * Build a coalescing key from request params. Returns null if not coalescable.
   *
   * The key MUST incorporate every field that influences the upstream
   * response. Two requests sharing a key will share the same in-flight
   * promise — so any field that changes the response and isn't in the
   * key causes a stale-result regression (response from req A returned
   * to req B even though B asked for different tools / format / etc).
   *
   * Fields included: provider, model, messages, temperature, tools,
   * response_format, max_tokens, top_p, seed, stop. Unknown fields are
   * intentionally NOT silently dropped — callers should plumb new
   * output-affecting params here.
   */
  buildKey(params: {
    provider: string;
    model: string;
    messages: unknown[];
    temperature?: number;
    tools?: unknown;
    response_format?: unknown;
    max_tokens?: number;
    top_p?: number;
    seed?: number;
    stop?: unknown;
  }): string | null {
    // Only coalesce deterministic requests (temperature 0 or undefined)
    if (params.temperature !== undefined && params.temperature !== 0) return null;

    const raw = JSON.stringify({
      p: params.provider,
      m: params.model,
      msg: params.messages,
      t: params.temperature,
      tools: params.tools ?? null,
      rf: params.response_format ?? null,
      mt: params.max_tokens ?? null,
      tp: params.top_p ?? null,
      sd: params.seed ?? null,
      stp: params.stop ?? null,
    });
    return createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  /**
   * Execute fn, coalescing with any identical in-flight request.
   * Returns the result from whichever call completes first for this key.
   */
  async execute<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();

    const existing = this.inflight.get(key);
    if (existing) {
      // Only coalesce if the existing promise is recent (not stale)
      if (Date.now() - existing.timestamp < RequestCoalescer.STALE_MS) {
        return existing.promise as Promise<T>;
      }
      // Stale entry — remove and create new
      this.inflight.delete(key);
    }

    const promise = fn()
      .then((result) => {
        this.inflight.delete(key);
        return result;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });

    this.inflight.set(key, { promise, timestamp: Date.now() });
    return promise as Promise<T>;
  }

  /** Number of in-flight coalesced requests (for monitoring) */
  get size(): number {
    return this.inflight.size;
  }
}
