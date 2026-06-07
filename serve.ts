/**
 * Lightweight production entry point — starts the AI Gateway proxy server.
 *
 * Wires Groq providers directly to avoid the server/state.ts → Prisma dependency.
 *
 * Usage:
 *   bun run serve.ts
 *
 * Requires GROQ_API_KEY in env.
 */

import './src/env/load-project-env';
import { startProxy } from './src/proxy/server';
import { groqSTT, groqLLM, groqTTS } from './src/providers/groq';
import { openrouterLLM } from './src/gateway/providers/cloud/openrouter';
import { zaiLLM, ZAI_LLM_MODELS } from './src/modules/gateway/providers/cloud/zai';
import { routingImage } from './src/providers/routing-image';
import { fireworksEmbedding } from './src/gateway/providers/cloud/fireworks/fireworks-embedding';
import { openaiEmbedding } from './src/gateway/providers/cloud/openai/openai-embedding';
import { createLogger } from './src/logger';
import { createGatewayMcpHandler } from './src/gateway/mcp/server';
import type { ProviderMapping, PrefixRoute } from './src/proxy/types';
import { resolveBearer, X_AIGW_USER_ID } from './server/ws/api-key-resolver';

const log = createLogger('serve');
const runtimeRequire = eval('require') as typeof require;

// Server handlers are optional so the lightweight proxy can still boot when
// consumed as a library entrypoint without the reference server tree.
let routeWorkloadRequest: ((req: any, res: any, path: string, method: string) => boolean) | null = null;
try {
  const wh = runtimeRequire('./server/workload-handlers');
  routeWorkloadRequest = wh.routeWorkloadRequest;
  const { workloadRegistry, GpuWorkloadDriver } = require('./src/workloads');
  workloadRegistry.registerDriver(new GpuWorkloadDriver());
  log.log({}, 'Workload registry initialized (gpu driver)');
} catch {
  log.log({}, 'Workload handlers not available (server/ not bundled) — skipping');
}

const lightweightProxyRoutes = new Set([
  'GET /v1/models',
  'POST /v1/chat/completions',
  'POST /v1/embeddings',
  'POST /v1/audio/speech',
  'POST /v1/audio/transcriptions',
  'POST /v1/images/generate',
  'POST /v1/images/inpaint',
  'GET /v1/search',
  'POST /v1/search',
]);

let routeServerRequest: ((req: any, res: any, path: string, method: string) => boolean) | null = null;
try {
  const {
    registerAllRoutes,
    getDockerDynamicMatcher,
    getGpuDynamicMatcher,
    getAppDynamicMatcher,
  } = runtimeRequire('./server/routes');
  const handlers: Record<string, Function> = {};
  registerAllRoutes(handlers);

  const matchDockerDynamic = getDockerDynamicMatcher?.();
  const matchGpuDynamic = getGpuDynamicMatcher?.();
  const matchAppDynamic = getAppDynamicMatcher?.();

  routeServerRequest = (req: any, res: any, path: string, method: string): boolean => {
    const key = `${method} ${path}`;
    if (lightweightProxyRoutes.has(key)) return false;

    const authHeader = Array.isArray(req.headers?.authorization)
      ? req.headers.authorization[0]
      : req.headers?.authorization;
    const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : '';
    if (token && !req.headers?.[X_AIGW_USER_ID]) {
      const resolution = resolveBearer(token);
      if (resolution.ok && resolution.userId) {
        req.headers[X_AIGW_USER_ID] = resolution.userId;
      }
    }

    const invoke = (handler: Function, params: string[] = []) => {
      Promise.resolve(handler(req, res, ...params)).catch((err) => {
        log.error({ err, route: key }, 'Unhandled error in server route fallback');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    };

    if (path.startsWith('/v1/docker/') && matchDockerDynamic) {
      const match = matchDockerDynamic(method, path);
      if (match) {
        const [handler, params] = match;
        invoke(handler, params);
        return true;
      }
    }

    if (path.startsWith('/v1/gpu/') && matchGpuDynamic) {
      const match = matchGpuDynamic(method, path);
      if (match) {
        const [handler, params] = match;
        invoke(handler, params);
        return true;
      }
    }

    if (path.startsWith('/v1/apps/') && matchAppDynamic) {
      const match = matchAppDynamic(method, path);
      if (match) {
        const [handler, params] = match;
        invoke(handler, params);
        return true;
      }
    }

    const handler = handlers[key];
    if (!handler) return false;
    invoke(handler);
    return true;
  };

  log.log({ routes: Object.keys(handlers).length }, 'Server route fallback initialized');
} catch (err) {
  log.warn({ error: err instanceof Error ? err.message : String(err) }, 'Server route fallback not available');
}

const PORT = parseInt(process.env.PORT || '4000');
const API_KEYS = process.env.GATEWAY_API_KEYS
  ? process.env.GATEWAY_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : undefined;
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '0');

if (!process.env.GROQ_API_KEY) {
  console.error('[serve] GROQ_API_KEY is required');
  process.exit(1);
}

function acceptsOpenRouterPassthroughModel(model: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(model);
}

function openRouterUpstreamModel(model: string): string {
  return model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
}

async function listOpenRouterModels(): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`OpenRouter models failed: ${response.status}`);
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  return (payload.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

// Wire providers directly — no Prisma dependency
const providers: ProviderMapping = {
  stt: {
    'whisper-large-v3': groqSTT,
    'whisper-large-v3-turbo': groqSTT,
  },
  chat: {
    'llama-3.3-70b-versatile': groqLLM,
    'llama-3.1-8b-instant': groqLLM,
    'meta-llama/llama-4-scout-17b-16e-instruct': groqLLM,
    'openai/gpt-oss-120b': groqLLM,
    'openai/gpt-oss-20b': groqLLM,
    'qwen/qwen3-32b': groqLLM,
    'groq/compound': groqLLM,
    // Z.AI — GLM-4.6 / GLM-4.5V (vision) / GLM-4.5 / GLM-4.5-Air. Registered
    // dynamically from ZAI_LLM_MODELS so the model catalog is the single
    // source of truth (capability flags + pricing live there).
    ...Object.fromEntries(ZAI_LLM_MODELS.map(m => [m.id, zaiLLM])),
  },
  chatFallbackChain: [
    { providerId: 'groq', model: 'llama-3.3-70b-versatile', provider: groqLLM },
  ],
  ...(process.env.OPENROUTER_API_KEY ? {
    chatDynamicRoutes: [{
      providerId: 'openrouter',
      provider: openrouterLLM,
      acceptsModel: acceptsOpenRouterPassthroughModel,
      upstreamModel: openRouterUpstreamModel,
    }],
    dynamicModelCatalogs: [{
      providerId: 'openrouter',
      listModels: listOpenRouterModels,
    }],
  } : {}),
  tts: {
    'canopylabs/orpheus-v1-english': groqTTS,
    'canopylabs/orpheus-arabic-saudi': groqTTS,
    // Groq PlayAI TTS — multilingual (PT-BR supported), needed for Sofia/Marcos
    // dialogue in the Copacabana Unity scene.
    'playai-tts': groqTTS,
    'playai-tts-arabic': groqTTS,
  },
  // Routing image provider: dit360 → local GPU 360°, fal-ai/* → fal.ai cloud
  image: routingImage,
  ...((process.env.OPENAI_API_KEY || process.env.FIREWORKS_API_KEY) ? {
    embedding: {
      ...(process.env.OPENAI_API_KEY ? {
        'text-embedding-3-small': openaiEmbedding,
        'text-embedding-3-large': openaiEmbedding,
      } : {}),
      ...(process.env.FIREWORKS_API_KEY ? {
        'nomic-ai/nomic-embed-text-v1.5': fireworksEmbedding,
      } : {}),
    },
  } : {}),
};

log.log({ port: PORT, apiKeys: API_KEYS ? API_KEYS.length : 0, rateLimit: RATE_LIMIT_RPM || 'disabled' }, 'Starting AI Gateway');
log.log({
  groqConfigured: Boolean(process.env.GROQ_API_KEY),
  openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
  openrouterRouting: process.env.OPENROUTER_API_KEY ? 'dynamic-passthrough' : 'disabled',
  zaiConfigured: Boolean(process.env.ZAI_API_KEY),
  zaiModels: process.env.ZAI_API_KEY ? ZAI_LLM_MODELS.map(m => m.id) : [],
  tts: 'groq/orpheus',
}, 'Providers configured');

const prefixRoutes: PrefixRoute[] = [];
if (routeWorkloadRequest) {
  prefixRoutes.push({ prefix: '/v1/workloads', handler: routeWorkloadRequest });
}
if (routeServerRequest) {
  prefixRoutes.push({ prefix: '/v1', handler: routeServerRequest });
  prefixRoutes.push({ prefix: '/metrics', handler: routeServerRequest });
}

const server = await startProxy({
  port: PORT,
  hostname: '0.0.0.0',
  apiKeys: API_KEYS,
  providers,
  customRoutes: [
    {
      method: 'POST',
      path: '/mcp',
      handler: createGatewayMcpHandler({
        name: 'parle-ai-gateway',
        version: '1.0.0',
        providers,
      }),
    },
  ],
  ...(prefixRoutes.length > 0 ? { prefixRoutes } : {}),
  ...(RATE_LIMIT_RPM > 0 ? { rateLimit: { rpm: RATE_LIMIT_RPM } } : {}),
});

// ── Process-level error handlers ─────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[serve] Uncaught exception — exiting:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[serve] Unhandled rejection:', reason);
});

// ── Graceful shutdown with request draining ──────────────────────────────────

let shuttingDown = false;
let activeRequests = 0;

// Track in-flight requests for graceful drain
server.on('request', (_req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
  activeRequests++;
  res.on('finish', () => { activeRequests--; });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[serve] Received ${signal}, draining ${activeRequests} active request(s)...`);

    // Stop accepting new connections
    server.close(() => {
      console.log('[serve] All connections drained. Exiting.');
      process.exit(0);
    });

    // Poll active requests — exit early if all drained
    const drainCheck = setInterval(() => {
      if (activeRequests <= 0) {
        clearInterval(drainCheck);
        console.log('[serve] All requests completed. Exiting.');
        process.exit(0);
      }
      console.log(`[serve] Waiting for ${activeRequests} request(s) to complete...`);
    }, 1000);

    // Force exit after 25s (before Fly's 30s kill_timeout)
    setTimeout(() => {
      clearInterval(drainCheck);
      console.error(`[serve] Drain timeout — forcing exit (${activeRequests} requests abandoned)`);
      process.exit(1);
    }, 25_000).unref();
  });
}
