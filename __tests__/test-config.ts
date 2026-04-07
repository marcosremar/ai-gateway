/**
 * Centralized Test Configuration
 *
 * ALL test URLs, feature flags, and environment detection in one place.
 * No hardcoded URLs in test files — import from here.
 *
 * Usage:
 *   import { TEST, FEATURES, ENDPOINTS } from './test-config';
 *
 *   describe.skipIf(!FEATURES.modalTts)('Modal TTS', () => { ... });
 *   const res = await fetch(ENDPOINTS.gateway + '/health');
 */

// ── Load .env before anything ───────────────────────────────────────────────

try { require('dotenv').config(); } catch {}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS — all resolved from env vars, never hardcoded
// ═══════════════════════════════════════════════════════════════════════════════

export const ENDPOINTS = {
  /** AI Gateway HTTP API */
  gateway: process.env.GATEWAY_URL || 'http://localhost:4000',

  /** Gateway API key (for authenticated endpoints) */
  gatewayApiKey: process.env.GATEWAY_API_KEY || '',

  /** GPU pod endpoint (set after deploy, or from SUBTITLE_ENDPOINT) */
  gpuPod: process.env.GPU_POD_ENDPOINT || process.env.SUBTITLE_ENDPOINT || '',

  /** Ollama local endpoint */
  ollama: process.env.OLLAMA_HOST || 'http://localhost:11434',

  /** Modal TTS endpoint (resolved from provider, not hardcoded) */
  modalTts: process.env.MODAL_TTS_URL || '',

  /** Modal MOSS TTS endpoint */
  modalMossTts: process.env.MOSS_TTS_URL || '',

  /** Database URL */
  database: process.env.DATABASE_URL || '',

  /** Cluster host (for SSH-based tests) */
  clusterHost: process.env.CLUSTER_HOST || '',

  /** Backend WebSocket server */
  backendWs: process.env.BACKEND_WS_URL || 'ws://localhost:8765',

  /** Backend WebRTC server */
  backendWebrtc: process.env.BACKEND_WEBRTC_URL || 'http://localhost:8766',
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// API KEYS — check presence without exposing values
// ═══════════════════════════════════════════════════════════════════════════════

export const API_KEYS = {
  groq: !!process.env.GROQ_API_KEY,
  openai: !!process.env.OPENAI_API_KEY,
  fireworks: !!process.env.FIREWORKS_API_KEY,
  deepgram: !!process.env.DEEPGRAM_API_KEY,
  elevenlabs: !!process.env.ELEVENLABS_API_KEY,
  openrouter: !!process.env.OPENROUTER_API_KEY,
  runpod: !!process.env.RUNPOD_API_KEY,
  vast: !!process.env.VAST_API_KEY,
  tensordock: !!process.env.TENSORDOCK_API_KEY,
  modal: !!process.env.MODAL_TOKEN_ID,
  neon: !!process.env.NEON_API_KEY,
  dockerhub: !!process.env.DOCKERHUB_USERNAME,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE FLAGS — async detection for services
// ═══════════════════════════════════════════════════════════════════════════════

/** Detect if a service is reachable (with timeout) */
async function isReachable(url: string, timeoutMs = 10_000): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/** Pre-resolved feature flags. Call `await initFeatures()` before using. */
export const FEATURES = {
  /** Gateway running and healthy */
  gateway: false,

  /** Ollama running with llama3.2 */
  ollama: false,

  /** Modal TTS endpoint reachable */
  modalTts: false,

  /** PostgreSQL database available */
  database: false,

  /** GPU pod deployed and healthy */
  gpuPod: false,

  /** Backend WS/WebRTC servers running */
  backendServers: false,

  /** At least 2 STT providers for ensemble tests */
  ensembleStt: false,

  /** Skip GPU tests flag */
  skipGpu: process.env.SKIP_GPU_TESTS === '1',

  /** Skip live tests flag */
  skipLive: process.env.SKIP_LIVE_TESTS === '1',

  /** gTTS Python package available */
  gtts: false,
};

/** Initialize feature detection (call once in setup or at top of test file) */
export async function initFeatures(): Promise<typeof FEATURES> {
  const checks = await Promise.allSettled([
    // Gateway
    isReachable(ENDPOINTS.gateway + '/health').then(ok => { FEATURES.gateway = ok; }),

    // Ollama
    (async () => {
      try {
        const res = await fetch(ENDPOINTS.ollama + '/api/tags', { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) return;
        const data = await res.json() as { models?: Array<{ name: string }> };
        FEATURES.ollama = !!data.models?.some(m => m.name.includes('llama3.2'));
      } catch {}
    })(),

    // Modal TTS
    (async () => {
      // Try to resolve URL from provider if not in env
      if (!ENDPOINTS.modalTts) {
        try {
          const { ModalTTSProvider } = await import('../src/providers/modal');
          const tts = new ModalTTSProvider();
          (ENDPOINTS as any).modalTts = (tts as any).endpoint || '';
        } catch {}
      }
      if (ENDPOINTS.modalTts) {
        FEATURES.modalTts = await isReachable(ENDPOINTS.modalTts + '/health', 30_000);
      }
    })(),

    // Database
    (async () => {
      if (!ENDPOINTS.database) return;
      try {
        const { DatabaseService } = await import('../src/database');
        const db = new DatabaseService({ databaseUrl: ENDPOINTS.database, environment: 'local' });
        await db.query('SELECT 1');
        FEATURES.database = true;
        await db.close();
      } catch {}
    })(),

    // GPU Pod
    (async () => {
      if (ENDPOINTS.gpuPod) {
        FEATURES.gpuPod = await isReachable(ENDPOINTS.gpuPod + '/health', 10_000);
      }
    })(),

    // Backend servers
    (async () => {
      const { existsSync } = await import('fs');
      const { resolve } = await import('path');
      const hasFiles = existsSync(resolve(process.cwd(), 'backend/ws-server.ts'))
        && existsSync(resolve(process.cwd(), 'backend/webrtc-server.ts'));
      if (!hasFiles) return;
      // Check if servers are actually running
      FEATURES.backendServers = await isReachable(ENDPOINTS.backendWs.replace('ws://', 'http://'), 3_000);
    })(),

    // Ensemble STT (need 2+ providers)
    (() => {
      const sttProviders = [API_KEYS.groq, API_KEYS.openai, API_KEYS.deepgram, API_KEYS.fireworks]
        .filter(Boolean).length;
      FEATURES.ensembleStt = sttProviders >= 2;
      return Promise.resolve();
    })(),

    // gTTS
    (async () => {
      try {
        const { execSync } = await import('child_process');
        execSync('python3 -c "from gtts import gTTS"', { timeout: 5_000 });
        FEATURES.gtts = true;
      } catch {}
    })(),
  ]);

  return FEATURES;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS — common test utilities
// ═══════════════════════════════════════════════════════════════════════════════

/** Build auth headers for gateway requests */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(ENDPOINTS.gatewayApiKey ? { Authorization: `Bearer ${ENDPOINTS.gatewayApiKey}` } : {}),
    ...extra,
  };
}

/** Fetch from gateway with auth + timeout */
export async function gwFetch<T = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
  timeoutMs = 15_000,
): Promise<T> {
  const res = await fetch(`${ENDPOINTS.gateway}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers as Record<string, string> },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json() as Promise<T>;
}

/** Placeholder endpoint for mocked tests (not real URLs) */
export const MOCK_ENDPOINTS = {
  gpuPod: 'https://gpu-pod.test:8000',
  flyApp: 'https://app.test.fly.dev',
  botEndpoint: 'https://bot.test:8080',
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY — print current config (for debugging)
// ═══════════════════════════════════════════════════════════════════════════════

export function printTestConfig(): void {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║         Test Configuration               ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║ Gateway:     ${FEATURES.gateway ? '✓' : '✗'}  ${ENDPOINTS.gateway}`);
  console.log(`║ Ollama:      ${FEATURES.ollama ? '✓' : '✗'}  ${ENDPOINTS.ollama}`);
  console.log(`║ Modal TTS:   ${FEATURES.modalTts ? '✓' : '✗'}  ${ENDPOINTS.modalTts || '(not set)'}`);
  console.log(`║ Database:    ${FEATURES.database ? '✓' : '✗'}  ${ENDPOINTS.database ? '***' : '(not set)'}`);
  console.log(`║ GPU Pod:     ${FEATURES.gpuPod ? '✓' : '✗'}  ${ENDPOINTS.gpuPod || '(not set)'}`);
  console.log(`║ Backend:     ${FEATURES.backendServers ? '✓' : '✗'}`);
  console.log(`║ Ensemble:    ${FEATURES.ensembleStt ? '✓' : '✗'}`);
  console.log(`║ gTTS:        ${FEATURES.gtts ? '✓' : '✗'}`);
  console.log('║──────────────────────────────────────────║');
  const keys = Object.entries(API_KEYS).filter(([, v]) => v).map(([k]) => k);
  console.log(`║ API Keys:    ${keys.join(', ') || '(none)'}`);
  console.log(`║ Skip GPU:    ${FEATURES.skipGpu}`);
  console.log(`║ Skip Live:   ${FEATURES.skipLive}`);
  console.log('╚══════════════════════════════════════════╝');
}
