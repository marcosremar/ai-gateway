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

import { startProxy } from './src/proxy/server';
import { groqSTT, groqLLM, groqTTS } from './src/providers/groq';
import { openrouterLLM } from './src/gateway/providers/cloud/openrouter';
import { zaiLLM, ZAI_LLM_MODELS } from './src/modules/gateway/providers/cloud/zai';
import { routingImage } from './src/providers/routing-image';
import { createLogger } from './src/logger';
import type { ProviderMapping, PrefixRoute } from './src/proxy/types';
import { deploymentsFromEnv } from './src/deployments';
import { ApiKeyRegistry } from './src/gateway/proxy/middleware/api-keys';

const log = createLogger('serve');

// Workload handlers live in server/ which is NOT included in the Fly.io
// Docker image (only src/ + serve.ts are copied). Dynamic import with
// fallback so the proxy starts regardless.
let routeWorkloadRequest: ((req: any, res: any, path: string, method: string) => boolean) | null = null;
try {
  const wh = require('./server/workload-handlers');
  routeWorkloadRequest = wh.routeWorkloadRequest;
  const { workloadRegistry, GpuWorkloadDriver } = require('./src/workloads');
  workloadRegistry.registerDriver(new GpuWorkloadDriver());
  log.log({}, 'Workload registry initialized (gpu driver)');
} catch {
  log.log({}, 'Workload handlers not available (server/ not bundled) — skipping');
}

const PORT = parseInt(process.env.PORT || '4000');
const API_KEYS = process.env.GATEWAY_API_KEYS
  ? process.env.GATEWAY_API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
  : undefined;
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '0');

// Without Groq the cloud chat/STT/TTS routes answer upstream errors, but deployments (/v1/deployments) still work —
// a gateway that only serves self-hosted models does not need a Groq key.
if (!process.env.GROQ_API_KEY) {
  console.warn('[serve] GROQ_API_KEY is not set — Groq-backed /v1/chat, /v1/audio routes will fail');
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

// Deployments: Docker image → autoscaled replicas on Scaleway (enabled when SCW_SECRET_KEY is set).
const keyRegistry = new ApiKeyRegistry((API_KEYS ?? []).join(','));
const deployments = deploymentsFromEnv(process.env, {
  userOf: (req) => keyRegistry.resolve((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))?.userId ?? null,
  log: (msg, data) => log.log(data ?? {}, msg),
});
if (deployments) {
  await deployments.controller.init();
  deployments.controller.start();
  prefixRoutes.push({ prefix: '/v1/deployments', handler: deployments.handler });
  prefixRoutes.push({ prefix: '/v1/profiles', handler: deployments.handler });
  log.log({ namespace: deployments.controller.namespace }, 'Deployments enabled (scaleway)');
} else {
  log.log({}, 'Deployments disabled (no SCW_SECRET_KEY)');
}

const server = await startProxy({
  port: PORT,
  hostname: '0.0.0.0',
  apiKeys: API_KEYS,
  providers,
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
    deployments?.controller.stop();
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
