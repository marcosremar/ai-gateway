/**
 * Shared OpenAI SDK client cache.
 *
 * Multiple OpenAI-compat providers that share the same baseURL + API key
 * (e.g. Groq STT + Groq LLM + Groq TTS) reuse a single OpenAI client
 * instance — and thus a single HTTP/2 connection pool. This halves (or
 * thirds) TCP/TLS handshake overhead on first request after cold start.
 */

import OpenAI from 'openai';

const cache = new Map<string, OpenAI>();

/**
 * Get or create a shared OpenAI SDK client for the given config.
 * Clients are cached by `baseURL + apiKey` (+ defaultHeaders hash).
 */
export function getOrCreateClient(
  baseURL: string,
  apiKey: string,
  defaultHeaders?: Record<string, string>,
): OpenAI {
  // Include headers in cache key so providers with different headers get their own client
  const headersKey = defaultHeaders ? JSON.stringify(defaultHeaders) : '';
  const key = `${baseURL}\0${apiKey}\0${headersKey}`;

  const existing = cache.get(key);
  if (existing) return existing;

  const client = new OpenAI({
    apiKey,
    baseURL,
    ...(defaultHeaders && { defaultHeaders }),
  });
  cache.set(key, client);
  return client;
}
