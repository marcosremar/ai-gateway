/**
 * Proxy server types.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { GatewayHooks } from '../hooks';
import type { ResponseCache } from '../caching/response-cache';
import type { LLMProvider, STTProvider, TTSProvider, ImageProvider } from '../providers/types';
import type { EmbeddingProvider } from '../providers/openai-compat/openai-compat-embedding';

/**
 * A single entry in the LLM provider fallback chain.
 *
 * When the primary provider fails, the proxy walks through this chain
 * in order to find a working provider.
 */
export interface ChatFallbackEntry {
  /** Provider identifier (e.g. "groq", "fireworks") */
  providerId: string;
  /** Model to use with this provider */
  model: string;
  /** The provider instance */
  provider: LLMProvider;
}

/**
 * Mapping of model names to provider instances for all supported modalities.
 *
 * The proxy uses this to route requests to the correct provider based on
 * the requested model and modality (chat, embedding, STT, TTS, image).
 */
export interface ProviderMapping {
  /** model name -> LLM provider instance */
  chat?: Record<string, LLMProvider>;
  /** Ordered fallback chain for LLM chat (Groq -> Fireworks -> Ollama) */
  chatFallbackChain?: ChatFallbackEntry[];
  /** model name -> Embedding provider instance */
  embedding?: Record<string, EmbeddingProvider>;
  /** model name -> STT provider instance */
  stt?: Record<string, STTProvider>;
  /** model name -> TTS provider instance */
  tts?: Record<string, TTSProvider>;
  /** Image generation + inpainting provider (used by POST /v1/images/generate and /v1/images/inpaint) */
  image?: ImageProvider;
}

/**
 * A custom route handler for a specific HTTP method and exact path.
 *
 * Custom routes are matched before the default OpenAI-compatible API routes,
 * allowing the host app to add its own endpoints.
 */
export interface CustomRoute {
  /** HTTP method (e.g. "GET", "POST") */
  method: string;
  /** Exact URL path to match (e.g. "/api/health") */
  path: string;
  /** Request handler function */
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

/**
 * A route that matches any request whose path starts with `prefix`.
 *
 * Prefix routes are useful for mounting sub-applications (e.g., serving
 * all paths under `/app/*` to a static directory).
 */
export interface PrefixRoute {
  /** URL path prefix to match (e.g., "/app" matches "/app", "/app/dashboard", etc.) */
  prefix: string;
  /** Handler called for matching requests. Return `true` if the request was handled. */
  handler: (req: IncomingMessage, res: ServerResponse, pathname: string, method: string) => boolean;
}

/**
 * Configuration for the proxy HTTP server.
 *
 * Passed to `startProxy()` to bootstrap the gateway with providers,
 * rate limiting, API keys, and optional hooks.
 */
export interface ProxyConfig {
  /** Port to listen on (default: 4000) */
  port?: number;
  /** Valid Bearer tokens for API authentication. Empty or absent = open mode. */
  apiKeys?: string[];
  /** Provider instances for all modalities */
  providers: ProviderMapping;
  /** Response cache for caching LLM/STT responses */
  cache?: ResponseCache;
  /** Lifecycle hooks for proxy events (auth, errors, etc.) */
  hooks?: GatewayHooks;
  /** Token bucket rate limiter config (requests per minute) */
  rateLimit?: { rpm: number };
  /** Hostname to bind to (default: "0.0.0.0") */
  hostname?: string;
  /** Custom exact-path route handlers */
  customRoutes?: CustomRoute[];
  /** Custom prefix-based route handlers */
  prefixRoutes?: PrefixRoute[];
  /** Directory of static files to serve (e.g. Next.js `out/` export). Falls back for non-API paths. */
  staticDir?: string;
  /** Next.js dev server URL for HMR proxy (e.g. "http://localhost:3000"). Overrides staticDir when set. */
  nextDevUrl?: string;
  /**
   * Called after a request is successfully authenticated with a Bearer token.
   * Use this to load per-user profiles from the database and apply them to the
   * in-memory config cache (e.g. via applyUserConfig() from config-persistence).
   */
  onAuth?: (apiKey: string) => Promise<void>;
}

/**
 * Internal route definition matching a regex pattern.
 *
 * Used by the proxy's router to dispatch requests to the correct handler
 * based on HTTP method and URL pattern.
 */
export interface ProxyRoute {
  /** HTTP method (e.g. "GET", "POST") */
  method: string;
  /** URL pattern to match against the request path */
  pattern: RegExp;
  /** Handler called for matching requests */
  handler: (req: ProxyRequest) => Promise<ProxyResponse>;
}

/**
 * Normalized HTTP request as seen by the proxy's internal router.
 *
 * The raw HTTP request is parsed into this shape so that route handlers
 * work with a consistent interface regardless of the underlying transport.
 */
export interface ProxyRequest {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Full request URL including query string */
  url: string;
  /** Lowercased request headers as key-value pairs */
  headers: Record<string, string>;
  /** Parsed JSON body (or raw value) */
  body: unknown;
  /** Raw request body buffer */
  rawBody: Buffer;
}

/**
 * Response shape returned by a proxy route handler.
 *
 * Supports both standard responses (status + body) and streaming responses
 * via `ReadableStream`.
 */
export interface ProxyResponse {
  /** HTTP status code (e.g. 200, 400, 500) */
  status: number;
  /** Response headers to set (e.g. Content-Type) */
  headers?: Record<string, string>;
  /** Response body (serializable value or string) */
  body: unknown;
  /** Stream for chunked responses (e.g. SSE or streaming transcription) */
  stream?: ReadableStream<Uint8Array>;
}
