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
import { createHash } from 'crypto';

const cache = new Map<string, OpenAI>();
const MAX_CACHE_SIZE = 50;

/**
 * Get or create a shared OpenAI SDK client for the given config.
 * Clients are cached by `baseURL + apiKeyHash` (+ defaultHeaders hash).
 * API key is hashed to avoid storing plaintext secrets in memory maps.
 */
export function getOrCreateClient(
  baseURL: string,
  apiKey: string,
  defaultHeaders?: Record<string, string>,
): OpenAI {
  // Include headers in cache key so providers with different headers get their own client
  const headersKey = defaultHeaders ? JSON.stringify(defaultHeaders) : '';
  const keyHash = apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : '';
  const key = `${baseURL}\0${keyHash}\0${headersKey}`;

  const existing = cache.get(key);
  if (existing) return existing;

  const client = new OpenAI({
    apiKey,
    baseURL,
    ...(defaultHeaders && { defaultHeaders }),
  });
  // Evict oldest entry if cache is full (FIFO)
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
      // Note: OpenAI SDK client connections will be GC'd with the client
    }
  }
  cache.set(key, client);
  return client;
}
