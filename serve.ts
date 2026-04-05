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
import type { ProviderMapping } from './src/proxy/types';

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
  },
  chatFallbackChain: [
    { providerId: 'groq', model: 'llama-3.3-70b-versatile', provider: groqLLM },
  ],
};

console.log(`[serve] Starting AI Gateway on port ${PORT}`);
console.log(`[serve] API keys: ${API_KEYS ? `${API_KEYS.length} configured` : 'none (localhost only)'}`);
console.log(`[serve] Rate limit: ${RATE_LIMIT_RPM > 0 ? `${RATE_LIMIT_RPM} RPM` : 'disabled'}`);
console.log(`[serve] Groq key: ${process.env.GROQ_API_KEY.slice(0, 6)}...`);

const server = await startProxy({
  port: PORT,
  hostname: '0.0.0.0',
  apiKeys: API_KEYS,
  providers,
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

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[serve] Received ${signal}, draining connections...`);

    // Stop accepting new connections
    server.close(() => {
      console.log('[serve] All connections drained. Exiting.');
      process.exit(0);
    });

    // Force exit after 25s (before Fly's 30s kill_timeout)
    setTimeout(() => {
      console.error('[serve] Drain timeout — forcing exit');
      process.exit(1);
    }, 25_000).unref();
  });
}
