/**
 * Shared OpenAI SDK client cache.
 *
 * Multiple OpenAI-compat providers that share the same baseURL + API key
 * (e.g. Groq STT + Groq LLM + Groq TTS) reuse a single OpenAI client
 * instance — and thus the same HTTP connection pool. This halves (or
 * thirds) TCP/TLS handshake overhead on first request after cold start.
 *
 * Since OpenAI SDK v5.x the transport moved to global fetch (undici under
 * the hood in Node 18+) which manages connection pooling automatically.
 * The SDK no longer accepts `httpAgent`/`httpsAgent` in ClientOptions; for
 * custom pool sizing, use `fetchOptions: { dispatcher: new undici.Agent(...) }`.
 */

import OpenAI from 'openai';

/**
 * The OpenAI SDK retries 408/409/429/5xx and connection errors twice by default, sleeping `retry-after` (≤ 60 s) on a
 * 429. Under the gateway that multiplied every failure (fault bench 2026-10-06: 17 upstream calls for one request when
 * every provider answered 503; a 429 `retry-after: 5` held the request on the same provider until the 8 s stage budget
 * ran out, the next provider never tried). Retries, fallback and hedging belong to `runTargets`: the SDK makes one call.
 */
export const GATEWAY_SDK_MAX_RETRIES = 0;

interface CacheEntry {
  client: OpenAI;
  lastAccess: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 50;
const CLEANUP_INTERVAL_MS = 60_000;
const MAX_ENTRY_AGE_MS = 30 * 60 * 1000; // 30 minutes

let lastCleanup = 0;

/** Per-process numeric label per API key: the key never appears in the map key, and no hash is involved. */
const keyLabels = new Map<string, number>();
function keyLabel(apiKey: string): number {
  let id = keyLabels.get(apiKey);
  if (id === undefined) { id = keyLabels.size + 1; keyLabels.set(apiKey, id); }
  return id;
}

/**
 * Get or create a shared OpenAI SDK client for the given config.
 * Clients are cached by `baseURL + apiKeyHash` (+ defaultHeaders hash).
 * The API key never appears in the map key: each distinct key gets a per-process numeric label (`keyLabel`).
 */
export function getOrCreateClient(
  baseURL: string,
  apiKey: string,
  defaultHeaders?: Record<string, string>,
): OpenAI {
  const headersKey = defaultHeaders !== undefined
    ? JSON.stringify(defaultHeaders)
    : '\0';
  const keyHash = apiKey ? String(keyLabel(apiKey)) : '';
  const key = `${baseURL}\0${keyHash}\0${headersKey}`;

  const now = Date.now();

  if (lastCleanup + CLEANUP_INTERVAL_MS < now) {
    lastCleanup = now;
    for (const [k, entry] of cache) {
      if (now - entry.lastAccess > MAX_ENTRY_AGE_MS) {
        cache.delete(k);
      }
    }
  }

  const existing = cache.get(key);
  if (existing) {
    existing.lastAccess = now;
    return existing.client;
  }

  const client = new OpenAI({
    apiKey,
    baseURL,
    maxRetries: GATEWAY_SDK_MAX_RETRIES,
    ...(defaultHeaders && Object.keys(defaultHeaders).length > 0 && { defaultHeaders }),
  });

  if (cache.size >= MAX_CACHE_SIZE) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, entry] of cache) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }

  cache.set(key, { client, lastAccess: now });
  return client;
}

/** Expose cache size for monitoring */
export function getCacheStats(): { size: number; keys: string[] } {
  return {
    size: cache.size,
    keys: [...cache.keys()],
  };
}

/** Clear the entire client cache */
export function clearClientCache(): void {
  cache.clear();
}
