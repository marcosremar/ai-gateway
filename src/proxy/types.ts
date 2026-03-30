/**
 * Proxy server types.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { GatewayHooks } from '../hooks';
import type { ResponseCache } from '../caching/response-cache';
import type { LLMProvider, STTProvider, TTSProvider } from '../providers/types';
import type { EmbeddingProvider } from '../providers/openai-compat/openai-compat-embedding';

export interface ProviderMapping {
  /** model name → LLM provider instance */
  chat?: Record<string, LLMProvider>;
  /** model name → Embedding provider instance */
  embedding?: Record<string, EmbeddingProvider>;
  /** model name → STT provider instance */
  stt?: Record<string, STTProvider>;
  /** model name → TTS provider instance */
  tts?: Record<string, TTSProvider>;
}

export interface CustomRoute {
  method: string;
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export interface ProxyConfig {
  port?: number;               // default 4000
  apiKeys?: string[];          // valid Bearer tokens
  providers: ProviderMapping;
  cache?: ResponseCache;
  hooks?: GatewayHooks;
  rateLimit?: { rpm: number };
  hostname?: string;           // default '0.0.0.0'
  customRoutes?: CustomRoute[];
  /** Directory of static files to serve (e.g. Next.js `out/` export). Falls back for non-API paths. */
  staticDir?: string;
  /** Next.js dev server URL for HMR proxy (e.g. 'http://localhost:3000'). Overrides staticDir when set. */
  nextDevUrl?: string;
  /**
   * Called after a request is successfully authenticated with a Bearer token.
   * Use this to load per-user profiles from the database and apply them to the
   * in-memory config cache (e.g. via applyUserConfig() from config-persistence).
   */
  onAuth?: (apiKey: string) => Promise<void>;
}

export interface ProxyRoute {
  method: string;
  pattern: RegExp;
  handler: (req: ProxyRequest) => Promise<ProxyResponse>;
}

export interface ProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: Buffer;
}

export interface ProxyResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  stream?: ReadableStream<Uint8Array>;
}
