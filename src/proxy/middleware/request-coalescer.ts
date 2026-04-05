/**
 * Request coalescer: deduplicates identical in-flight requests.
 *
 * If two identical requests arrive within milliseconds, only one hits the
 * upstream provider. The second waits for the first's result.
 *
 * Uses a SHA-256 hash of the request body as the dedup key.
 */

import { createHash } from 'crypto';

export class RequestCoalescer {
  private inflight = new Map<string, Promise<unknown>>();

  /** Build a coalescing key from request params. Returns null if not coalescable. */
  buildKey(params: { provider: string; model: string; messages: unknown[]; temperature?: number }): string | null {
    // Only coalesce deterministic requests (temperature 0 or undefined)
    if (params.temperature !== undefined && params.temperature !== 0) return null;

    const raw = JSON.stringify({
      p: params.provider,
      m: params.model,
      msg: params.messages,
      t: params.temperature,
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
      return existing as Promise<T>;
    }

    const promise = fn().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Number of in-flight coalesced requests (for monitoring) */
  get size(): number {
    return this.inflight.size;
  }
}
