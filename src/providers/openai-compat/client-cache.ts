/**
 * Shared OpenAI SDK client cache.
 *
 * Multiple OpenAI-compat providers that share the same baseURL + API key
 * (e.g. Groq STT + Groq LLM + Groq TTS) reuse a single OpenAI client
 * instance — and thus a single HTTP/2 connection pool. This halves (or
 * thirds) TCP/TLS handshake overhead on first request after cold start.
 */

import OpenAI from 'openai';
import { createHash } from 'crypto';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

const cache = new Map<string, OpenAI>();
const MAX_CACHE_SIZE = 50;

/** Shared HTTP agents with tuned connection pool for high concurrency */
const sharedHttpAgent = new HttpAgent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16, timeout: 30_000 });
const sharedHttpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 16, timeout: 30_000 });

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
    httpAgent: sharedHttpAgent,
    // @ts-expect-error — OpenAI SDK accepts httpsAgent but types may lag
    httpsAgent: sharedHttpsAgent,
    ...(defaultHeaders && { defaultHeaders }),
  });
  // Evict oldest entry if cache is full (simple FIFO)
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, client);
  return client;
}
