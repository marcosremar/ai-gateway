/**
 * Proxy server types.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { GatewayHooks } from '../../hooks';
import type { ResponseCache } from '../../caching/response-cache';
import type { LLMProvider, STTProvider, TTSProvider, ImageProvider } from '../providers/cloud/types';
import type { EmbeddingProvider } from '../providers/cloud/openai-compat/openai-compat-embedding';
import type { GuardrailEngine } from '../guardrails';
import type { RouteTarget, StageRoutes } from './provider-routing';

export type { RouteTarget, StageRoutes } from './provider-routing';

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
 * Dynamic LLM route for providers with remote model catalogs.
 *
 * Use this for aggregators such as OpenRouter: local models stay explicit in
 * `chat`, while unknown remote model IDs can be forwarded without maintaining
 * a gateway-side allowlist.
 */
export interface ChatDynamicRoute {
  /** Provider identifier (e.g. "openrouter") */
  providerId: string;
  /** The provider instance */
  provider: LLMProvider;
  /** Returns true when this provider should receive the requested model. */
  acceptsModel: (model: string) => boolean;
  /** Optional mapping from gateway model alias to upstream provider model. */
  upstreamModel?: (model: string) => string;
  /** Set when the provider cannot be used (e.g. key rejected): matching models answer 503 with this reason. */
  unavailableReason?: string;
}

export interface DynamicModelCatalog {
  /** Provider identifier used as `owned_by` in `/v1/models`. */
  providerId: string;
  /** Lists remote model IDs. Failures should be handled by the caller. */
  listModels: () => Promise<string[]>;
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
  /** Dynamic LLM routes for aggregator providers such as OpenRouter. */
  chatDynamicRoutes?: ChatDynamicRoute[];
  /** Dynamic model catalogs merged into GET /v1/models. */
  dynamicModelCatalogs?: DynamicModelCatalog[];
  /** model name -> Embedding provider instance */
  embedding?: Record<string, EmbeddingProvider>;
  /**
   * model name -> ordered providers for that model (first = primary, rest = fallback on 401/402/403/429/5xx/
   * timeout). Takes precedence over `chat` for the same model.
   */
  chatRoutes?: Record<string, Array<RouteTarget<LLMProvider>>>;
  /** model name -> STT provider instance, or an ordered fallback list */
  stt?: StageRoutes<STTProvider>;
  /** model name -> TTS provider instance, or an ordered fallback list */
  tts?: StageRoutes<TTSProvider>;
  /**
   * Chain entries that could not be mounted, per model, with the reasons (e.g. "groq: GROQ_API_KEY is not set").
   * A model whose whole chain is here has no provider: not listed in /v1/models, requests get 503
   * provider_unavailable. For a partly mounted chain the reasons are appended to its 503 when the rest fails.
   */
  unavailable?: Partial<Record<'chat' | 'stt' | 'tts', Record<string, string[]>>>;
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
  /**
   * Rule-based guardrail engine for validating requests and responses.
   * Runs beforeRequest and afterResponse hooks on /v1/chat/completions.
   */
  guardrails?: GuardrailEngine;
  /**
   * Per-app limits on inference requests (`app-limits.ts`): a non-admin key may call only its app's aliases, with
   * `max_tokens` clamped and a daily budget. Checked after auth and body parsing, before the route. Absent = none.
   */
  appLimits?: {
    check(userId: string, kind: import('./app-limits').InferenceKind, body: Record<string, unknown>): import('./app-limits').AppLimitDenial | null;
  };
  /**
   * `GET /health?deep=1`: per-provider probes + deployments. Plain `GET /health` stays a cheap unauthenticated
   * liveness check; the deep one needs a Bearer that `authorize` accepts (401 otherwise, 404 when not set).
   */
  deepHealth?: {
    authorize: (bearerToken: string) => boolean;
    report: () => Promise<{ status: number; body: unknown }>;
  };
  /**
   * Extra fields of the plain `GET /health` (unauthenticated, so never a secret): e.g. the effective chain per stage
   * and why a primary is not serving. Must be cheap (no upstream call).
   */
  healthDetails?: () => Record<string, unknown>;
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
  /** Aborted when the client goes away before the response is finished: routes pass it to the upstream calls. */
  signal?: AbortSignal;
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
