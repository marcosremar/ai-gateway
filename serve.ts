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
import { routingImage } from './src/providers/routing-image';
import { createLogger } from './src/logger';
import type { ProviderMapping, PrefixRoute } from './src/proxy/types';

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

if (!process.env.GROQ_API_KEY) {
  console.error('[serve] GROQ_API_KEY is required');
  process.exit(1);
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
    // OpenRouter — Kimi K2 family
    'moonshotai/kimi-k2': openrouterLLM,
    'moonshotai/kimi-k2-0905': openrouterLLM,
    'moonshotai/kimi-k2-thinking': openrouterLLM,
    'moonshotai/kimi-k2.5': openrouterLLM,
  },
  chatFallbackChain: [
    { providerId: 'groq', model: 'llama-3.3-70b-versatile', provider: groqLLM },
  ],
  tts: {
    'canopylabs/orpheus-v1-english': groqTTS,
    'canopylabs/orpheus-arabic-saudi': groqTTS,
  },
  // Routing image provider: dit360 → local GPU 360°, fal-ai/* → fal.ai cloud
  image: routingImage,
};

log.log({ port: PORT, apiKeys: API_KEYS ? API_KEYS.length : 0, rateLimit: RATE_LIMIT_RPM || 'disabled' }, 'Starting AI Gateway');
log.log({ groqConfigured: Boolean(process.env.GROQ_API_KEY), tts: 'groq/orpheus' }, 'Providers configured');

const prefixRoutes: PrefixRoute[] = [];
if (routeWorkloadRequest) {
  prefixRoutes.push({ prefix: '/v1/workloads', handler: routeWorkloadRequest });
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
